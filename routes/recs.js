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

// Support either env var name
const RECS_SERVICE_URL =
  process.env.RECS_SERVICE_URL || process.env.RECS_URL || "http://127.0.0.1:8000";

const BACKEND_PUBLIC_URL = process.env.BACKEND_PUBLIC_URL || "";

// Helpers
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
function isLikelyUrl(s = "") {
  return /^https?:\/\//i.test(s) || s.startsWith("data:");
}
function pickPhotoUrl(r) {
  const p = r?.photos?.[0];
  if (!p) return null;
  // If you store a cached URL directly in Photo.name, use it as-is
  if (isLikelyUrl(p.name)) return p.name;
  // Otherwise fallback to proxy using Google photo name
  if (!BACKEND_PUBLIC_URL) return null;
  return `${BACKEND_PUBLIC_URL}/api/places/photo?name=${encodeURIComponent(p.name)}`;
}
function matchesCuisine(r, preferred = []) {
  if (!preferred.length) return false;
  const haystack = [
    r.primaryTypeDisplayName,
    r.editorialSummary,
    r.name,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return preferred.some((c) => haystack.includes(String(c).toLowerCase()));
}

async function ensureNearbyRestaurants(lat, lng, minCount = 100) {
  // NOTE: This is a simple example. You can add geo-indexing later.
  const all = await prisma.restaurant.findMany({
    take: 300,
    include: { photos: { take: 1, select: { name: true } } },
  });

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

  // TODO: trigger ingestion if needed
  return nearby;
}

// Shape output back to client (flatten + attach photoUrl)
function shapeRestaurants(list, here) {
  return list.map((r) => ({
    id: r.id,
    googlePlaceId: r.googlePlaceId,
    name: r.name,
    latitude: Number(r.latitude),
    longitude: Number(r.longitude),
    formattedAddress: r.formattedAddress,
    priceLevel: r.priceLevel,
    editorialSummary: r.editorialSummary,
    primaryTypeDisplayName: r.primaryTypeDisplayName,
    photoUrl: pickPhotoUrl(r),
    distanceKm: here ? haversineKm(here, { lat: r.latitude, lng: r.longitude }) : undefined,
  }));
}

async function rankCandidates({ user, items, interactions }) {
  try {
    const r = await fetch(`${RECS_SERVICE_URL}/rank`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user, items, interactions }),
    });
    if (!r.ok) {
      console.warn("rank service not ok:", r.status);
      return { rankings: items.map((x) => x.id) };
    }
    return await r.json();
  } catch (e) {
    console.warn("rank service error:", e?.message || e);
    return { rankings: items.map((x) => x.id) };
  }
}

// --- Start a swipe/recs session ---
router.post("/start", async (req, res) => {
  try {
    const uid = req.user.uid;
    const { lat, lng, minPool = 100, initialLimit = 3 } = req.body || {};
    if (typeof lat !== "number" || typeof lng !== "number") {
      return res.status(400).json({ error: "lat/lng required" });
    }

    const user = await prisma.user.findUnique({ where: { firebaseUid: uid } });
    if (!user) return res.status(404).json({ error: "User not found. Sync profile first." });

    // Close any previous active sessions
    await prisma.swipeSession.updateMany({
      where: { userId: user.id, status: "active" },
      data: { status: "completed", endedAt: new Date() },
    });
    const session = await prisma.swipeSession.create({ data: { userId: user.id } });

    // Build pool nearby
    let pool = await ensureNearbyRestaurants(lat, lng, minPool);

    // Apply cuisine preference pre-filter if we have any matches
    const preferred = (user.preferredCuisines || []).map((s) => String(s).toLowerCase());
    if (preferred.length) {
      const hits = pool.filter((r) => matchesCuisine(r, preferred));
      if (hits.length) pool = hits;
    }

    // Prepare rank items
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

    const userFeatures = [
      `uband:${priceBandFromBudget(user.budgetMax ?? null)}`,
      ...(user.preferredCuisines || []).map((c) => `ucuisine:${c}`),
      ...(user.dietaryNeeds || []).map((d) => `udiet:${d}`),
    ];

    // Rank
    const ranked = await rankCandidates({
      user: { id: user.id, features: userFeatures },
      items,
      interactions: [], // cold start
    });

    // Take first batch & hydrate from DB (with photos)
    const wantIds = (ranked?.rankings || items.map((x) => x.id)).slice(
      0,
      Math.max(1, Number(initialLimit) || 1)
    );

    let full = await prisma.restaurant.findMany({
      where: { id: { in: wantIds } },
      include: { photos: { take: 1, select: { name: true } } },
    });

    // preserve ranked order
    const order = new Map(wantIds.map((id, i) => [id, i]));
    full.sort((a, b) => (order.get(a.id) ?? 9999) - (order.get(b.id) ?? 9999));

    const shaped = shapeRestaurants(full, { lat, lng });

    res.json({ sessionId: session.id, items: shaped });
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
      return res.status(400).json({ error: "Invalid session" });
    }

    const swipedIds = new Set(session.events.map((e) => e.restaurantId));
    let pool = await ensureNearbyRestaurants(lat, lng, 100);
    let candidates = pool.filter((r) => !swipedIds.has(r.id));

    // Prefer user cuisine matches for the remaining pool
    const preferred = (user.preferredCuisines || []).map((s) => String(s).toLowerCase());
    if (preferred.length) {
      const hits = candidates.filter((r) => matchesCuisine(r, preferred));
      if (hits.length) candidates = hits;
    }

    if (!candidates.length) return res.json({ items: [] });

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

    const userFeatures = [
      `uband:${priceBandFromBudget(user.budgetMax ?? null)}`,
      ...(user.preferredCuisines || []).map((c) => `ucuisine:${c}`),
      ...(user.dietaryNeeds || []).map((d) => `udiet:${d}`),
    ];

    const ranked = await rankCandidates({
      user: { id: user.id, features: userFeatures },
      items,
      interactions,
    });

    // take top K and hydrate from DB
    const wantIds = (ranked?.rankings || items.map((x) => x.id)).slice(
      0,
      Math.max(1, Number(limit) || 1)
    );

    let full = await prisma.restaurant.findMany({
      where: { id: { in: wantIds } },
      include: { photos: { take: 1, select: { name: true } } },
    });

    const order = new Map(wantIds.map((id, i) => [id, i]));
    full.sort((a, b) => (order.get(a.id) ?? 9999) - (order.get(b.id) ?? 9999));

    const shaped = shapeRestaurants(full, { lat, lng });
    res.json({ items: shaped });
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
