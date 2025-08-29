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

// Use global fetch if present; otherwise dynamically import node-fetch (ESM) from CJS for ranker calls.
const fetchFn =
  (typeof fetch === "function" && fetch) ||
  ((...args) => import("node-fetch").then((mod) => mod.default(...args)));

const router = express.Router();

/* ───────────────────────── Public routes (no auth) ───────────────────────── */

router.get("/__ping", (_req, res) => res.json({ ok: true, via: "recs", ts: Date.now() }));
router.get("/health", (_req, res) => res.json({ ok: true }));

// Configuration pulled once at boot to avoid re-reading env on every request.
const RECS_SERVICE_URL =
  process.env.RECS_SERVICE_URL || process.env.RECS_URL || "http://127.0.0.1:8000";
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const BACKEND_PUBLIC_URL = process.env.BACKEND_PUBLIC_URL || "https://2eatapp.com";

const MAX_SWIPES_PER_SESSION = Number(process.env.MAX_SWIPES_PER_SESSION || 15);
const EARLY_END_ON_SUPERSTAR = process.env.END_ON_SUPERSTAR === "1";

console.log("[recs] BOOT", {
  HAS_GOOGLE_API_KEY: !!GOOGLE_API_KEY,
  RECS_SERVICE_URL,
  BACKEND_PUBLIC_URL,
  MAX_SWIPES_PER_SESSION,
  EARLY_END_ON_SUPERSTAR,
});

// Initializes the Places service with its dependencies. This allows swapping/mocking in tests.
const places = createPlacesService({ prisma, googleApiKey: GOOGLE_API_KEY });

// Mount photo proxy
router.use(photoProxyRouter);

/* ───────────────────────── Router-local helpers ───────────────────────── */

const norm = (s) => String(s || "").toLowerCase().replace(/[_\s-]+/g, " ").trim();
const lc = (s) => String(s || "").toLowerCase();

const CUISINE_KEYWORDS = {
  indian: ["indian"],
  chinese: ["chinese", "szechuan", "sichuan", "cantonese", "hunan"],
  italian: ["italian", "pizza", "pasta", "sicilian", "tuscan"],
  japanese: ["japanese", "sushi", "ramen", "izakaya"],
  thai: ["thai"],
  mexican: ["mexican", "taqueria", "taco"],
  korean: ["korean", "bbq"],
  american: ["american", "burger", "bbq", "diner"],
  vietnamese: ["vietnamese", "pho", "banh mi", "bahn mi"],
  mediterranean: ["mediterranean", "greek", "turkish", "lebanese"],
  "middle eastern": ["middle eastern", "lebanese", "turkish", "persian", "iranian"],
  spanish: ["spanish", "tapas"],
  french: ["french", "bistro", "brasserie"],
  greek: ["greek"],
  turkish: ["turkish"],
  lebanese: ["lebanese"],
  persian: ["persian", "iranian"],
  "fast food": ["fast"],
  fastfood: ["fast"],
};

function cuisineKeywordsFromUser(user) {
  const out = new Set();
  for (const p of user?.preferredCuisines || []) {
    const key = norm(p);
    (CUISINE_KEYWORDS[key] || [key]).forEach((k) => out.add(k));
  }
  return out;
}

// NOW also scans the restaurant name explicitly
function restaurantMatchesCuisine(r, keywordSet) {
  if (!keywordSet || !keywordSet.size) return true;
  const primary = lc(r.primaryType);
  const types = Array.isArray(r.types) ? r.types.map((t) => lc(String(t))) : [];
  const display = lc(r.primaryTypeDisplayName);
  const name = lc(r.name);

  for (const k of keywordSet) {
    const needle = k.replace(/\s+/g, "_");
    if (primary.includes(needle)) return true;
    if (types.some((t) => t.includes(needle))) return true;
    if (display.includes(k)) return true;
    if (name.includes(k)) return true; // 👈 explicit name scan
  }
  return false;
}

