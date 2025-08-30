// routes/groupMatch.js
const express = require("express");
const prisma = require("../src/prisma");
const verifyFirebaseToken = require("../middleware/auth");

const { createPlacesService } = require("../src/services/placesService");
const { haversineKm, asFloat } = require("../src/utils/geo");
const { ensurePreferredPool } = require("../src/recs/pool");
const { radiusFromUser, requirementsFromUser } = require("../src/recs/filters");
const {
  orderPoolDeterministic,
  encodeCursor,
  decodeCursor,
  mkSeed,
} = require("../src/recs/pagination");
const { rankIdsWithinPage, buildUserFeatures, buildItemFeatures } = require("../src/recs/rank");

const router = express.Router();
router.use(verifyFirebaseToken);

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const BACKEND_PUBLIC_URL = process.env.BACKEND_PUBLIC_URL || "https://2eatapp.com";
const RECS_SERVICE_URL =
  process.env.RECS_SERVICE_URL || process.env.RECS_URL || "http://127.0.0.1:8000";
const MAX_SWIPES = Number(process.env.GROUP_MAX_SWIPES || 15);
const END_ON_SUPERSTAR = process.env.END_ON_SUPERSTAR === "1";
const DESIRED_MIN_POOL = 20;

const places = createPlacesService({ prisma, googleApiKey: GOOGLE_API_KEY });

// ——— helpers ———
async function authedUser(firebaseUid) {
  return prisma.user.findUnique({ where: { firebaseUid } });
}
async function ensureFriendship(aId, bId) {
  const f = await prisma.friend.findFirst({ where: { userId: aId, friendId: bId } });
  return !!f;
}
function combinedUser(u1, u2) {
  const uniq = (arr) => Array.from(new Set((arr || []).filter(Boolean)));
  const minOr = (a, b) => {
    if (a == null) return b ?? null;
    if (b == null) return a ?? null;
    return Math.min(a, b);
  };

  return {
    id: `${u1.id}+${u2.id}`,
    // keep harmless basics from host
    firebaseUid: u1.firebaseUid,
    // combine prefs conservatively so both can eat/enjoy
    searchDistance: minOr(u1.searchDistance ?? 5, u2.searchDistance ?? 5),
    budgetMax: minOr(u1.budgetMax ?? null, u2.budgetMax ?? null),
    dietaryNeeds: uniq([...(u1.dietaryNeeds || []), ...(u2.dietaryNeeds || [])]),
    preferredCuisines: uniq([...(u1.preferredCuisines || []), ...(u2.preferredCuisines || [])]),
    // display only (unused by filters)
    displayName: `${u1.displayName || "You"} & ${u2.displayName || "Friend"}`,
  };
}

// ——— start ———
router.post("/start", async (req, res) => {
  try {
    const me = await authedUser(req.user.uid);
    if (!me) return res.status(404).json({ error: "User not found" });

    const { friendId, lat, lng, forceNew = false } = req.body || {};
    if (typeof lat !== "number" || typeof lng !== "number" || !friendId) {
      return res.status(400).json({ error: "friendId, lat, lng required" });
    }

    const friend = await prisma.user.findUnique({ where: { id: friendId } });
    if (!friend) return res.status(404).json({ error: "Friend not found" });

    const ok = await ensureFriendship(me.id, friend.id);
    if (!ok) return res.status(403).json({ error: "Not friends" });

    if (forceNew) {
      await prisma.groupSwipeSession.updateMany({
        where: { hostUserId: me.id, friendUserId: friend.id, status: "active" },
        data: { status: "completed", endedAt: new Date() },
      });
    }

    let session = await prisma.groupSwipeSession.findFirst({
      where: { hostUserId: me.id, friendUserId: friend.id, status: "active" },
      orderBy: { startedAt: "desc" },
    });
    if (!session) {
      session = await prisma.groupSwipeSession.create({
        data: { hostUserId: me.id, friendUserId: friend.id },
      });
    }

    const combined = combinedUser(me, friend);
    const seed = mkSeed(session.id);
    const radiusKm = radiusFromUser(combined);

    await prisma.groupSwipeSession.update({
      where: { id: session.id },
      data: { context: { lat, lng, seed, radiusKm } },
    });

    res.json({ sessionId: session.id });
  } catch (err) {
    console.error("[group/start] error:", err);
    res.status(500).json({ error: "start failed" });
  }
});

