// routes/recs.js
// Router focused on HTTP orchestration. Business logic for Places ingest/backfill
// lives in services/placesService. Geo/price helpers live in utils so multiple modules share them.

const express = require("express");
const prisma = require("../src/prisma");
const verifyFirebaseToken = require("../middleware/auth");

const photoProxyRouter = require("./photoProxy"); // isolates photo/media concerns
const { createPlacesService } = require("../src/services/placesService");
const { haversineKm, distanceBand, asFloat } = require("../src/utils/geo");
const { normalizePriceLevel, mapPriceLevelEnum } = require("../src/utils/price");

const router = express.Router();

/* ───────────────────────── Public routes (no auth) ───────────────────────── */

router.get("/__ping", (_req, res) => res.json({ ok: true, via: "recs", ts: Date.now() }));
router.get("/health", (_req, res) => res.json({ ok: true }));

// Configuration pulled once at boot to avoid re-reading env on every request.
const RECS_SERVICE_URL =
  process.env.RECS_SERVICE_URL || process.env.RECS_URL || "http://127.0.0.1:8000";
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const BACKEND_PUBLIC_URL = process.env.BACKEND_PUBLIC_URL || "https://2eatapp.com";

console.log("[recs] BOOT", {
  HAS_GOOGLE_API_KEY: !!GOOGLE_API_KEY,
  RECS_SERVICE_URL,
  BACKEND_PUBLIC_URL,
});

// Initializes the Places service with its dependencies. This allows swapping/mocking in tests.
const places = createPlacesService({ prisma, googleApiKey: GOOGLE_API_KEY });

// Mounts the photo proxy as part of this router so the client can call /api/recs/photo
router.use(photoProxyRouter);

// ---------- helpers kept local to this router ----------

// Google Places v1 -> our DB int (1..4). Kept for legacy imports relying on this file.
function mapPriceLevelEnumLocal(v) {
  return mapPriceLevelEnum(v);
}

// Cuisine preference matching is kept here since it is app-specific (not Places-specific).
const CUISINE_KEYWORDS = {
  indian: ["indian"],
  chinese: ["chinese", "szechuan", "sichuan", "cantonese", "hunan"],
  italian: ["italian", "pizza", "pasta", "sicilian", "tuscan"],
  japanese: ["japanese", "sushi", "ramen", "izakaya"],
  thai: ["thai"],
  mexican: ["mexican", "taqueria", "taco"],
  korean: ["korean", "bbq"],
  american: ["american", "burger", "bbq"],
  vietnamese: ["vietnamese", "pho", "banh mi", "bahn mi"],
  mediterranean: ["mediterranean", "greek", "turkish", "lebanese"],
  "middle eastern": ["middle eastern", "lebanese", "turkish", "persian", "iranian"],
  spanish: ["spanish", "tapas"],
  french: ["french", "bistro", "brasserie"],
  greek: ["greek"],
  turkish: ["turkish"],
  lebanese: ["lebanese"],
  persian: ["persian", "iranian"],
};

const norm = (s) => String(s || "").toLowerCase().replace(/[_\s-]+/g, " ").trim();

function cuisineKeywordsFromUser(user) {
  // Builds a normalized set of keywords to avoid repeated lookups and ensure case-insensitive matching.
  const out = new Set();
  for (const p of user?.preferredCuisines || []) {
    const key = norm(p);
    (CUISINE_KEYWORDS[key] || [key]).forEach((k) => out.add(k));
  }
  return out;
}

function restaurantMatchesCuisine(r, keywordSet) {
  // Early return improves performance when no preferences were set.
  if (!keywordSet || !keywordSet.size) return true;

  const primary = (r.primaryType || "").toLowerCase();
  const types = Array.isArray(r.types) ? r.types.map((t) => String(t).toLowerCase()) : [];
  const display = (r.primaryTypeDisplayName || r.name || "").toLowerCase();

  for (const k of keywordSet) {
    const needle = k.replace(/\s+/g, "_");
    if (primary.includes(needle)) return true;
    if (types.some((t) => t.includes(needle))) return true;
    if (display.includes(k)) return true;
  }
  return false;
}

function priceBandFromBudget(budgetMax) {
  // Maps user budget to coarse price tiers that the ranker understands.
  if (budgetMax == null) return 0;
  if (budgetMax <= 15) return 1;
  if (budgetMax <= 30) return 2;
  if (budgetMax <= 60) return 3;
  return 4;
}

/**
 * Original preference filter: returns nearest matches, then pads with nearest non-matches
 * until desiredMin is reached. If still short, the caller may choose to discover more.
 */