function priceBandFromBudget(budgetMax) {
  if (budgetMax == null) return 0;
  if (budgetMax <= 15) return 1;
  if (budgetMax <= 30) return 2;
  if (budgetMax <= 60) return 3;
  return 4;
}

function radiusFromUser(user) {
  if (user?.searchDistance === null) return 50;
  if (typeof user?.searchDistance === "number" && user.searchDistance > 0) return user.searchDistance;
  return 15;
}

function textIncludesAny(r, needles) {
  const fields = [lc(r.name), lc(r.primaryTypeDisplayName), lc(r.editorialSummary)].filter(Boolean);
  return needles.some((n) => fields.some((f) => f.includes(n)));
}

function requirementsFromUser(user) {
  const needs = new Set((user?.dietaryNeeds || []).map((x) => norm(x)));
  return {
    vegetarian: needs.has("vegetarian"),
    petFriendly: needs.has("pet friendly"),
    parking: needs.has("parking"),
  };
}

function restaurantMeetsRequirements(r, req) {
  let ok = true;

  if (req.vegetarian) {
    const hasField = r.servesVegetarian === true; // DB serves_vegetarian -> prisma servesVegetarian
    const hasType = Array.isArray(r.types) && r.types.map(lc).includes("vegetarian_restaurant");
    const hasText = textIncludesAny(r, ["vegetarian", "vegan"]);
    ok = ok && (hasField || hasType || hasText);
  }

  if (req.petFriendly) {
    const hasField = r.allowsDogs === true; // DB allows_dogs -> prisma allowsDogs
    const hasText = textIncludesAny(r, ["dog friendly", "pet friendly", "dogs welcome"]);
    ok = ok && (hasField || hasText);
  }

  if (req.parking) {
    const hasStructured =
      r.parkingOptions && typeof r.parkingOptions === "object"
        ? Object.values(r.parkingOptions).some(Boolean)
        : !!r.parkingOptions;
    const hasText = textIncludesAny(r, ["parking", "car park", "parking lot"]);
    ok = ok && (hasStructured || hasText);
  }

  return ok;
}

/**
 * Preference filter:
 * 1) Enforce requirements first (hard filter).
 * 2) Within those, prefer cuisine matches by distance; then nearest non-cuisine (still meeting requirements).
 * 3) If still short, relax requirements (cuisine first, then nearest).
 * Always respects the user's radius (km).
 */
function filterAndPrioritizeByPreferences(pool, user, lat, lng, desiredMin = 60, radiusKm = 15) {
  const keys = cuisineKeywordsFromUser(user);
  const req = requirementsFromUser(user);
  const hasAnyReq = req.vegetarian || req.petFriendly || req.parking;

  const here = { lat, lng };
  const withDist = pool.map((r) => ({
    r,
    d: haversineKm(here, { lat: asFloat(r.latitude), lng: asFloat(r.longitude) }),
  }));

  const within = Number.isFinite(radiusKm) ? withDist.filter((x) => x.d <= radiusKm) : withDist;

  const byCuisine = (rows) =>
    rows
      .filter(({ r }) => restaurantMatchesCuisine(r, keys))
      .sort((a, b) => a.d - b.d)
      .map((x) => x.r);

  const byNearest = (rows) => rows.sort((a, b) => a.d - b.d).map((x) => x.r);

  const reqRows = hasAnyReq ? within.filter(({ r }) => restaurantMeetsRequirements(r, req)) : within;
  const nonReqRows = hasAnyReq ? within.filter(({ r }) => !restaurantMeetsRequirements(r, req)) : [];

  let merged = [];

  // Fill from requirement-compliant rows first (cuisine-pref)
  const reqCuisine = byCuisine(reqRows);
  merged.push(...reqCuisine);

  if (merged.length < desiredMin) {
    const reqNearest = byNearest(reqRows).filter((r) => !merged.includes(r));
    merged.push(...reqNearest);
  }

  // Relax requirements if still short (cuisine first, then nearest)
  if (merged.length < desiredMin && nonReqRows.length) {
    const nonReqCuisine = byCuisine(nonReqRows).filter((r) => !merged.includes(r));
    merged.push(...nonReqCuisine);
    if (merged.length < desiredMin) {
      const nonReqNearest = byNearest(nonReqRows).filter((r) => !merged.includes(r));
      merged.push(...nonReqNearest);
    }
  }

  if (!merged.length) merged = byNearest(within);

  return merged.slice(0, Math.max(desiredMin, 1));
}