// ——— next ———
router.post("/next", async (req, res) => {
  try {
    const me = await authedUser(req.user.uid);
    if (!me) return res.status(404).json({ error: "User not found" });

    const { sessionId, cursor: cursorIn, limit = 8, lat, lng } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });

    const session = await prisma.groupSwipeSession.findUnique({
      where: { id: sessionId },
      include: { events: true, host: true, friend: true },
    });
    if (!session || session.hostUserId !== me.id) {
      return res.status(400).json({ error: "Invalid session" });
    }

    const currentSwipes = session.totalSwipes ?? session.events.length;
    if (session.status !== "active" || currentSwipes >= MAX_SWIPES) {
      if (session.status === "active" && currentSwipes >= MAX_SWIPES) {
        await prisma.groupSwipeSession.update({
          where: { id: sessionId },
          data: { status: "completed", endedAt: new Date() },
        });
      }
      return res.json({ items: [], cursor: null, exhausted: true, sessionCompleted: true });
    }

    const state = decodeCursor(cursorIn);
    let idx = Number(state?.idx || 0);

    const ctx = session.context || {};
    const useLat = state?.lat ?? ctx.lat ?? lat;
    const useLng = state?.lng ?? ctx.lng ?? lng;
    const seed = state?.seed ?? ctx.seed ?? mkSeed(sessionId);

    if (typeof useLat !== "number" || typeof useLng !== "number") {
      return res.status(400).json({ error: "lat/lng missing; call /start first" });
    }

    const duo = combinedUser(session.host, session.friend);

    const prefPool = await ensurePreferredPool({
      places,
      lat: useLat,
      lng: useLng,
      user: duo,
      desiredMin: DESIRED_MIN_POOL,
    });

    const swipedIds = new Set(session.events.map((e) => e.restaurantId));
    const basePool = prefPool.filter((r) => !swipedIds.has(r.id));

    if (!basePool.length) {
      const likes = session.events.filter((e) => e.action === "LIKE").map((e) => e.restaurantId);
      const top3CandidateIds = likes.slice(-3).reverse();
      const superStarRestaurantId =
        [...session.events].reverse().find((e) => e.action === "SUPERSTAR")?.restaurantId || null;
      const shouldSuggestMatch = (session.totalSwipes ?? session.events.length) >= MAX_SWIPES;

      return res.json({
        items: [],
        cursor: null,
        exhausted: true,
        shouldMatchPrompt: shouldSuggestMatch,
        top3CandidateIds,
        superStarRestaurantId,
      });
    }

    const ordered = orderPoolDeterministic(basePool, sessionId, seed);
    const pageRecords = ordered.slice(idx, idx + Math.max(1, Number(limit)));
    const nextIdx = idx + pageRecords.length;

    // Optional: ML re-rank within page (same as solo)
    const interactions = session.events.map((e) => ({
      userId: me.id,
      itemId: e.restaurantId,
      action: e.action,
    }));
    const userFeatures = buildUserFeatures(duo);
    const itemFeatures = buildItemFeatures(pageRecords, useLat, useLng);
    let rankedIds = [];
    try {
      rankedIds = await rankIdsWithinPage({
        rankUrl: RECS_SERVICE_URL,
        userId: me.id,
        userFeatures,
        items: itemFeatures,
        interactions,
      });
    } catch {
      rankedIds = [];
    }

    const ids = rankedIds.length ? rankedIds : pageRecords.map((x) => x.id);
    let full = await prisma.restaurant.findMany({
      where: { id: { in: ids } },
      include: { photos: { take: 1 } },
    });
    const orderMap = new Map(ids.map((id, i) => [id, i]));
    full.sort((a, b) => (orderMap.get(a.id) ?? 9999) - (orderMap.get(b.id) ?? 9999));

    const clientItems = full.map((r) => {
      const photoName = r.photos?.[0]?.name || null;
      const photoUrl = photoName
        ? `${BACKEND_PUBLIC_URL}/api/recs/photo?name=${encodeURIComponent(photoName)}&w=1200`
        : null;
      const dist = haversineKm(
        { lat: useLat, lng: useLng },
        { lat: asFloat(r.latitude), lng: asFloat(r.longitude) }
      );
      return {
        id: r.id,
        name: r.name,
        address: r.formattedAddress,
        priceLevel: r.priceLevel ?? null,
        distance: dist,
        photoUrl,
        primaryType: r.primaryType,
        types: r.types,
        editorialSummary: r.editorialSummary || null,
        editorial_summary: r.editorialSummary || null,
        servesVegetarianFood: r.servesVegetarianFood ?? null,
        allowsDogs: r.allowsDogs ?? null,
        hasParking:
          r.parkingOptions && typeof r.parkingOptions === "object"
            ? Object.values(r.parkingOptions).some(Boolean)
            : false,
      };
    });

    const likes = session.events.filter((e) => e.action === "LIKE").map((e) => e.restaurantId);
    const top3CandidateIds = likes.slice(-3).reverse();
    const superStarRestaurantId =
      [...session.events].reverse().find((e) => e.action === "SUPERSTAR")?.restaurantId || null;
    const shouldSuggestMatch = (session.totalSwipes ?? session.events.length) >= MAX_SWIPES;

    const atEnd = nextIdx >= ordered.length;
    const nextCursor = atEnd ? null : encodeCursor({ idx: nextIdx, seed, lat: useLat, lng: useLng });

    res.json({
      items: clientItems,
      cursor: nextCursor,
      exhausted: atEnd && clientItems.length === 0,
      shouldMatchPrompt: shouldSuggestMatch,
      top3CandidateIds,
      superStarRestaurantId,
    });
  } catch (err) {
    console.error("[group/next] error:", err);
    res.status(500).json({ error: "next failed" });
  }
});

