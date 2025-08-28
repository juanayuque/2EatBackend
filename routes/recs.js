const express = require("express");
const prisma = require("../src/prisma");
const verifyFirebaseToken = require("../middleware/auth");

const router = express.Router();

// --- Public health checks (no auth) ---
router.get("/__ping", (_req, res) => res.json({ ok: true, via: "recs", ts: Date.now() }));
router.get("/health", (_req, res) => res.json({ ok: true }));

// Everything below here requires a Firebase ID token
router.use(verifyFirebaseToken);

const RECS_SERVICE_URL = process.env.RECS_SERVICE_URL || process.env.RECS_URL || "http://127.0.0.1:8000";

// ---------- Helpers ----------

function toNum(x) {
  const n = typeof x === "string" ? parseFloat(x) : x;
  return Number.isFinite(n) ? n : null;
}

function haversineKm(a, b) {
  const toRad = (x) => (x * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(Number(b.lat) - Number(a.lat));
  const dLon = toRad(Number(b.lng) - Number(a.lng));
  const sLat1 = toRad(Number(a.lat));
  const sLat2 = toRad(Number(b.lat));
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(sLat1) * Math.cos(sLat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function distanceBand(km) {
  if (km <= 1) return "near";
  if (km <= 5) return "mid";
  return "far";
}

function priceBandFromBudget(budgetMax) {
  if (budgetMax == null) return 0;
  if (budgetMax <= 15) return 1;
  if (budgetMax <= 30) return 2;
  if (budgetMax <= 60) return 3;
  return 4;
}

function norm(s) {
  return (s || "").toString().toLowerCase();
}

function matchesCuisine(r, preferredCuisines = []) {
  if (!preferredCuisines?.length) return true;
  const hay = `${norm(r.name)}|${norm(r.primaryTypeDisplayName)}|${norm(r.formattedAddress)}`;
  // simple contains check for keywords like "indian", "thai", etc.
  return preferredCuisines.some((c) => hay.includes(norm(c)));
}

function respectsDiet(r, dietaryNeeds = []) {
  if (!dietaryNeeds?.length) return true;
  // Very light heuristic: if user mentions vegetarian, prefer places that mark servesVegetarianFood true.
  if (dietaryNeeds.some((d) => norm(d).includes("veget"))) {
    if (r.servesVegetarianFood === true) return true;
    // allow but deprioritize — we'll handle by relaxing later if needed
    return false;
  }
  return true;
}

/** Choose the best photo URL to send to clients; prefer absolute URLs already stored in DB. */
function primaryPhotoUrlFromDb(r) {
  const p = r?.photos?.[0];
  const candidate = (p && (p.url || p.name)) || r.photoUrl || r.imageUrl;
  if (typeof candidate === "string" && /^https?:\/\//i.test(candidate)) return candidate;
  return undefined;
}

/** Build a nearby pool using prefs; relax filters if too few remain. */
async function ensureNearbyRestaurants(lat, lng, minCount, userPrefs) {
  const all = await prisma.restaurant.findMany({
    take: Math.max(300, minCount * 3),
    include: { photos: { take: 1 } },
  });

  const here = { lat, lng };
  const withDist = all
    .map((r) => ({
      r,
      d: haversineKm(here, {
        lat: Number(r.latitude),
        lng: Number(r.longitude),
      }),
    }))
    .filter((x) => Number.isFinite(x.d) && x.d <= 25) // 25km envelope
    .sort((a, b) => a.d - b.d)
    .map((x) => x.r);

  const prefs = {
    preferredCuisines: userPrefs?.preferredCuisines || [],
    dietaryNeeds: userPrefs?.dietaryNeeds || [],
    budgetMax: userPrefs?.budgetMax ?? null,
  };

  // 1) strict: cuisine + diet + (optional) price band proximity
  let pool = withDist.filter(
    (r) =>
      matchesCuisine(r, prefs.preferredCuisines) &&
      respectsDiet(r, prefs.dietaryNeeds)
  );

  // If too small, relax diet filter
  if (pool.length < Math.floor(minCount / 2)) {
    pool = withDist.filter((r) => matchesCuisine(r, prefs.preferredCuisines));
  }

  // If still small, relax cuisine filter (use distance only)
  if (pool.length < Math.floor(minCount / 3)) {
    pool = withDist;
  }

  // Cap to a reasonable maximum
  if (pool.length > minCount * 3) {
    pool = pool.slice(0, minCount * 3);
  }

  return pool;
}

// ---------- Routes ----------

// Start a swipe/recs session
router.post("/start", async (req, res) => {
  try {
    const uid = req.user.uid;
    let { lat, lng, minPool = 100 } = req.body || {};
    lat = toNum(lat);
    lng = toNum(lng);
    minPool = Number.isFinite(minPool) ? Number(minPool) : 100;

    if (lat == null || lng == null) {
      return res.status(400).json({ error: "lat/lng required" });
    }

    const user = await prisma.user.findUnique({ where: { firebaseUid: uid } });
    if (!user) return res.status(404).json({ error: "User not found. Sync profile first." });

    // Close any active session
    await prisma.swipeSession.updateMany({
      where: { userId: user.id, status: "active" },
      data: { status: "completed", endedAt: new Date() },
    });

    const session = await prisma.swipeSession.create({ data: { userId: user.id } });

    // Build the pool (preferences-applied)
    const userPrefs = {
      budgetMax: user.budgetMax ?? null,
      dietaryNeeds: user.dietaryNeeds ?? [],
      preferredCuisines: user.preferredCuisines ?? [],
    };

    // Pre-warm / sanity: not stored, but useful to 429-protect next call burst
    await ensureNearbyRestaurants(lat, lng, minPool, userPrefs);

    // Optional: cold-start “rank” call to the recs service (we ignore return)
    const payload = {
      user: {
        id: user.id,
        features: [
          `uband:${priceBandFromBudget(userPrefs.budgetMax)}`,
          ...(userPrefs.preferredCuisines || []).map((c) => `ucuisine:${c}`),
          ...(userPrefs.dietaryNeeds || []).map((d) => `udiet:${d}`),
        ],
      },
      items: [],
      interactions: [],
    };
    try {
      await fetch(`${RECS_SERVICE_URL}/rank`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).catch(() => {});
    } catch {
      // swallow — recs service is optional
    }

    res.json({ sessionId: session.id });
  } catch (e) {
    console.error("recs/start error:", e);
    res.status(500).json({ error: "start failed" });
  }
});

// Get next card(s)
router.post("/next", async (req, res) => {
  try {
    const uid = req.user.uid;
    let { sessionId, lat, lng, limit = 1 } = req.body || {};
    lat = toNum(lat);
    lng = toNum(lng);
    limit = Number.isFinite(limit) ? Math.max(1, Number(limit)) : 1;

    if (!sessionId || lat == null || lng == null) {
      return res.status(400).json({ error: "sessionId, lat, lng required" });
    }

    const user = await prisma.user.findUnique({ where: { firebaseUid: uid } });
    if (!user) return res.status(404).json({ error: "User not found" });

    const session = await prisma.swipeSession.findUnique({
      where: { id: sessionId },
      include: { events: true },
    });
    if (!session || session.userId !== user.id || session.status !== "active") {
      return res.status(400).json({ error: "Invalid session" });
    }

    const userPrefs = {
      budgetMax: user.budgetMax ?? null,
      dietaryNeeds: user.dietaryNeeds ?? [],
      preferredCuisines: user.preferredCuisines ?? [],
    };

    const swipedIds = new Set(session.events.map((e) => e.restaurantId));
    const pool = await ensureNearbyRestaurants(lat, lng, 100, userPrefs);
    const candidates = pool.filter((r) => !swipedIds.has(r.id));
    if (!candidates.length) return res.json({ items: [] });

    // Items for ranker
    const items = candidates.map((r) => {
      const dist = haversineKm({ lat, lng }, { lat: Number(r.latitude), lng: Number(r.longitude) });
      return {
        id: r.id,
        priceLevel: r.priceLevel ?? null,
        distanceKm: dist,
        features: [
          `price:${r.priceLevel ?? 0}`,
          `dist:${distanceBand(dist)}`,
          ...(r.primaryTypeDisplayName ? [`type:${r.primaryTypeDisplayName}`] : []),
        ],
      };
    });

    // Interactions from this session
    const interactions = session.events.map((e) => ({
      userId: user.id,
      itemId: e.restaurantId,
      action: e.action, // LIKE|PASS|SUPERSTAR
    }));

    const payload = {
      user: {
        id: user.id,
        features: [
          `uband:${priceBandFromBudget(userPrefs.budgetMax)}`,
          ...(userPrefs.preferredCuisines || []).map((c) => `ucuisine:${c}`),
          ...(userPrefs.dietaryNeeds || []).map((d) => `udiet:${d}`),
        ],
      },
      items,
      interactions,
    };

    let rankedIds = items.map((x) => x.id);
    try {
      const r = await fetch(`${RECS_SERVICE_URL}/rank`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (r.ok) {
        const body = await r.json().catch(() => ({}));
        if (Array.isArray(body?.rankings) && body.rankings.length) {
          rankedIds = body.rankings;
        }
      }
    } catch {
      // ignore recs service errors; fall back to distance ordering
    }

    const wantIds = rankedIds.slice(0, limit);
    const full = await prisma.restaurant.findMany({
      where: { id: { in: wantIds } },
      include: { photos: { take: 1 } },
    });

    // Preserve rank order, and normalize fields for the client
    const order = new Map(wantIds.map((id, i) => [id, i]));
    const out = full
      .slice()
      .sort((a, b) => (order.get(a.id) ?? 9999) - (order.get(b.id) ?? 9999))
      .map((r) => ({
        id: r.id,
        googlePlaceId: r.googlePlaceId,
        name: r.name,
        formattedAddress: r.formattedAddress || null,
        latitude: Number(r.latitude),
        longitude: Number(r.longitude),
        priceLevel: r.priceLevel ?? null,
        editorialSummary: r.editorialSummary || null,
        primaryTypeDisplayName: r.primaryTypeDisplayName || null,
        photoUrl: primaryPhotoUrlFromDb(r),
        photos: (r.photos || []).map((p) => ({
          id: p.id,
          name: p.name,
          url: /^https?:\/\//i.test(p.name || "") ? p.name : null,
          widthPx: p.widthPx,
          heightPx: p.heightPx,
        })),
      }));

    res.json({ items: out });
  } catch (e) {
    console.error("recs/next error:", e);
    res.status(500).json({ error: "next failed" });
  }
});

// Record feedback
router.post("/feedback", async (req, res) => {
  try {
    const uid = req.user.uid;
    const { sessionId, restaurantId, action } = req.body || {};
    if (!sessionId || !restaurantId || !["LIKE", "PASS", "SUPERSTAR"].includes(action)) {
      return res.status(400).json({ error: "sessionId, restaurantId, action required" });
    }

    const user = await prisma.user.findUnique({ where: { firebaseUid: uid } });
    if (!user) return res.status(404).json({ error: "User not found" });

    const session = await prisma.swipeSession.findUnique({
      where: { id: sessionId },
      include: { events: true },
    });
    if (!session || session.userId !== user.id || session.status !== "active") {
      return res.status(400).json({ error: "Invalid session" });
    }

    const position = session.events.length + 1;

    await prisma.$transaction(async (tx) => {
      await tx.swipeEvent.create({
        data: { sessionId, userId: user.id, restaurantId, action, position },
      });
      await tx.swipeSession.update({
        where: { id: sessionId },
        data: { totalSwipes: { increment: 1 } },
      });
      if (action === "SUPERSTAR") {
        await tx.superstar.upsert({
          where: { userId_restaurantId: { userId: user.id, restaurantId } },
          update: {},
          create: { userId: user.id, restaurantId, sessionId },
        });
      }
    });

    const shouldRerank = position % 5 === 0;
    const shouldSuggestMatch = position >= 15;
    res.json({ ok: true, shouldRerank, shouldSuggestMatch });
  } catch (e) {
    console.error("recs/feedback error:", e);
    res.status(500).json({ error: "feedback failed" });
  }
});

// Finalize a match
router.post("/finalize-match", async (req, res) => {
  try {
    const uid = req.user.uid;
    const {
      sessionId,
      top3 = [],
      winnerRestaurantId,
      superStarRestaurantId = null,
    } = req.body || {};
    if (!sessionId || !winnerRestaurantId || !Array.isArray(top3) || top3.length === 0) {
      return res.status(400).json({ error: "sessionId, winnerRestaurantId, top3 required" });
    }

    const user = await prisma.user.findUnique({ where: { firebaseUid: uid } });
    if (!user) return res.status(404).json({ error: "User not found" });

    await prisma.$transaction(async (tx) => {
      await tx.match.create({
        data: {
          userId: user.id,
          sessionId,
          top1RestaurantId: top3[0],
          top2RestaurantId: top3[1] ?? null,
          top3RestaurantId: top3[2] ?? null,
          superStarRestaurantId,
          winnerRestaurantId,
        },
      });
      await tx.swipeSession.update({
        where: { id: sessionId },
        data: { status: "completed", endedAt: new Date() },
      });
    });

    res.json({ ok: true });
  } catch (e) {
    console.error("recs/finalize-match error:", e);
    res.status(500).json({ error: "finalize failed" });
  }
});

// Get last winner
router.get("/winner", async (req, res) => {
  try {
    const uid = req.user.uid;
    const user = await prisma.user.findUnique({ where: { firebaseUid: uid } });
    if (!user) return res.status(404).json({ error: "User not found" });

    const m = await prisma.match.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
    });
    if (!m) return res.json({ winner: null });

    const r = await prisma.restaurant.findUnique({ where: { id: m.winnerRestaurantId } });
    res.json({ winner: r });
  } catch (e) {
    console.error("recs/winner error:", e);
    res.status(500).json({ error: "winner failed" });
  }
});

module.exports = router;
