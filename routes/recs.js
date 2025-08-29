// routes/recs.js
// HTTP orchestration for recs. Places ingest/backfill in services/placesService.
// Geo/price helpers live in utils.

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

// Configuration pulled once at boot
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

const places = createPlacesService({ prisma, googleApiKey: GOOGLE_API_KEY });

// Mount the photo proxy: client calls /api/recs/photo
router.use(photoProxyRouter);

/* ───────────────────────── Router-local helpers ───────────────────────── */

const norm = (s) => String(s || "").toLowerCase().replace(/[_\s-]+/g, " ").trim();
const lc = (s) => String(s || "").toLowerCase();

// Cuisine keyword map (primaryType, types, display name, and name are checked)
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
  // Fast Food — match the word "fast" anywhere across primary/type/display/name.
  "fast food": ["fast"],
  fastfood: ["fast"], // tolerate legacy key
};

function cuisineKeywordsFromUser(user) {
  const out = new Set();
  for (const p of user?.preferredCuisines || []) {
    const key = norm(p);
    (CUISINE_KEYWORDS[key] || [key]).forEach((k) => out.add(k));
  }
  return out;
}

// Explicitly checks primaryType, types[], primaryTypeDisplayName, AND name
function restaurantMatchesCuisine(r, keywordSet) {
  if (!keywordSet || !keywordSet.size) return true;

  const primary = lc(r.primaryType);
  const types = Array.isArray(r.types) ? r.types.map((t) => lc(String(t))) : [];
  const display = lc(r.primaryTypeDisplayName);
  const name = lc(r.name);

  for (const k of keywordSet) {
    const needle = k.replace(/\s+/g, "_"); // e.g., "middle eastern" -> "middle_eastern"
    if (primary.includes(needle)) return true;
    if (types.some((t) => t.includes(needle))) return true;
    if (display.includes(k)) return true;
    if (name.includes(k)) return true; // 👈 name scan
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
  if (user?.searchDistance === null) return 50; // “Unlimited” → reasonable cap
  if (typeof user?.searchDistance === "number" && user.searchDistance > 0) return user.searchDistance;
  return 15; // default
}

function textIncludesAny(r, needles) {
  const fields = [
    lc(r.name),
    lc(r.primaryTypeDisplayName),
    lc(r.editorialSummary),
    lc(r.editorial_summary),
    ...(Array.isArray(r.types) ? r.types.map(lc) : []),
  ].filter(Boolean);
  return needles.some((n) => fields.some((f) => f.includes(n)));
}

// Requirements from UI’s “dietaryNeeds”
function requirementsFromUser(user) {
  const needs = new Set((user?.dietaryNeeds || []).map((x) => norm(x)));
  return {
    vegetarian: needs.has("vegetarian"),
    petFriendly: needs.has("pet friendly"),
    parking: needs.has("parking"),
  };
}

// Strict requirement checks (NEVER relaxed)
function restaurantMeetsRequirements(r, req) {
  // Vegetarian
  if (req.vegetarian) {
    const hasField =
      r.servesVegetarian === true || r.servesVegetarianFood === true || r.serves_vegetarian === true;
    const hasType = Array.isArray(r.types) && r.types.map(lc).includes("vegetarian_restaurant");
    const hasText = textIncludesAny(r, ["vegetarian", "vegan"]);
    if (!(hasField || hasType || hasText)) return false;
  }

  // Pet friendly
  if (req.petFriendly) {
    const hasField = r.allowsDogs === true || r.allows_dogs === true;
    const hasText = textIncludesAny(r, ["dog friendly", "pet friendly", "dogs welcome"]);
    if (!(hasField || hasText)) return false;
  }

  // Parking
  if (req.parking) {
    const hasStructured =
      r.parkingOptions && typeof r.parkingOptions === "object"
        ? Object.values(r.parkingOptions).some(Boolean)
        : !!r.parkingOptions || r.hasParking === true;
    const hasText = textIncludesAny(r, ["parking", "car park", "parking lot"]);
    if (!(hasStructured || hasText)) return false;
  }

  return true;
}

/**
 * STRICT Preference filter:
 * 1) Hard filter by REQUIREMENTS (if any).
 * 2) Within those, list CUISINE matches by distance first.
 * 3) Then fill with the nearest (still meeting requirements).
 * Never returns items that violate requirements.
 */
function filterAndPrioritizeByPreferences(pool, user, lat, lng, desiredMin = 60, radiusKm = 15) {
  const keys = cuisineKeywordsFromUser(user);
  const req = requirementsFromUser(user);

  const here = { lat, lng };
  const withDist = pool.map((r) => ({
    r,
    d: haversineKm(here, { lat: asFloat(r.latitude), lng: asFloat(r.longitude) }),
  }));

  // Respect radius
  const within = Number.isFinite(radiusKm) ? withDist.filter((x) => x.d <= radiusKm) : withDist;

  // STRICT: filter by requirements (or pass-through if none selected)
  const reqRows = (req.vegetarian || req.petFriendly || req.parking)
    ? within.filter(({ r }) => restaurantMeetsRequirements(r, req))
    : within;

  // Prefer cuisine matches
  const cuisineRows = reqRows.filter(({ r }) => restaurantMatchesCuisine(r, keys));
  const nonCuisineRows = reqRows.filter(({ r }) => !restaurantMatchesCuisine(r, keys));

  const sortedCuisine = cuisineRows.sort((a, b) => a.d - b.d).map((x) => x.r);
  const sortedNearest = nonCuisineRows.sort((a, b) => a.d - b.d).map((x) => x.r);

  const merged = [...sortedCuisine, ...sortedNearest];

  // Return ONLY requirement-compliant items; no relaxation.
  return merged.slice(0, Math.max(1, desiredMin));
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
          Math.cos(angDist) - Math.sin(lat1) * Math.sin(lat2) // <-- FIX: angDist
        );
      centers.push({ lat: toDeg(lat2), lng: toDeg(lon2) });
    }
  }
  return centers;
}