function filterAndPrioritizeByPreferences(pool, user, lat, lng, desiredMin = 60) {
  const keys = cuisineKeywordsFromUser(user);
  const here = { lat, lng };

  const withDist = pool.map((r) => ({
    r,
    d: haversineKm(here, { lat: asFloat(r.latitude), lng: asFloat(r.longitude) }),
  }));

  const matches = withDist
    .filter(({ r }) => restaurantMatchesCuisine(r, keys))
    .sort((a, b) => a.d - b.d);

  if (matches.length >= desiredMin) return matches.map((x) => x.r);

  // If not enough matches, fills with nearest non-matching options to satisfy pool size.
  const non = withDist
    .filter(({ r }) => !restaurantMatchesCuisine(r, keys))
    .sort((a, b) => a.d - b.d);

  const merged = [...matches.map((x) => x.r)];
  for (const n of non) {
    if (merged.length >= desiredMin) break;
    merged.push(n.r);
  }
  return merged.length ? merged : pool;
}

// ---- discovery helpers (router-level, integrates with places service) ----
function generateRingCenters(lat, lng, minKm = 2, maxKm = 12, stepKm = 2) {
  // Generates a ring of centers every "stepKm" from minKm up to maxKm
  const centers = [];
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const earthKm = 6371;
  const lat1 = toRad(lat);
  const lon1 = toRad(lng);

  for (let r = minKm; r <= maxKm; r += stepKm) {
    const circumference = 2 * Math.PI * r;
    const points = Math.max(6, Math.round(circumference / stepKm)); // roughly hex-like density
    const angDist = r / earthKm;

    for (let i = 0; i < points; i++) {
      const bearing = (2 * Math.PI * i) / points;
      const lat2 = Math.asin(
        Math.sin(lat1) * Math.cos(angDist) +
          Math.cos(lat1) * Math.sin(angDist) * Math.cos(bearing)
      );
      const lon2 =
        lon1 +
        Math.atan2(
          Math.sin(bearing) * Math.sin(angDist) * Math.cos(lat1),
          Math.cos(angDist) - Math.sin(lat1) * Math.sin(lat2)
        );
      centers.push({ lat: toDeg(lat2), lng: toDeg(lon2) });
    }
  }
  return centers;
}

async function discoverAndIngestAround(
  lat,
  lng,
  {
    cellRadiusMeters = 3000,
    rankPrefs = ["POPULARITY", "DISTANCE"],
    includeTypes = [["restaurant"]],
    maxCenters = 18, // safety to avoid quota spikes
    delayMs = 120, // polite pause between calls
  } = {}
) {
  // Sweeps a ring of centers, queries Places with multiple rank preferences and types,
  // dedupes by id, and upserts only new places.
  const centers = generateRingCenters(lat, lng, 2, 12, 2).slice(0, maxCenters);
  const byId = new Map();

  for (const c of centers) {
    for (const rankPreference of rankPrefs) {
      for (const types of includeTypes) {
        const chunk = await places.googlePlacesSearchNearby(c.lat, c.lng, {
          radiusMeters: cellRadiusMeters,
          maxPages: 3,
          rankPreference,
          includedTypes: types,
        });
        for (const p of chunk || []) {
          if (p?.id && !byId.has(p.id)) byId.set(p.id, p);
        }
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  const discovered = Array.from(byId.values());
  if (!discovered.length) return { discovered: 0 };

  const created = await places.upsertPlacesBatch(discovered);
  console.log(`[recs] discovery sweep: fetched=${discovered.length} new=${created}`);
  return { discovered: discovered.length, created };
}

/**
 * Ensures a preference-matched pool of size >= desiredMin.
 * If local DB doesn't have enough matches, performs a discovery sweep then refreshes.
 */
async function ensurePreferredPool(lat, lng, user, desiredMin = 60) {
  // Step 1: DB-first pool near the user
  const dbPool = await places.ensureNearbyRestaurants(
    lat,
    lng,
    Math.max(desiredMin, 100)
  );
  let filtered = filterAndPrioritizeByPreferences(
    dbPool,
    user,
    lat,
    lng,
    desiredMin
  );

  if (filtered.length >= desiredMin) return filtered;

  // Step 2: Discover more around the area (POPULARITY + DISTANCE; restaurant-only)
  await discoverAndIngestAround(lat, lng, {
    cellRadiusMeters: 3000,
    rankPrefs: ["POPULARITY", "DISTANCE"],
    includeTypes: [["restaurant"]],
  });

  // Step 3: Refresh pool and re-filter
  const refreshed = await places.ensureNearbyRestaurants(
    lat,
    lng,
    Math.max(desiredMin, 100)
  );
  filtered = filterAndPrioritizeByPreferences(
    refreshed,
    user,
    lat,
    lng,
    desiredMin
  );
  if (filtered.length >= desiredMin) return filtered;

  // Step 4 (optional): try adjacent food types to widen the net a bit
  await discoverAndIngestAround(lat, lng, {
    cellRadiusMeters: 3000,
    rankPrefs: ["POPULARITY"],
    includeTypes: [
      ["cafe"],
      ["meal_takeaway"],
      ["meal_delivery"],
      ["bar"],
      ["food_court"],
    ],
  });

  const finalPool = await places.ensureNearbyRestaurants(
    lat,
    lng,
    Math.max(desiredMin, 120)
  );
  return filterAndPrioritizeByPreferences(finalPool, user, lat, lng, desiredMin);
}

// ---------- routes ----------

// Resolve restaurant names (and a few fields) for a list of IDs (POST)
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
      },
    });

    const items = rows.map((r) => ({
      id: r.id,
      name: r.name,
      editorialSummary: r.editorialSummary || null,
      editorial_summary: r.editorialSummary || null, // legacy alias retained for client compatibility
      address: r.formattedAddress,
      priceLevel: r.priceLevel ?? null,
      photoUrl: r.photos?.[0]?.name
        ? `${BACKEND_PUBLIC_URL}/api/recs/photo?name=${encodeURIComponent(
            r.photos[0].name
          )}&w=1200`
        : null,
    }));

    res.json({ items });
  } catch (e) {
    console.error("recs/lookup POST error:", e);
    res.status(500).json({ error: "lookup failed" });
  }
});