/* ─────────── Targeted discovery when requirement-matches are scarce ─────────── */

function cuisineQueriesFromUser(user) {
  const keys = Array.from(cuisineKeywordsFromUser(user));
  // Turn needles into “X restaurant” queries
  const labels = [];
  for (const k of keys) {
    if (k === "fast") {
      labels.push("fast food restaurant");
    } else {
      labels.push(`${k} restaurant`);
    }
  }
  return labels;
}

// This uses places.googlePlacesSearchText (added in placesService) to fetch
// extra candidates specifically for Requirements/cuisines, then upserts them.
async function targetedRequirementDiscovery(lat, lng, user, radiusKm) {
  const req = requirementsFromUser(user);
  const queries = new Set();

  // Cuisine-specific
  for (const q of cuisineQueriesFromUser(user)) queries.add(q);

  // Requirements-specific
  if (req.vegetarian) {
    queries.add("vegetarian restaurant");
    queries.add("vegan restaurant");
  }
  if (req.petFriendly) {
    queries.add("dog friendly restaurant");
    queries.add("pet friendly restaurant");
  }
  if (req.parking) {
    queries.add("restaurant parking");
    queries.add("car park restaurant");
  }

  if (queries.size === 0) return { discovered: 0, created: 0 };

  // Bias radius to user radius (cap 20km for sanity)
  const radiusMeters = Math.max(1500, Math.min(20000, Math.round((radiusKm || 8) * 1000)));

  const batches = [];
  for (const textQuery of queries) {
    // limit the number of queries to avoid quota burn
    if (batches.length >= 12) break;
    batches.push(places.googlePlacesSearchText(textQuery, {
      latitude: lat,
      longitude: lng,
      radiusMeters,
      maxResults: 20,
    }));
  }

  const results = (await Promise.allSettled(batches))
    .flatMap((p) => (p.status === "fulfilled" ? p.value || [] : []));
  const byId = new Map();
  for (const p of results) if (p?.id && !byId.has(p.id)) byId.set(p.id, p);

  const unique = Array.from(byId.values());
  if (!unique.length) return { discovered: 0, created: 0 };

  const created = await places.upsertPlacesBatch(unique);
  console.log(`[recs] targeted discovery: queries=${queries.size} fetched=${unique.length} new=${created}`);
  return { discovered: unique.length, created };
}

/* ─────────── Discovery helpers (router-level, integrate with places service) ─────────── */

