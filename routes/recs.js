// routes/recs.js
const express = require("express");
const prisma = require("../src/prisma");
const verifyFirebaseToken = require("../middleware/auth");

const photoProxyRouter = require("./photoProxy");
const { createPlacesService } = require("../src/services/placesService");
const { haversineKm, asFloat } = require("../src/utils/geo");

// Modularized helpers
const {
  filterAndPrioritizeByPreferences,
  requirementsFromUser,
  priceBandFromBudget,
  radiusFromUser,
} = require("../src/recs/filters");
const {
  orderPoolDeterministic,
  encodeCursor,
  decodeCursor,
  mkSeed,
} = require("../src/recs/pagination");
const { ensurePreferredPool } = require("../src/recs/pool");
const { discoverAndIngestAround } = require("../src/recs/discovery");
const { rankIdsWithinPage, buildUserFeatures, buildItemFeatures } = require("../src/recs/rank");

// Fallback fetch (Node 18+ has global fetch; this keeps older envs working)
const fetchFn =
  (typeof fetch === "function" && fetch) ||
  ((...args) => import("node-fetch").then((mod) => mod.default(...args)));

const router = express.Router();

router.get("/__ping", (_req, res) => res.json({ ok: true, via: "recs", ts: Date.now() }));
router.get("/health", (_req, res) => res.json({ ok: true }));

// ─────────────────────────── Config ───────────────────────────
const RECS_SERVICE_URL =
  process.env.RECS_SERVICE_URL || process.env.RECS_URL || "http://127.0.0.1:8000";
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const BACKEND_PUBLIC_URL = process.env.BACKEND_PUBLIC_URL || "https://2eatapp.com";

const MAX_SWIPES_PER_SESSION = Number(process.env.MAX_SWIPES_PER_SESSION || 15);
const EARLY_END_ON_SUPERSTAR = process.env.END_ON_SUPERSTAR === "1";

const places = createPlacesService({ prisma, googleApiKey: GOOGLE_API_KEY });

router.use(photoProxyRouter);

// ─────────────────────────── Lookup (no auth) ───────────────────────────

router.post("/lookup", async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const uniq = [...new Set(ids.filter((s) => typeof s === "string" && s.trim().length))];
    if (!uniq.length) return res.json({ items: [] });

    const rows = await prisma.restaurant.findMany({
      where: { id: { in: uniq } },
      select: {
        id: true,
        name: true,
        editorialSummary: true,
        formattedAddress: true,
        priceLevel: true,
        photos: { take: 1 },
        latitude: true,
        longitude: true,
        primaryType: true,
        types: true,
        servesVegetarianFood: true,
        allowsDogs: true,
        parkingOptions: true,
      },
    });

    const items = rows.map((r) => ({
      id: r.id,
      name: r.name,
      editorialSummary: r.editorialSummary || null,
      editorial_summary: r.editorialSummary || null,
      address: r.formattedAddress,
      priceLevel: r.priceLevel ?? null,
      photoUrl: r.photos?.[0]?.name
        ? `${BACKEND_PUBLIC_URL}/api/recs/photo?name=${encodeURIComponent(r.photos[0].name)}&w=1200`
        : null,
    }));

    res.json({ items });
  } catch (err) {
    console.error("[recs/lookup] error:", err);
    res.status(500).json({ error: "lookup failed" });
  }
});

// ─────────────────────────── Authenticated routes ───────────────────────────

router.use(verifyFirebaseToken);