/* ───────────────────────── Everything below needs auth ───────────────────── */
router.use(verifyFirebaseToken);

// Start a swipe/recs session
router.post("/start", async (req, res) => {
  try {
    const uid = req.user.uid;
    const { lat, lng, minPool = 100 } = req.body || {};
    if (typeof lat !== "number" || typeof lng !== "number") {
      return res.status(400).json({ error: "lat/lng required" });
    }

    const user = await prisma.user.findUnique({ where: { firebaseUid: uid } });
    if (!user) return res.status(404).json({ error: "User not found. Sync profile first." });

    // Reuses the latest active session to preserve interaction context across calls.
    let session = await prisma.swipeSession.findFirst({
      where: { userId: user.id, status: "active" },
      orderBy: { startedAt: "desc" },
      include: { events: true },
    });
    if (!session) {
      session = await prisma.swipeSession.create({ data: { userId: user.id } });
    }

    // Ensure we have enough preference-matched items; this will trigger discovery if needed.
    const filteredPool = await ensurePreferredPool(lat, lng, user, Math.max(60, minPool));
    const pool = filteredPool; // for logging parity below

    console.log(
      `[recs/start] user=${user.id} pool=${pool.length} prefPool=${filteredPool.length}`
    );

    // Warms the ranker with a batch of items. Failures are ignored to keep the endpoint responsive.
    try {
      const items = filteredPool.slice(0, 200).map((r) => {
        const dist = haversineKm(
          { lat, lng },
          { lat: asFloat(r.latitude), lng: asFloat(r.longitude) }
        );
        return {
          id: r.id,
          priceLevel: r.priceLevel ?? null,
          distanceKm: dist,
          features: [
            `price:${r.priceLevel ?? 0}`,
            `dist:${distanceBand(dist)}`,
            ...(r.primaryType ? [`type:${r.primaryType}`] : []),
            ...(Array.isArray(r.types) ? r.types.map((t) => `type:${t}`) : []),
          ],
        };
      });
      const userFeatures = [
        `uband:${priceBandFromBudget(user.budgetMax ?? null)}`,
        ...(user.preferredCuisines || []).map((c) => `ucuisine:${c}`),
        ...(user.dietaryNeeds || []).map((d) => `udiet:${d}`),
      ];
      fetch(`${RECS_SERVICE_URL}/rank`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user: { id: user.id, features: userFeatures },
          items,
          interactions: [],
        }),
      }).catch(() => {});
    } catch {
      // best-effort
    }

    res.json({ sessionId: session.id });
  } catch (e) {
    console.error("recs/start error:", e);
    res.status(500).json({ error: "start failed" });
  }
});

