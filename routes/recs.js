// routes/recs.js
const express = require("express");
const prisma = require("../src/prisma");
const verifyFirebaseToken = require("../middleware/auth");

const photoProxyRouter = require("./photoProxy");
const { createPlacesService } = require("../src/services/placesService");
const { haversineKm, distanceBand, asFloat } = require("../src/utils/geo");
const { normalizePriceLevel, mapPriceLevelEnum } = require("../src/utils/price");

const fetchFn =
  (typeof fetch === "function" && fetch) ||
  ((...args) => import("node-fetch").then((mod) => mod.default(...args)));

const router = express.Router();

router.get("/__ping", (_req, res) => res.json({ ok: true, via: "recs", ts: Date.now() }));
router.get("/health", (_req, res) => res.json({ ok: true }));

const RECS_SERVICE_URL =
  process.env.RECS_SERVICE_URL || process.env.RECS_URL || "http://127.0.0.1:8000";
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const BACKEND_PUBLIC_URL = process.env.BACKEND_PUBLIC_URL || "https://2eatapp.com";

const MAX_SWIPES_PER_SESSION = Number(process.env.MAX_SWIPES_PER_SESSION || 15);
const EARLY_END_ON_SUPERSTAR = process.env.END_ON_SUPERSTAR === "1";

const places = createPlacesService({ prisma, googleApiKey: GOOGLE_API_KEY });

router.use(photoProxyRouter);

/* helpers */

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

function restaurantMatchesCuisine(r, keywordSet) {
  if (!keywordSet || !keywordSet.size) return true;
  const primary = (r.primaryType || "").toLowerCase();
  const types = Array.isArray(r.types) ? r.types.map((t) => String(t).toLowerCase()) : [];
  const searchableText = [r.name, r.primaryTypeDisplayName, r.editorialSummary].filter(Boolean).join(" ").toLowerCase();

  for (const k of keywordSet) {
    const needle = k.replace(/\s+/g, "_");
    if (primary.includes(needle)) return true;
    if (types.some((t) => t.includes(needle))) return true;
    if (searchableText.includes(k)) return true;
  }
  return false;
}


function textIncludesAny(r, needles) {
  const fields = [
    (r.name || "").toLowerCase(),
    (r.primaryTypeDisplayName || "").toLowerCase(),
    (r.editorialSummary || "").toLowerCase(),
    (r.editorial_summary || "").toLowerCase(),
  ].filter(Boolean);
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
    const hasField = r.servesVegetarianFood === true;
    const hasType =
      Array.isArray(r.types) &&
      r.types.map((t) => String(t).toLowerCase()).includes("vegetarian_restaurant");
    const hasText = textIncludesAny(r, ["vegetarian", "vegan", "veg-friendly"]);
    ok = ok && (hasField || hasType || hasText);
  }

  if (req.petFriendly) {
    const hasField = r.allowsDogs === true;
    const hasText = textIncludesAny(r, ["dog friendly", "pet friendly", "dogs welcome"]);
    ok = ok && (hasField || hasText);
  }

  if (req.parking) {
    const hasStructured =
      r.parkingOptions && typeof r.parkingOptions === "object"
        ? Object.values(r.parkingOptions).some(Boolean)
        : false;
    const hasText = textIncludesAny(r, ["parking", "car park", "parking lot"]);
    ok = ok && (hasStructured || hasText);
  }

  return ok;
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

function filterAndPrioritizeByPreferences(pool, user, lat, lng, desiredMin = 60, radiusKm = 15) {
  const keys = cuisineKeywordsFromUser(user);
  const req = requirementsFromUser(user);

  const here = { lat, lng };
  const withDist = pool.map((r) => ({
    r,
    d: haversineKm(here, { lat: asFloat(r.latitude), lng: asFloat(r.longitude) }),
  }));
  const within = Number.isFinite(radiusKm) ? withDist.filter((x) => x.d <= radiusKm) : withDist;

  const baseRows = within.filter(({ r }) => restaurantMeetsRequirements(r, req));

  const cuisineFirst = baseRows
    .filter(({ r }) => restaurantMatchesCuisine(r, keys))
    .sort((a, b) => a.d - b.d)
    .map((x) => x.r);

  const nearestFill = baseRows
    .sort((a, b) => a.d - b.d)
    .map((x) => x.r)
    .filter((r) => !cuisineFirst.includes(r));

  const merged = [...cuisineFirst, ...nearestFill].slice(0, Math.max(desiredMin, 1));
  return merged;
}

/* discovery */

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