function generateRingCenters(lat, lng, minKm = 2, maxKm = 12, stepKm = 2) {
  const centers = [];
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const earthKm = 6371;
  const lat1 = toRad(lat);
  const lon1 = toRad(lng);

  for (let r = minKm; r <= maxKm; r += stepKm) {
    const circumference = 2 * Math.PI * r;
    const points = Math.max(6, Math.round(circumference / stepKm));
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
    maxCenters = 18,
    delayMs = 120,
  } = {}
) {
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
 * If local DB doesn't have enough matches, performs discovery (generic + targeted for requirements),
 * then refreshes and re-filters.
 */
async function ensurePreferredPool(lat, lng, user, desiredMin = 60) {
  const radiusKm = radiusFromUser(user);
  const req = requirementsFromUser(user);

  // Step 1: DB-first pool near the user
  const dbPool = await places.ensureNearbyRestaurants(
    lat,
    lng,
    Math.max(desiredMin, 100),
    radiusKm
  );
  let filtered = filterAndPrioritizeByPreferences(
    dbPool,
    user,
    lat,
    lng,
    desiredMin,
    radiusKm
  );

  // If we already have enough, done.
  if (filtered.length >= desiredMin) return filtered;

  // Step 2a: If requirements were set and compliant rows are scarce, try targeted text discovery first.
  const hasAnyReq = req.vegetarian || req.petFriendly || req.parking;
  if (hasAnyReq) {
    await targetedRequirementDiscovery(lat, lng, user, radiusKm);
  }

  // Step 2b: Generic discovery around the area (POPULARITY + DISTANCE; restaurant-only)
  await discoverAndIngestAround(lat, lng, {
    cellRadiusMeters: Math.round(radiusKm * 1000) || 3000,
    rankPrefs: ["POPULARITY", "DISTANCE"],
    includeTypes: [["restaurant"]],
  });

  // Step 3: Refresh pool and re-filter
  const refreshed = await places.ensureNearbyRestaurants(
    lat,
    lng,
    Math.max(desiredMin, 120),
    radiusKm
  );
  filtered = filterAndPrioritizeByPreferences(
    refreshed,
    user,
    lat,
    lng,
    desiredMin,
    radiusKm
  );
  if (filtered.length >= desiredMin) return filtered;

  // Step 4 (optional): widen the net a bit
  await discoverAndIngestAround(lat, lng, {
    cellRadiusMeters: Math.round(radiusKm * 1000) || 3000,
    rankPrefs: ["POPULARITY"],
    includeTypes: [["cafe"], ["meal_takeaway"], ["meal_delivery"], ["bar"], ["food_court"]],
  });

  const finalPool = await places.ensureNearbyRestaurants(
    lat,
    lng,
    Math.max(desiredMin, 140),
    radiusKm
  );
  return filterAndPrioritizeByPreferences(finalPool, user, lat, lng, desiredMin, radiusKm);
}

/* ─────────────── Utilities to vary order across sessions ─────────────── */

function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
function seededScore(id, sessionId) {
  return hash32(String(id) + "|" + String(sessionId)) / 0x100000000;
}
function reorderWithSessionSeed(ids, sessionId, prevSeenSet) {
  const rows = ids.map((id) => ({
    id,
    seen: prevSeenSet?.has(id) ? 1 : 0,
    rnd: seededScore(id, sessionId),
  }));
  rows.sort((a, b) => (a.seen - b.seen) || (a.rnd - b.rnd));
  return rows.map((r) => r.id);
}

/* ───────────────────────────── Routes ───────────────────────────── */

// Resolve restaurant names (and a few fields) for a list of IDs
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
      editorial_summary: r.editorialSummary || null,
      address: r.formattedAddress,
      priceLevel: r.priceLevel ?? null,
      photoUrl: r.photos?.[0]?.name
        ? `${BACKEND_PUBLIC_URL}/api/recs/photo?name=${encodeURIComponent(r.photos[0].name)}&w=1200`
        : null,
    }));

    res.json({ items });
  } catch (e) {
    console.error("recs/lookup POST error:", e);
    res.status(500).json({ error: "lookup failed" });
  }
});

router.use(verifyFirebaseToken);

// Start session
router.post("/start", async (req, res) => {
  try {
    const uid = req.user.uid;
    const { lat, lng, minPool = 100 } = req.body || {};
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

    const filteredPool = await ensurePreferredPool(lat, lng, user, Math.max(60, minPool));
    const pool = filteredPool;

    console.log(`[recs/start] user=${user.id} pool=${pool.length} prefPool=${filteredPool.length}`);

    // Warm ranker (best-effort)
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
        ...(user.dietaryNeeds || []).map((d) => `ureq:${d}`),
        `sess:${session.id}`,
      ];
      fetchFn(`${RECS_SERVICE_URL}/rank`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user: { id: user.id, features: userFeatures },
          items,
          interactions: [],
        }),
      }).catch(() => {});
    } catch {}

    res.json({ sessionId: session.id });
  } catch (e) {
    console.error("recs/start error:", e);
    res.status(500).json({ error: "start failed" });
  }
});