// Next cards – ranker optional, robust fallback
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

    // Ensure we have enough preference-matched candidates; triggers discovery if needed.
    const prefPool = await ensurePreferredPool(lat, lng, user, 100);
    // (Optional) raw pool for logging only
    const pool = await places.ensureNearbyRestaurants(lat, lng, 100);

    const swipedIds = new Set(session.events.map((e) => e.restaurantId));
    const candidates = prefPool.filter((r) => !swipedIds.has(r.id));

    const finalPool = candidates.length ? candidates : pool.filter((r) => !swipedIds.has(r.id));
    if (!finalPool.length) {
      console.log(`[recs/next] user=${user.id} cand=0 → returning empty`);
      return res.json({ items: [] });
    }

    const items = finalPool.map((r) => {
      const dist = haversineKm(
        { lat, lng },
        { lat: asFloat(r.latitude), lng: asFloat(r.longitude) }
      );
      return {
        id: r.id,
        priceLevel: r.priceLevel ?? null,
        distanceKm: dist,
        features: [
          `price:${r.priceLevel ?? 0}`,
          `dist:${distanceBand(dist)}`,
          ...(r.primaryType ? [`type:${r.primaryType}`] : []),
          ...(Array.isArray(r.types) ? r.types.map((t) => `type:${t}`) : []),
        ],
      };
    });

    const interactions = session.events.map((e) => ({
      userId: user.id,
      itemId: e.restaurantId,
      action: e.action,
    }));

    let wantIds = items.slice(0, Math.max(1, Number(limit))).map((x) => x.id);
    try {
      const r = await fetch(`${RECS_SERVICE_URL}/rank`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user: {
            id: user.id,
            features: [
              `uband:${priceBandFromBudget(user.budgetMax ?? null)}`,
              ...(user.preferredCuisines || []).map((c) => `ucuisine:${c}`),
              ...(user.dietaryNeeds || []).map((d) => `udiet:${d}`),
            ],
          },
          items,
          interactions,
        }),
      });
      if (r.ok) {
        const ranked = await r.json();
        const candidateSet = new Set(finalPool.map((x) => x.id));
        const safe = (ranked.rankings || []).filter((id) => candidateSet.has(id));
        wantIds = (safe.length ? safe : wantIds).slice(0, Math.max(1, Number(limit)));
      }
    } catch {
      // best-effort
    }

    let full = await prisma.restaurant.findMany({
      where: { id: { in: wantIds } },
      include: { photos: { take: 1 } },
    });

    if (full.length < wantIds.length) {
      const need = Math.max(1, Number(limit)) - full.length;
      const missing = finalPool.filter((r) => !wantIds.includes(r.id)).slice(0, need);
      if (missing.length) {
        const extra = await prisma.restaurant.findMany({
          where: { id: { in: missing.map((m) => m.id) } },
          include: { photos: { take: 1 } },
        });
        full = [...full, ...extra];
      }
    }

    const order = new Map(wantIds.map((id, i) => [id, i]));
    full.sort((a, b) => (order.get(a.id) ?? 9999) - (order.get(b.id) ?? 9999));

    const clientItems = full.map((r) => {
      const photoName = r.photos?.[0]?.name || null;
      const photoUrl = photoName
        ? `${BACKEND_PUBLIC_URL}/api/recs/photo?name=${encodeURIComponent(photoName)}&w=1200`
        : null;
      const dist = haversineKm(
        { lat, lng },
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
        editorial_summary: r.editorialSummary || null, // alias for older clients
      };
    });

    console.log(
      `[recs/next] user=${user.id} nearby=${pool.length} pref=${prefPool.length} cand=${candidates.length} returned=${clientItems.length}`
    );

    res.json({ items: clientItems });
  } catch (e) {
    console.error("recs/next error:", e);
    res.status(500).json({ error: "next failed" });
  }
});

// Feedback / finalize / winner
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

    const nextCount = (session.totalSwipes ?? session.events.length) + 1;
    const shouldRerank = nextCount % 5 === 0;
    const shouldSuggestMatch = nextCount >= 15;

    res.json({ ok: true, shouldRerank, shouldSuggestMatch });
  } catch (e) {
    console.error("recs/feedback error:", e);
    res.status(500).json({ error: "feedback failed" });
  }
});

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

    // Hydrates the winner so the client can render without a second network call.
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
          editorial_summary: r.editorialSummary || null, // alias
          photoUrl,
        },
    });
  } catch (e) {
    console.error("recs/winner error:", e);
    res.status(500).json({ error: "winner failed" });
  }
});

module.exports = router;
