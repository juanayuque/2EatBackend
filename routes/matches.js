// routes/matches.js
// History & details for user matches (modular, auth required)

const express = require("express");
const prisma = require("../src/prisma");
const verifyFirebaseToken = require("../middleware/auth");

const router = express.Router();

const BACKEND_PUBLIC_URL = process.env.BACKEND_PUBLIC_URL || "https://2eatapp.com";

// --- Public health checks (no auth) ---
router.get("/__ping", (_req, res) => res.json({ ok: true, via: "matches", ts: Date.now() }));
router.get("/health", (_req, res) => res.json({ ok: true }));

// Everything below requires a Firebase ID token
router.use(verifyFirebaseToken);

// Helpers
function photoUrlFor(r) {
  const name = r?.photos?.[0]?.name || null; // "places/<id>/photos/<photoId>"
  return name
    ? `${BACKEND_PUBLIC_URL}/api/recs/photo?name=${encodeURIComponent(name)}&w=800`
    : null;
}

function shapeRestaurant(r) {
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    address: r.formattedAddress,
    priceLevel: r.priceLevel ?? null,
    primaryType: r.primaryType,
    types: r.types,
    editorialSummary: r.editorialSummary || null,
    editorial_summary: r.editorialSummary || null, // alias for frontend
    photoUrl: photoUrlFor(r),
  };
}

/**
 * GET /api/matches
 * Returns recent matches for the authed user, fully hydrated with restaurant data.
 */
router.get("/", async (req, res) => {
  try {
    const uid = req.user.uid;
    const user = await prisma.user.findUnique({ where: { firebaseUid: uid } });
    if (!user) return res.status(404).json({ error: "User not found" });

    const matches = await prisma.match.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 30,
    });
    if (!matches.length) return res.json({ matches: [] });

    // Collect all restaurant ids we need to hydrate in one go
    const ids = new Set();
    for (const m of matches) {
      if (m.winnerRestaurantId) ids.add(m.winnerRestaurantId);
      if (m.top1RestaurantId) ids.add(m.top1RestaurantId);
      if (m.top2RestaurantId) ids.add(m.top2RestaurantId);
      if (m.top3RestaurantId) ids.add(m.top3RestaurantId);
      if (m.superStarRestaurantId) ids.add(m.superStarRestaurantId);
    }

    const restaurants = await prisma.restaurant.findMany({
      where: { id: { in: Array.from(ids) } },
      include: { photos: { take: 1 } },
    });
    const byId = new Map(restaurants.map((r) => [r.id, r]));

    const payload = matches.map((m) => ({
      id: m.id,
      sessionId: m.sessionId,
      createdAt: m.createdAt,
      winner: shapeRestaurant(byId.get(m.winnerRestaurantId)),
      top1: shapeRestaurant(byId.get(m.top1RestaurantId)),
      top2: shapeRestaurant(byId.get(m.top2RestaurantId)),
      top3: shapeRestaurant(byId.get(m.top3RestaurantId)),
      superStar: shapeRestaurant(byId.get(m.superStarRestaurantId)),
    }));

    res.json({ matches: payload });
  } catch (e) {
    console.error("matches/index error:", e);
    res.status(500).json({ error: "history failed" });
  }
});

/**
 * GET /api/matches/:id
 * Returns one match with hydrated restaurants.
 */
router.get("/:id", async (req, res) => {
  try {
    const uid = req.user.uid;
    const user = await prisma.user.findUnique({ where: { firebaseUid: uid } });
    if (!user) return res.status(404).json({ error: "User not found" });

    const m = await prisma.match.findFirst({
      where: { id: req.params.id, userId: user.id },
    });
    if (!m) return res.status(404).json({ error: "Not found" });

    const ids = [
      m.winnerRestaurantId,
      m.top1RestaurantId,
      m.top2RestaurantId,
      m.top3RestaurantId,
      m.superStarRestaurantId,
    ].filter(Boolean);

    const restaurants = await prisma.restaurant.findMany({
      where: { id: { in: ids } },
      include: { photos: { take: 1 } },
    });
    const byId = new Map(restaurants.map((r) => [r.id, r]));

    res.json({
      match: {
        id: m.id,
        sessionId: m.sessionId,
        createdAt: m.createdAt,
        winner: shapeRestaurant(byId.get(m.winnerRestaurantId)),
        top1: shapeRestaurant(byId.get(m.top1RestaurantId)),
        top2: shapeRestaurant(byId.get(m.top2RestaurantId)),
        top3: shapeRestaurant(byId.get(m.top3RestaurantId)),
        superStar: shapeRestaurant(byId.get(m.superStarRestaurantId)),
      },
    });
  } catch (e) {
    console.error("matches/show error:", e);
    res.status(500).json({ error: "show failed" });
  }
});

module.exports = router;
