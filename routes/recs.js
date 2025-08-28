// routes/recs.js
const express = require("express");
const prisma = require("../src/prisma");
const verifyFirebaseToken = require("../middleware/auth");

const router = express.Router();

// --- Public health checks (no auth) ---
router.get("/__ping", (_req, res) => res.json({ ok: true, via: "recs", ts: Date.now() }));
router.get("/health", (_req, res) => res.json({ ok: true }));

// Everything below here requires a Firebase ID token
router.use(verifyFirebaseToken);

const RECS_SERVICE_URL = process.env.RECS_SERVICE_URL || "http://127.0.0.1:8000" || process.env.RECS_URL;

// Small helpers
function haversineKm(a, b) {
  const toRad = (x) => (x * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(Number(b.lat) - Number(a.lat));
  const dLon = toRad(Number(b.lng) - Number(a.lng));
  const sLat1 = toRad(Number(a.lat));
  const sLat2 = toRad(Number(b.lat));
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(sLat1) * Math.cos(sLat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
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

async function ensureNearbyRestaurants(lat, lng, minCount = 100) {
  const all = await prisma.restaurant.findMany({ take: 300 });

  const here = { lat, lng };
  const nearby = all
    .map((r) => ({
      r,
      d: haversineKm(here, { lat: r.latitude, lng: r.longitude }),
    }))
    .filter((x) => x.d <= 15) // 15km envelope
    .sort((a, b) => a.d - b.d)
    .map((x) => x.r);

  if (nearby.length >= minCount) return nearby;

  // TODO: call your ingestion logic if not enough locally.
  return nearby;
}

// --- Start a swipe/recs session ---
router.post("/start", async (req, res) => {
  try {
    const uid = req.user.uid;
    const { lat, lng, minPool = 100 } = req.body || {};
    if (typeof lat !== "number" || typeof lng !== "number") {
      return res.status(400).json({ error: "lat/lng required" });
    }

    const user = await prisma.user.findUnique({ where: { firebaseUid: uid } });
    if (!user) return res.status(404).json({ error: "User not found. Sync profile first." });

    await prisma.swipeSession.updateMany({
      where: { userId: user.id, status: "active" },
      data: { status: "completed", endedAt: new Date() },
    });
    const session = await prisma.swipeSession.create({data: { userId: user.id, status: "active", startedAt: new Date() },});

    const pool = await ensureNearbyRestaurants(lat, lng, minPool);

    const userPrefs = {
      budgetMax: user.budgetMax ?? null,
      dietaryNeeds: user.dietaryNeeds ?? [],
      preferredCuisines: user.preferredCuisines ?? [],
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
      interactions: [], // cold start
    };

    const r = await fetch(`${RECS_SERVICE_URL}/rank`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    // We ignore the returned order here and fetch first actual cards via /next
    res.json({ sessionId: session.id });
  } catch (e) {
    console.error("recs/start error:", e);
    res.status(500).json({ error: "start failed" });
  }
});

// --- Get next card(s) ---
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
   console.warn("recs/next invalid session", {
     sessionFound: !!session,
     sameUser: session ? session.userId === user.id : null,
     status: session ? session.status : null,
   });
   return res.status(400).json({ error: "Invalid session" });
 }

    const swipedIds = new Set(session.events.map((e) => e.restaurantId));
    const pool = await ensureNearbyRestaurants(lat, lng, 100);
    const candidates = pool.filter((r) => !swipedIds.has(r.id));
    if (!candidates.length) return res.json({ items: [] });

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

    // Build interactions from this session
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

    const r = await fetch(`${RECS_SERVICE_URL}/rank`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const ranked = r.ok ? await r.json() : { rankings: items.map((x) => x.id) };

    // take top K and hydrate from DB
    const wantIds = ranked.rankings.slice(0, Math.max(1, Number(limit)));
    const full = await prisma.restaurant.findMany({
      where: { id: { in: wantIds } },
      include: { photos: { take: 1 } },
    });

    // preserve ranked order
    const order = new Map(wantIds.map((id, i) => [id, i]));
    full.sort((a, b) => (order.get(a.id) ?? 9999) - (order.get(b.id) ?? 9999));

    res.json({ items: full });
  } catch (e) {
    console.error("recs/next error:", e);
    res.status(500).json({ error: "next failed" });
  }
});

// --- Record feedback ---
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

// --- Finalize a match ---
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

// --- Get last winner for the user ---
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