// ——— feedback ———
router.post("/feedback", async (req, res) => {
  try {
    const me = await authedUser(req.user.uid);
    if (!me) return res.status(404).json({ error: "User not found" });

    let { sessionId, restaurantId, action } = req.body || {};
    action = String(action || "").toUpperCase();
    if (!sessionId || !restaurantId || !["LIKE", "PASS", "SUPERSTAR"].includes(action)) {
      return res.status(400).json({ error: "sessionId, restaurantId, action required" });
    }

    const s = await prisma.groupSwipeSession.findUnique({
      where: { id: sessionId },
      include: { events: true },
    });
    if (!s || s.hostUserId !== me.id || s.status !== "active") {
      return res.status(400).json({ error: "Invalid session" });
    }

    const position = s.events.length + 1;
    let sessionCompleted = false;

    await prisma.$transaction(async (tx) => {
      await tx.groupSwipeEvent.create({
        data: { sessionId, userId: me.id, restaurantId, action, position },
      });
      const updated = await tx.groupSwipeSession.update({
        where: { id: sessionId },
        data: { totalSwipes: { increment: 1 } },
        select: { totalSwipes: true },
      });

      const reached = (updated.totalSwipes ?? position) >= MAX_SWIPES;
      const endNow = reached || (END_ON_SUPERSTAR && action === "SUPERSTAR");
      if (endNow) {
        await tx.groupSwipeSession.update({
          where: { id: sessionId },
          data: { status: "completed", endedAt: new Date() },
        });
        sessionCompleted = true;
      }
    });

    const nextCount = (s.totalSwipes ?? s.events.length) + 1;
    const shouldRerank = nextCount % 5 === 0;
    const shouldSuggestMatch = sessionCompleted || nextCount >= MAX_SWIPES;

    res.json({ ok: true, shouldRerank, shouldSuggestMatch, sessionCompleted });
  } catch (err) {
    console.error("[group/feedback] error:", err);
    res.status(500).json({ error: "feedback failed" });
  }
});

// ——— finalize ———
router.post("/finalize-match", async (req, res) => {
  try {
    const me = await authedUser(req.user.uid);
    if (!me) return res.status(404).json({ error: "User not found" });

    const { sessionId, top3 = [], winnerRestaurantId, superStarRestaurantId = null, comment = null } =
      req.body || {};
    if (!sessionId || !winnerRestaurantId || !Array.isArray(top3) || top3.length === 0) {
      return res.status(400).json({ error: "sessionId, winnerRestaurantId, top3 required" });
    }

    const s = await prisma.groupSwipeSession.findUnique({ where: { id: sessionId } });
    if (!s || s.hostUserId !== me.id) return res.status(400).json({ error: "Invalid session" });

    await prisma.$transaction(async (tx) => {
      await tx.groupMatch.create({
        data: {
          sessionId,
          hostUserId: s.hostUserId,
          friendUserId: s.friendUserId,
          top1RestaurantId: top3[0],
          top2RestaurantId: top3[1] ?? null,
          top3RestaurantId: top3[2] ?? null,
          superStarRestaurantId,
          winnerRestaurantId,
          comment,
        },
      });
      await tx.groupSwipeSession.update({
        where: { id: sessionId },
        data: { status: "completed", endedAt: new Date() },
      });
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("[group/finalize] error:", err);
    res.status(500).json({ error: "finalize failed" });
  }
});

module.exports = router;