// Start: creates/fetches active session and stores context (lat,lng,seed,radius)
// routes/recs.js (/start with first page)
// Start: creates/fetches active session and stores context (lat,lng,seed,radius)
// No filtering, no discovery, no rank warmup here.
router.post("/start", async (req, res) => {
  try {
    const uid = req.user.uid;
    const { lat, lng } = req.body || {};
    if (typeof lat !== "number" || typeof lng !== "number") {
      return res.status(400).json({ error: "lat/lng required" });
    }

    const user = await prisma.user.findUnique({ where: { firebaseUid: uid } });
    if (!user) return res.status(404).json({ error: "User not found. Sync profile first." });

    let session = await prisma.swipeSession.findFirst({
      where: { userId: user.id, status: "active" },
      orderBy: { startedAt: "desc" },
      include: { events: true },
    });
    if (!session) {
      session = await prisma.swipeSession.create({ data: { userId: user.id } });
    }

    const seed = mkSeed(session.id);
    const radiusKm = radiusFromUser(user);

    await prisma.swipeSession.update({
      where: { id: session.id },
      data: { context: { lat, lng, radiusKm, seed } },
    });

    res.json({ sessionId: session.id });
  } catch (err) {
    console.error("[recs/start] error:", err);
    res.status(500).json({ error: "start failed" });
  }
});



// Next: returns a page of items using an opaque cursor. First call after /start
// can omit lat/lng because they are stored in session.context.
router.post("/next", async (req, res) => {
  try {
    const uid = req.user.uid;
    const { sessionId, cursor: cursorIn, limit = 8, lat, lng } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });

    const user = await prisma.user.findUnique({ where: { firebaseUid: uid } });
    if (!user) return res.status(404).json({ error: "User not found" });

    const session = await prisma.swipeSession.findUnique({
      where: { id: sessionId },
      include: { events: true },
    });
    if (!session || session.userId !== user.id) {
      return res.status(400).json({ error: "Invalid session" });
    }

    // Enforce cap / completion
    const currentSwipes = session.totalSwipes ?? session.events.length;
    if (session.status !== "active" || currentSwipes >= MAX_SWIPES_PER_SESSION) {
      if (session.status === "active" && currentSwipes >= MAX_SWIPES_PER_SESSION) {
        await prisma.swipeSession.update({
          where: { id: sessionId },
          data: { status: "completed", endedAt: new Date() },
        });
      }
      return res.json({ items: [], sessionCompleted: true });
    }

    // Decode cursor or initialize from session context
    let state = decodeCursor(cursorIn);
    let idx = Number(state?.idx || 0);

    let ctx = session.context || {};
    let useLat = state?.lat ?? ctx.lat ?? lat;
    let useLng = state?.lng ?? ctx.lng ?? lng;
    let seed = state?.seed ?? ctx.seed ?? mkSeed(sessionId);
    let radiusKm = ctx.radiusKm ?? radiusFromUser(user);

    if (typeof useLat !== "number" || typeof useLng !== "number") {
      return res.status(400).json({ error: "lat/lng missing; call /start first" });
    }

    // Backfill context if session lacked it (older sessions)
    if (!ctx?.lat || !ctx?.lng) {
      await prisma.swipeSession.update({
        where: { id: sessionId },
        data: { context: { lat: useLat, lng: useLng, radiusKm, seed } },
      });
    }

    // Build pool and remove already-swiped
    const prefPool = await ensurePreferredPool({ places, lat: useLat, lng: useLng, user, desiredMin: 120 });
    const swipedIds = new Set(session.events.map((e) => e.restaurantId));
    const basePool = prefPool.filter((r) => !swipedIds.has(r.id));

    if (!basePool.length) {
      return res.json({ items: [] });
    }

    // Deterministic order across the whole pool; cursor slices by index
    const ordered = orderPoolDeterministic(basePool, sessionId, seed);
    const pageRecords = ordered.slice(idx, idx + Math.max(1, Number(limit)));
    const nextIdx = idx + pageRecords.length;

    // Rank within the page (does not affect cursor determinism)
    const interactions = session.events.map((e) => ({
      userId: user.id,
      itemId: e.restaurantId,
      action: e.action,
    }));
    const userFeatures = buildUserFeatures(user);
    const itemFeatures = buildItemFeatures(pageRecords, useLat, useLng);
    const rankedIds = await rankIdsWithinPage({
      rankUrl: RECS_SERVICE_URL,
      userId: user.id,
      userFeatures,
      items: itemFeatures,
      interactions,
    });

    // Hydrate to client shape
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

    // Prompt context (derived from session events)
    const events = session.events;
    const likes = events.filter((e) => e.action === "LIKE").map((e) => e.restaurantId);
    const top3CandidateIds = likes.slice(-3).reverse();
    const superStarRestaurantId =
      [...events].reverse().find((e) => e.action === "SUPERSTAR")?.restaurantId || null;
    const shouldSuggestMatch = (session.totalSwipes ?? events.length) >= 15 || false;

    const nextCursor = encodeCursor({ idx: nextIdx, seed, lat: useLat, lng: useLng });

    res.json({
      items: clientItems,
      cursor: nextCursor,
      shouldMatchPrompt: shouldSuggestMatch,
      top3CandidateIds,
      superStarRestaurantId,
    });
  } catch (err) {
    console.error("[recs/next] error:", err);
    res.status(500).json({ error: "next failed" });
  }
});