function buildBiasQueries(user) {
  const req = requirementsFromUser(user);
  const requirementKeywords = [];
  const queries = new Set();

  if (req.vegetarian) requirementKeywords.push("vegetarian");
  if (req.petFriendly) requirementKeywords.push("pet friendly");
  if (req.parking) requirementKeywords.push("with parking");

  const cuisines = Array.from(cuisineKeywordsFromUser(user));

  // [FIX] Corrected a typo here: `cuines` is now `cuisines`.
  if (requirementKeywords.length > 0 || cuisines.length > 0) {
    const allKeywords = [...cuisines, ...requirementKeywords, "restaurant"];
    queries.add(allKeywords.join(" "));
  }

  if (cuisines.length > 1) {
    queries.add([...cuisines, "restaurant"].join(" "));
  }
  for (const cuisine of cuisines) {
    queries.add(`${cuisine} restaurant`);
  }

  if (requirementKeywords.length > 1) {
    queries.add([...requirementKeywords, "restaurant"].join(" "));
  }
  if (req.vegetarian) queries.add("vegetarian restaurant");
  if (req.petFriendly) queries.add("pet friendly restaurant");
  if (req.parking) queries.add("restaurant with parking");

  if (queries.size === 0) {
    queries.add("restaurant");
  }

  const queryArray = Array.from(queries);
  if (requirementKeywords.length > 0 || cuisines.length > 0) {
      const mostSpecificQuery = [...cuisines, ...requirementKeywords, "restaurant"].join(" ");
      const specificIndex = queryArray.indexOf(mostSpecificQuery);
      if (specificIndex > 0) {
        const [specific] = queryArray.splice(specificIndex, 1);
        queryArray.unshift(specific);
      }
  }

  return queryArray;
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
    biasQueries = [],
  } = {}
) {
  const centers = generateRingCenters(lat, lng, 2, 12, 2).slice(0, maxCenters);
  const byId = new Map();

  for (const c of centers) {
    if (biasQueries.length) {
      for (const q of biasQueries) {
        const chunk = await places.googlePlacesSearchText(q, {
          lat: c.lat,
          lng: c.lng,
          radiusMeters: cellRadiusMeters,
          maxPages: 2,
        });
        for (const p of chunk || []) {
          if (p?.id && !byId.has(p.id)) byId.set(p.id, p);
        }
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      }
    } else {
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
  }

  const discovered = Array.from(byId.values());
  if (!discovered.length) return { discovered: 0 };

  const created = await places.upsertPlacesBatch(discovered);
  console.log(
    `[recs] discovery sweep: fetched=${discovered.length} (biased=${biasQueries.length > 0}) new=${created}`
  );
  return { discovered: discovered.length, created };
}

/* pool builder + shuffle */

function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

async function ensurePreferredPool(lat, lng, user, desiredMin = 60) {
  const baseRadius = radiusFromUser(user);
  const expansion = [baseRadius, Math.max(baseRadius, 5), 10, 15, 20, 30, 50];
  const req = requirementsFromUser(user);
  const biasQueries = buildBiasQueries(user);

  const acc = new Map();

  for (const radiusKm of expansion) {
    const dbPool = await places.ensureNearbyRestaurantsStrict(
      lat,
      lng,
      Math.max(desiredMin, 200),
      radiusKm,
      req
    );

    const filtered = filterAndPrioritizeByPreferences(
      dbPool,
      user,
      lat,
      lng,
      desiredMin,
      radiusKm
    );

    for (const r of filtered) {
      if (!acc.has(r.id)) acc.set(r.id, r);
    }
    if (acc.size >= desiredMin) break;

    await discoverAndIngestAround(lat, lng, {
      cellRadiusMeters: Math.round(radiusKm * 1000) || 3000,
      rankPrefs: ["POPULARITY", "DISTANCE"],
      includeTypes: [["restaurant"]],
      biasQueries,
    });
  }

  if (acc.size < desiredMin) {
    const lastRadius = expansion[expansion.length - 1];
    const finalPool = await places.ensureNearbyRestaurantsStrict(
      lat,
      lng,
      Math.max(desiredMin, 240),
      lastRadius,
      req
    );
    const filtered = filterAndPrioritizeByPreferences(
      finalPool,
      user,
      lat,
      lng,
      desiredMin,
      lastRadius
    );
    for (const r of filtered) if (!acc.has(r.id)) acc.set(r.id, r);
  }

  return Array.from(acc.values()).slice(0, desiredMin);
}

/* routes */

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
        ? `${BACKEND_PUBLIC_URL}/api/recs/photo?name=${encodeURIComponent(
            r.photos[0].name
          )}&w=1200`
        : null,
    }));

    res.json({ items });
  } catch (err) { // [FIX] Improved error logging
    console.error("[recs/lookup] error:", err);
    res.status(500).json({ error: "lookup failed" });
  }
});

router.use(verifyFirebaseToken);

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

    console.log(
      `[recs/start] user=${user.id} pool=${pool.length} strictPool=${filteredPool.length}`
    );

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
  } catch (err) { // [FIX] Improved error logging
    console.error("[recs/start] error:", err);
    res.status(500).json({ error: "start failed" });
  }
});

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

    const prefPool = await ensurePreferredPool(lat, lng, user, 120);
    const swipedIds = new Set(session.events.map((e) => e.restaurantId));
    const exclude = new Set(Array.isArray(excludeIds) ? excludeIds.filter(Boolean) : []);
    const basePool = prefPool.filter((r) => !swipedIds.has(r.id) && !exclude.has(r.id));

    const shuffledPool = basePool
      .slice()
      .sort(
        (a, b) =>
          (hashStr(sessionId + ":" + a.id) % 100000) - (hashStr(sessionId + ":" + b.id) % 100000)
      );

    const finalPool = shuffledPool;

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

    let wantIds = items.slice(0, Math.max(1, Number(limit))).map((x) => x.id);
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
    } catch {}

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
        servesVegetarianFood: r.servesVegetarianFood ?? null,
        allowsDogs: r.allowsDogs ?? null,
        hasParking:
          r.parkingOptions && typeof r.parkingOptions === "object"
            ? Object.values(r.parkingOptions).some(Boolean)
            : false,
      };
    });

    console.log(
      `[recs/next] user=${user.id} pref=${prefPool.length} cand=${basePool.length} returned=${clientItems.length}`
    );

    res.json({ items: clientItems });
  } catch (err) { // [FIX] Improved error logging
    console.error("[recs/next] error:", err);
    res.status(500).json({ error: "next failed" });
  }
});

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
  } catch (err) { // [FIX] Improved error logging
    console.error("[recs/feedback] error:", err);
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
  } catch (err) { // [FIX] Improved error logging
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
  } catch (err) { // [FIX] Improved error logging
    console.error("[recs/winner] error:", err);
    res.status(500).json({ error: "winner failed" });
  }
});

module.exports = router;