/**
 * Discovery sweep around a point. If `biasKeywords` provided, add extra passes that use
 * Google keyword/text biasing (via places service).
 */
async function discoverAndIngestAround(
  lat,
  lng,
  {
    cellRadiusMeters = 3000,
    rankPrefs = ["POPULARITY", "DISTANCE"],
    includeTypes = [["restaurant"]],
    maxCenters = 18,
    delayMs = 120,
    biasKeywords = [], // 👈 NEW
  } = {}
) {
  const centers = generateRingCenters(lat, lng, 2, 12, 2).slice(0, maxCenters);
  const byId = new Map();

  // (A) Standard nearby passes
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

  // (B) Biased passes (text/keyword biasing) — only if we have requirement hints
  for (const c of centers) {
    for (const kw of biasKeywords) {
      // Try text-bias search via the service (falls back to keyword if supported).
      const chunk = await places.googlePlacesSearchNearby(c.lat, c.lng, {
        radiusMeters: cellRadiusMeters,
        maxPages: 2,
        rankPreference: "POPULARITY",
        includedTypes: ["restaurant"],
        keyword: kw, // 👈 NEW (service will route to text search if needed)
      });
      for (const p of chunk || []) {
        if (p?.id && !byId.has(p.id)) byId.set(p.id, p);
      }
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  const discovered = Array.from(byId.values());
  if (!discovered.length) return { discovered: 0 };

  const created = await places.upsertPlacesBatch(discovered);
  console.log(
    `[recs] discovery sweep: fetched=${discovered.length} (biased=${biasKeywords.length > 0}) new=${created}`
  );
  return { discovered: discovered.length, created };
}

/**
 * Ensures a preference-matched pool (STRICT requirements).
 * We may do discovery to enlarge the pool, but we still hard-filter by requirements afterwards.
 */
async function ensurePreferredPool(lat, lng, user, desiredMin = 60) {
  const radiusKm = radiusFromUser(user);
  const req = requirementsFromUser(user);

  // Bias keywords derived from requirements
  const biasKeywords = [];
  if (req.vegetarian) biasKeywords.push("vegetarian", "vegan");
  if (req.petFriendly) biasKeywords.push("dog friendly", "pet friendly");
  if (req.parking) biasKeywords.push("parking");

  // Step 1: DB-first pool near the user
  const dbPool = await places.ensureNearbyRestaurants(
    lat, lng, Math.max(desiredMin, 120), radiusKm
  );
  let filtered = filterAndPrioritizeByPreferences(dbPool, user, lat, lng, desiredMin, radiusKm);
  if (filtered.length >= desiredMin) return filtered;

  // Step 2: Discover more around the area (restaurant-only), with bias if applicable
  await discoverAndIngestAround(lat, lng, {
    cellRadiusMeters: Math.round(radiusKm * 1000) || 3000,
    rankPrefs: ["POPULARITY", "DISTANCE"],
    includeTypes: [["restaurant"]],
    biasKeywords, // 👈 NEW
  });

  // Step 3: Refresh and filter again (still STRICT)
  const refreshed = await places.ensureNearbyRestaurants(
    lat, lng, Math.max(desiredMin, 150), radiusKm
  );
  filtered = filterAndPrioritizeByPreferences(refreshed, user, lat, lng, desiredMin, radiusKm);

  // No relaxing of requirements—return whatever we have (may be < desiredMin).
  return filtered;
}

/* ─────────────── Session variety helpers ─────────────── */

function hash32(str) {
  // FNV-1a 32-bit
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
function seededScore(id, sessionId) {
  return hash32(String(id) + "|" + String(sessionId)) / 0x100000000; // 0..1
}
function reorderWithSessionSeed(ids, sessionId, prevSeenSet) {
  const rows = ids.map((id) => ({
    id,
    seen: prevSeenSet?.has(id) ? 1 : 0, // unseen first
    rnd: seededScore(id, sessionId),
  }));
  rows.sort((a, b) => (a.seen - b.seen) || (a.rnd - b.rnd));
  return rows.map((r) => r.id);
}

/* ───────────────────────────── Routes ───────────────────────────── */

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
      editorial_summary: r.editorialSummary || null, // legacy alias for clients
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

    // Reuse the latest active session to preserve interaction context.
    let session = await prisma.swipeSession.findFirst({
      where: { userId: user.id, status: "active" },
      orderBy: { startedAt: "desc" },
      include: { events: true },
    });
    if (!session) {
      session = await prisma.swipeSession.create({ data: { userId: user.id } });
    }

    // Ensure enough STRICT requirement-compliant items (discovery may run inside)
    const filteredPool = await ensurePreferredPool(lat, lng, user, Math.max(60, minPool));
    const pool = filteredPool;

    console.log(`[recs/start] user=${user.id} pool=${pool.length} strictPool=${filteredPool.length}`);

    // Warm the ranker (best-effort)
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
        ...(user.dietaryNeeds || []).map((d) => `ureq:${d}`), // strict requirements as features
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

// Next cards – ranker optional, session-seeded order, prev-session demotion, STRICT requirements
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

    // If session already completed, don't serve more items
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

    // Previous session → demote its items to the end (not exclude)
    const prevSession = await prisma.swipeSession.findFirst({
      where: { userId: user.id, id: { not: sessionId }, endedAt: { not: null } },
      orderBy: { startedAt: "desc" },
      include: { events: { select: { restaurantId: true } } },
    });
    const prevSeenSet = new Set((prevSession?.events || []).map((e) => e.restaurantId));

    // STRICT requirement-compliant pool
    const prefPool = await ensurePreferredPool(lat, lng, user, 100);

    // Raw pool (respect radius) only for logging/fallback if something goes wrong upstream
    const radiusKm = radiusFromUser(user);
    const pool = await places.ensureNearbyRestaurants(lat, lng, 100, radiusKm);

    const swipedIds = new Set(session.events.map((e) => e.restaurantId));
    const exclude = new Set(Array.isArray(excludeIds) ? excludeIds.filter(Boolean) : []);

    const finalPool = prefPool.filter((r) => !swipedIds.has(r.id) && !exclude.has(r.id));
    if (!finalPool.length) {
      console.log(`[recs/next] user=${user.id} cand=0 (strict) → returning empty`);
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

    // Start from a session-seeded order (and demote prev-seen)
    let wantIds = reorderWithSessionSeed(
      items.slice(0, Math.max(1, Number(limit) * 4)).map((x) => x.id),
      sessionId,
      prevSeenSet
    ).slice(0, Math.max(1, Number(limit)));

    // Try ranker; then re-apply session variety + demotion
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
          (safe.length ? safe : wantIds).slice(0, Math.max(1, Number(limit) * 4)),
          sessionId,
          prevSeenSet
        ).slice(0, Math.max(1, Number(limit)));
      }
    } catch {}

    // Load rows (keep order)
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
        // expose booleans for client badges
        servesVegetarian: (r.servesVegetarian ?? r.servesVegetarianFood ?? r.serves_vegetarian) ?? null,
        allowsDogs: (r.allowsDogs ?? r.allows_dogs) ?? null,
      };
    });

    console.log(
      `[recs/next] user=${user.id} nearby=${pool.length} strictPref=${prefPool.length} cand=${finalPool.length} prevSeen=${prevSeenSet.size} returned=${clientItems.length}`
    );

    res.json({ items: clientItems });
  } catch (e) {
    console.error("recs/next error:", e);
    res.status(500).json({ error: "next failed" });
  }
});

// Feedback / finalize / winner (unchanged below)
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