// Feedback: records LIKE/PASS/SUPERSTAR (UPPERCASE) and may complete session
router.post("/feedback", async (req, res) => {
  try {
    const uid = req.user.uid;
    let { sessionId, restaurantId, action } = req.body || {};
    action = String(action || "").toUpperCase();
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
    let sessionCompleted = false;

    await prisma.$transaction(async (tx) => {
      await tx.swipeEvent.create({
        data: { sessionId, userId: user.id, restaurantId, action, position },
      });
      const updated = await tx.swipeSession.update({
        where: { id: sessionId },
        data: { totalSwipes: { increment: 1 } },
        select: { totalSwipes: true },
      });

      const reachedCap = (updated.totalSwipes ?? position) >= MAX_SWIPES_PER_SESSION;
      const endNow = reachedCap || (EARLY_END_ON_SUPERSTAR && action === "SUPERSTAR");

      if (endNow) {
        await tx.swipeSession.update({
          where: { id: sessionId },
          data: { status: "completed", endedAt: new Date() },
        });
        sessionCompleted = true;
      }
    });

    const nextCount = (session.totalSwipes ?? session.events.length) + 1;
    const shouldRerank = nextCount % 5 === 0;
    const shouldSuggestMatch = sessionCompleted || nextCount >= 15;

    res.json({ ok: true, shouldRerank, shouldSuggestMatch, sessionCompleted });
  } catch (err) {
    console.error("[recs/feedback] error:", err);
    res.status(500).json({ error: "feedback failed" });
  }
});

// Finalize: saves match and completes session
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

    const winner = await prisma.restaurant.findUnique({
      where: { id: winnerRestaurantId },
      include: { photos: { take: 1 } },
    });

    let winnerPhotoUrl = null;
    const photoName = winner?.photos?.[0]?.name || null;
    if (photoName) {
      winnerPhotoUrl = `${BACKEND_PUBLIC_URL}/api/recs/photo?name=${encodeURIComponent(
        photoName
      )}&w=1200`;
    }

    const payloadWinner =
      winner && {
        id: winner.id,
        name: winner.name,
        address: winner.formattedAddress,
        priceLevel: winner.priceLevel ?? null,
        primaryType: winner.primaryType,
        types: winner.types,
        editorialSummary: winner.editorialSummary || null,
        editorial_summary: winner.editorialSummary || null,
        photoUrl: winnerPhotoUrl,
      };

    res.json({ ok: true, winner: payloadWinner });
  } catch (err) {
    console.error("[recs/finalize-match] error:", err);
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

    const r = await prisma.restaurant.findUnique({
      where: { id: m.winnerRestaurantId },
      include: { photos: { take: 1 } },
    });

    const photoName = r?.photos?.[0]?.name || null;
    const photoUrl = photoName
      ? `${BACKEND_PUBLIC_URL}/api/recs/photo?name=${encodeURIComponent(photoName)}&w=1200`
      : null;

    res.json({
      winner:
        r && {
          id: r.id,
          name: r.name,
          address: r.formattedAddress,
          priceLevel: r.priceLevel ?? null,
          primaryType: r.primaryType,
          types: r.types,
          editorialSummary: r.editorialSummary || null,
          editorial_summary: r.editorialSummary || null,
          photoUrl,
        },
    });
  } catch (err) {
    console.error("[recs/winner] error:", err);
    res.status(500).json({ error: "winner failed" });
  }
});

module.exports = router;
