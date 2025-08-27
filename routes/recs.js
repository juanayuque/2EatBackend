// routes/recs.js
const express = require("express");
const prisma = require("../src/prisma");
const verifyFirebaseToken = require("../middleware/auth");

const router = express.Router();
router.use(verifyFirebaseToken);

// Where the FastAPI LightFM service runs (pm2: 127.0.0.1:8000)
const RECS_SERVICE_URL =
  process.env.RECS_SERVICE_URL ||
  process.env.RECS_BASE ||
  "http://127.0.0.1:8000";

/* ------------------------------ utils ------------------------------ */

function toNum(x) {
  // Prisma Decimal or number → number
  if (x == null) return null;
  return typeof x === "number" ? x : Number(x);
}

function haversineKm(a, b) {
  const toRad = (x) => (x * Math.PI) / 180;
  const R = 6371;
  const lat1 = toNum(a.lat);
  const lon1 = toNum(a.lng);
  const lat2 = toNum(b.lat);
  const lon2 = toNum(b.lng);
  if ([lat1, lon1, lat2, lon2].some((v) => typeof v !== "number" || Number.isNaN(v))) {
    return Infinity;
    }
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const sLat1 = toRad(lat1);
  const sLat2 = toRad(lat2);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(sLat1) * Math.cos(sLat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function priceBandFromBudget(budgetMax) {
  if (budgetMax == null) return 0;
  if (budgetMax <= 15) return 1;
  if (budgetMax <= 30) return 2;
  if (budgetMax <= 60) return 3;
  return 4;
}

function distanceBand(km) {
  if (km <= 1) return "near";
  if (km <= 5) return "mid";
  return "far";
}

async function recsFetch(path, body, timeoutMs = 7000) {
  const url = `${RECS_SERVICE_URL}${path}`;
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`recs ${path} ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(id);
  }
}

/**
 * Ensure we have a pool of nearby restaurants in memory; if not enough, you
 * can plug your ingestion here. Currently: pull up to 300 from DB and keep
 * those within 15km.
 */
async function ensureNearbyRestaurants(lat, lng, minCount = 100) {
  const all = await prisma.restaurant.findMany({
    take: 300,
    select: {
      id: true,
      name: true,
      latitude: true,
      longitude: true,
      primaryTypeDisplayName: true,
      priceLevel: true,
      rating: true,
      userRatingCount: true,
    },
  });

  const here = { lat, lng };
  const nearby = all
    .map((r) => ({
      r,
      d: haversineKm(here, { lat: r.latitude, lng: r.longitude }),
    }))
    .filter((x) => x.d <= 15)
    .sort((a, b) => a.d - b.d)
    .map((x) => x.r);

  // TODO: if (nearby.length < minCount) call your ingestion/fetch-more routine here.
  return nearby;
}

/* ------------------------------ health/ping ------------------------------ */

router.get("/__ping", (_req, res) =>
  res.json({ ok: true, via: "routes/recs.js" })
);

router.get("/health", async (_req, res) => {
  try {
    const r = await fetch(`${RECS_SERVICE_URL}/health`, { timeout: 3000 });
    const data = await r.json();
    res.json(data);
  } catch {
    res.status(502).json({ ok: false, error: "recs-service unreachable" });
  }
});

/* ------------------------------ start session ------------------------------ */

router.post("/start", async (req, res) => {
  try {
    const uid = req.user.uid;
    const { lat, lng, minPool = 100 } = req.body || {};
    if (typeof lat !== "number" || typeof lng !== "number") {
      return res.status(400).json({ error: "lat/lng required" });
    }

    const user = await prisma.user.findUnique({ where: { firebaseUid: uid } });
    if (!user) return res.status(404).json({ error: "User not found. Sync profile first." });

    // Close any active sessions
    await prisma.swipeSession.updateMany({
      where: { userId: user.id, status: "active" },
      data: { status: "completed", endedAt: new Date() },
    });

    const session = await prisma.swipeSession.create({
      data: { userId: user.id, status: "active" },
      select: { id: true },
    });

    const pool = await ensureNearbyRestaurants(lat, lng, minPool);

    const userPrefs = {
      budgetMax: user.budgetMax ?? null,
      dietaryNeeds: user.dietaryNeeds ?? [],
      preferredCuisines: user.preferredCuisines ?? [],
      searchDistance: user.searchDistance ?? null,
    };

    const items = pool.map((r) => {
      const dist = haversineKm({ lat, lng }, { lat: r.latitude, lng: r.longitude });
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

    // Cold-start (no interactions yet)
    let rankings;
    try {
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
        interactions: [],
      };
      const ranked = await recsFetch("/rank", payload, 8000);
      rankings = Array.isArray(ranked.rankings) ? ranked.rankings : items.map((x) => x.id);
    } catch (e) {
      console.warn("recs/start fallback:", e.message);
      rankings = items.map((x) => x.id);
    }

    res.json({ sessionId: session.id, rankings: rankings.slice(0, 50) });
  } catch (e) {
    console.error("recs/start error:", e);
    res.status(500).json({ error: "start failed" });
  }
});

/* ------------------------------ get next item(s) ------------------------------ */

router.post("/next", async (req, res) => {
  try {
    const uid = req.user.uid;
    const { sessionId, lat, lng, limit = 1 } = req.body || {};
    if (!sessionId || typeof lat !== "number" || typeof lng !== "number") {
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

    const swipedIds = new Set(session.events.map((e) => e.restaurantId));
    const pool = await ensureNearbyRestaurants(lat, lng, 100);
    const candidates = pool.filter((r) => !swipedIds.has(r.id));
    if (candidates.length === 0) return res.json({ items: [] });

    const userPrefs = {
      budgetMax: user.budgetMax ?? null,
      dietaryNeeds: user.dietaryNeeds ?? [],
      preferredCuisines: user.preferredCuisines ?? [],
    };

    const items = candidates.map((r) => {
      const dist = haversineKm({ lat, lng }, { lat: r.latitude, lng: r.longitude });
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

    const interactions = session.events.map((e) => ({
      userId: user.id,
      itemId: e.restaurantId,
      action: e.action, // LIKE|PASS|SUPERSTAR
    }));

    let rankings;
    try {
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
      const ranked = await recsFetch("/rank", payload, 8000);
      rankings = Array.isArray(ranked.rankings) ? ranked.rankings : items.map((x) => x.id);
    } catch (e) {
      console.warn("recs/next fallback:", e.message);
      rankings = items.map((x) => x.id);
    }

    // Sort candidates by returned ranking order
    const pos = new Map(rankings.map((id, i) => [id, i]));
    const sorted = items
      .filter((i) => pos.has(i.id))
      .sort((a, b) => pos.get(a.id) - pos.get(b.id))
      .slice(0, Math.max(1, Number(limit)));

    // Hydrate fields for the client (incl. one photo)
    const full = await prisma.restaurant.findMany({
      where: { id: { in: sorted.map((x) => x.id) } },
      include: { photos: { take: 1 } },
    });

    // Keep the order from `sorted`
    const order = new Map(sorted.map((x, i) => [x.id, i]));
    full.sort((a, b) => order.get(a.id) - order.get(b.id));

    res.json({ items: full });
  } catch (e) {
    console.error("recs/next error:", e);
    res.status(500).json({ error: "next failed" });
  }
});

/* ------------------------------ feedback ------------------------------ */

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

/* ------------------------------ finalize + winner ------------------------------ */

router.post("/finalize-match", async (req, res) => {
  try {
    const uid = req.user.uid;
    const { sessionId, top3 = [], winnerRestaurantId, superStarRestaurantId = null } = req.body || {};
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
