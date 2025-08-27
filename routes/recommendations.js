// routes/recommendations.js
const express = require("express");
const prisma = require("../src/prisma");
const verifyFirebaseToken = require("../middleware/auth");
const recs = require("../src/services/recs");

const router = express.Router();

// auth required for everything here
router.use(verifyFirebaseToken);

// (optional) quick health proxy
router.get("/health", async (_req, res) => {
  const ok = await recs.health().catch(() => false);
  res.json({ ok });
});

/**
 * POST /api/recommendations/rank
 * body: { items?: string[] }  // optional explicit list of restaurant ids to rank
 * Returns: { rankings: Array<{ id: string, score: number }> }
 */
router.post("/rank", async (req, res) => {
  const uid = req.user.uid;

  // 1) Load user preferences
  const user = await prisma.user.findUnique({
    where: { firebaseUid: uid },
    select: {
      budgetMax: true,
      searchDistance: true,
      dietaryNeeds: true,
      preferredCuisines: true,
    },
  });

  // Basic, minimal feature vector for the model
  const userFeatures = {
    budget_max: user?.budgetMax ?? null,
    distance_km: user?.searchDistance ?? null, // null == Unlimited
    cuisines: user?.preferredCuisines ?? [],
    diet: user?.dietaryNeeds ?? [],
  };

  // 2) Ensure we have a candidate set of nearby restaurants (>=100)
  //    If you already have a function that populates the DB around a lat/lng, call it here.
  //    Below is a simple example: take the 200 most recently-seen restaurants as candidates.
  let candidates = [];
  if (Array.isArray(req.body?.items) && req.body.items.length > 0) {
    candidates = await prisma.restaurant.findMany({
      where: { id: { in: req.body.items } },
      select: { id: true },
      take: 500,
    });
  } else {
    candidates = await prisma.restaurant.findMany({
      select: { id: true },
      orderBy: { updatedAt: "desc" },
      take: 200,
    });
  }

  if (candidates.length < 100) {
    // TODO: call your Google Places ingestion here to top-up the DB near the user
    // await fetchMoreRestaurantsNearUser(...)
  }

  const items = candidates.map((r) => ({ id: r.id }));

  // 3) Ask the recs service to rank
  try {
    const { rankings } = await recs.rank({
      userId: uid,
      items,
      userFeatures,
      k: 100,
    });

    // 4) Enrich with basic display fields for the app
    const orderedIds = rankings.map((r) => r.id);
    const rows = await prisma.restaurant.findMany({
      where: { id: { in: orderedIds } },
      select: {
        id: true,
        name: true,
        formattedAddress: true,
        priceLevel: true,
        rating: true,
      },
    });

    // keep the returned order
    const byId = new Map(rows.map((r) => [r.id, r]));
    const ordered = orderedIds
      .map((id) => ({ ...byId.get(id), score: rankings.find((r) => r.id === id)?.score }))
      .filter(Boolean);

    res.json({ items: ordered });
  } catch (e) {
    console.error("rank failed:", e);
    res.status(502).json({ error: "Ranking service unavailable" });
  }
});

module.exports = router;