// Next cards – seeded reordering & prev-session demotion
router.post("/next", async (req, res) => {
  try {
    const uid = req.user.uid;
    const { sessionId, lat, lng, limit = 1, excludeIds = [] } = req.body || {};
    if (!sessionId || typeof lat !== "number" || typeof lng !== "number") {
      return res.status(400).json({ error: "sessionId, lat, lng required" });
    }

    const user = await prisma.user.findUnique({ where: { firebaseUid: uid } });
    if (!user) return res.status(404).json({ error: "User not found" });

    const session = await prisma.swipeSession.findUnique({
      where: { id: sessionId },
      include: { events: true },
    });
    if (!session || session.userId !== user.id) {
      return res.status(400).json({ error: "Invalid session" });
    }

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

    // Previous session -> demote previously seen (keep available)
    const prevSession = await prisma.swipeSession.findFirst({
      where: { userId: user.id, id: { not: sessionId }, endedAt: { not: null } },
      orderBy: { startedAt: "desc" },
      include: { events: { select: { restaurantId: true } } },
    });
    const prevSeenSet = new Set((prevSession?.events || []).map((e) => e.restaurantId));

    const prefPool = await ensurePreferredPool(lat, lng, user, 100);
    const radiusKm = radiusFromUser(user);
    const pool = await places.ensureNearbyRestaurants(lat, lng, 100, radiusKm);

    const swipedIds = new Set(session.events.map((e) => e.restaurantId));
    const exclude = new Set(Array.isArray(excludeIds) ? excludeIds.filter(Boolean) : []);

    const candidates = prefPool.filter((r) => !swipedIds.has(r.id) && !exclude.has(r.id));
    const fallback = pool.filter((r) => !swipedIds.has(r.id) && !exclude.has(r.id));
    const finalPool = candidates.length ? candidates : fallback;

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

    // Session-seeded ordering (also demote prev-seen)
    let wantIds = reorderWithSessionSeed(
      items.slice(0, Math.max(1, Number(limit * 4))).map((x) => x.id),
      sessionId,
      prevSeenSet
    ).slice(0, Math.max(1, Number(limit)));

    // Ranker (optional) + apply seeded reorder again for variety
    try {
      const r = await fetchFn(`${RECS_SERVICE_URL}/rank`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user: {
            id: user.id,
            features: [
              `uband:${priceBandFromBudget(user.budgetMax ?? null)}`,
              ...(user.preferredCuisines || []).map((c) => `ucuisine:${c}`),
              ...(user.dietaryNeeds || []).map((d) => `ureq:${d}`),
              `sess:${sessionId}`,
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
        wantIds = reorderWithSessionSeed(
          (safe.length ? safe : wantIds).slice(0, Math.max(1, Number(limit * 4))),
          sessionId,
          prevSeenSet
        ).slice(0, Math.max(1, Number(limit)));
      }
    } catch {}

    // Hydrate to client shape
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
        editorial_summary: r.editorialSummary || null,
        servesVegetarian: r.servesVegetarian ?? null,
        allowsDogs: r.allowsDogs ?? null,
      };
    });

    console.log(
      `[recs/next] user=${user.id} nearby=${pool.length} pref=${prefPool.length} returned=${clientItems.length}`
    );

    res.json({ items: clientItems });
  } catch (e) {
    console.error("recs/next error:", e);
    res.status(500).json({ error: "next failed" });
  }
});

// Feedback / finalize / winner unchanged…

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
          editorial_summary: r.editorialSummary || null,
          photoUrl,
        },
    });
  } catch (e) {
    console.error("recs/winner error:", e);
    res.status(500).json({ error: "winner failed" });
  }
});

module.exports = router;
