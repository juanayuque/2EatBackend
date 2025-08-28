// routes/recs.js
// My recs router: DB-first for cost, light Places v1 ingest/backfill for coverage,
// and preference-aware filtering keyed off Google Places primaryType/types.

const express = require("express");
const prisma = require("../src/prisma");
const verifyFirebaseToken = require("../middleware/auth");

const router = express.Router();

// --- Public health checks (no auth) ---
router.get("/__ping", (_req, res) => res.json({ ok: true, via: "recs", ts: Date.now() }));
router.get("/health", (_req, res) => res.json({ ok: true }));

// Everything below here requires a Firebase ID token
router.use(verifyFirebaseToken);

// I accept either new RECS_SERVICE_URL or legacy RECS_URL.
const RECS_SERVICE_URL =
  process.env.RECS_SERVICE_URL || process.env.RECS_URL || "http://127.0.0.1:8000";

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY; // Needed for Places v1 calls when DB is thin

// ---------------------------------------------------------------------
// Small math helpers
// ---------------------------------------------------------------------
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

// ---------------------------------------------------------------------
// Places v1 ingestion + backfill
// ---------------------------------------------------------------------

// I keep the field mask tight so we only pay for data we store/use.
const PLACES_FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.primaryType",
  "places.primaryTypeDisplayName",
  "places.types",
  "places.nationalPhoneNumber",
  "places.websiteUri",
  "places.formattedAddress",
  "places.location",
  "places.priceLevel",
  "places.rating",
  "places.userRatingCount",
  "places.photos.widthPx",
  "places.photos.heightPx",
  "places.photos.name",
].join(",");

// v1 nearby search to augment our local DB when the cache is thin
async function googlePlacesSearchNearby(lat, lng, radiusMeters = 6000, maxPages = 3) {
  if (!GOOGLE_API_KEY) return [];
  const results = [];
  let pageToken;

  for (let i = 0; i < maxPages; i++) {
    const body = {
      includedTypes: ["restaurant"],
      maxResultCount: 20,
      locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius: radiusMeters } },
      pageToken,
    };

    const r = await fetch("https://places.googleapis.com/v1/places:searchNearby", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": GOOGLE_API_KEY,
        "X-Goog-FieldMask": PLACES_FIELD_MASK,
      },
      body: JSON.stringify(body),
    });

    if (!r.ok) break;
    const json = await r.json();
    const places = json.places || [];
    results.push(...places);
    pageToken = json.nextPageToken;
    if (!pageToken) break;
  }

  return results;
}

// Map a v1 place to our Restaurant + first Photo
function mapPlaceToRestaurantCreate(place) {
  const loc = place.location || {};
  const displayName = place.displayName?.text || place.displayName || place.name || "Unknown";

  return {
    restaurant: {
      googlePlaceId: place.id,
      name: displayName,
      latitude: String(loc.latitude ?? 0),
      longitude: String(loc.longitude ?? 0),
      formattedAddress: place.formattedAddress || null,
      internationalPhoneNumber: place.nationalPhoneNumber || null,
      websiteUri: place.websiteUri || null,
      primaryTypeDisplayName: place.primaryTypeDisplayName || null,

      // New fields we persist for preference matching
      primaryType: place.primaryType || null,
      types: Array.isArray(place.types) ? place.types : [],

      rating: place.rating != null ? String(place.rating) : null,
      userRatingCount: place.userRatingCount ?? null,
      priceLevel: place.priceLevel ?? null,

      // Capability flags left as best-effort (not reliably provided by v1)
      servesVegetarianFood: false,
      takeout: false,
      dineIn: false,
      curbsidePickup: false,
      delivery: false,
      outdoorSeating: false,
      allowsDogs: false,
      parkingOptions: null,
      regularOpeningHours: null,
    },
    photo: place.photos?.[0]
      ? {
          name: place.photos[0].name,
          widthPx: place.photos[0].widthPx || null,
          heightPx: place.photos[0].heightPx || null,
        }
      : null,
  };
}

// Upsert Places to our DB (restaurant + first photo if new)
async function upsertPlacesBatch(places) {
  for (const p of places) {
    const mapped = mapPlaceToRestaurantCreate(p);

    const r = await prisma.restaurant.upsert({
      where: { googlePlaceId: mapped.restaurant.googlePlaceId },
      create: mapped.restaurant,
      update: {
        name: mapped.restaurant.name,
        formattedAddress: mapped.restaurant.formattedAddress,
        websiteUri: mapped.restaurant.websiteUri,
        primaryTypeDisplayName: mapped.restaurant.primaryTypeDisplayName,
        primaryType: mapped.restaurant.primaryType,
        types: mapped.restaurant.types,
        rating: mapped.restaurant.rating,
        userRatingCount: mapped.restaurant.userRatingCount,
        priceLevel: mapped.restaurant.priceLevel,
      },
    });

    if (mapped.photo) {
      const exists = await prisma.photo.findFirst({
        where: { restaurantId: r.id, name: mapped.photo.name },
        select: { id: true },
      });
      if (!exists) {
        await prisma.photo.create({
          data: {
            restaurantId: r.id,
            name: mapped.photo.name,
            widthPx: mapped.photo.widthPx,
            heightPx: mapped.photo.heightPx,
          },
        });
      }
    }
  }
}

// Best-effort backfill of primaryType/types for legacy rows
async function backfillMissingPlaceMetadata(restaurants, concurrency = 2) {
  if (!GOOGLE_API_KEY) return;

  const missing = restaurants.filter(
    (r) => !r.primaryType || !r.types || r.types.length === 0
  );
  if (!missing.length) return;

  const chunks = [];
  for (let i = 0; i < missing.length; i += concurrency) {
    chunks.push(missing.slice(i, i + concurrency));
  }

  for (const group of chunks) {
    await Promise.all(
      group.map(async (r) => {
        try {
          const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(
            r.googlePlaceId
          )}?fields=${encodeURIComponent("id,primaryType,primaryTypeDisplayName,types")}`;

          const res = await fetch(url, { headers: { "X-Goog-Api-Key": GOOGLE_API_KEY } });
          if (!res.ok) return;
          const d = await res.json();

          await prisma.restaurant.update({
            where: { id: r.id },
            data: {
              primaryType: d.primaryType || r.primaryType || null,
              primaryTypeDisplayName: d.primaryTypeDisplayName || r.primaryTypeDisplayName || null,
              types: Array.isArray(d.types) ? d.types : r.types || [],
            },
          });
        } catch {
          // swallow errors; this is background best-effort
        }
      })
    );
  }
}

/**
 * Nearby resolver stays DB-first (cheap). If the pool is too small, I ingest using
 * Places v1, then re-query locally. I also kick off a background backfill for rows
 * missing primaryType/types.
 */
async function ensureNearbyRestaurants(lat, lng, minCount = 100) {
  const all = await prisma.restaurant.findMany({
    take: 800,
    include: { photos: { take: 1 } },
  });

  const here = { lat, lng };
  let nearby = all
    .map((r) => ({
      r,
      d: haversineKm(here, { lat: Number(r.latitude), lng: Number(r.longitude) }),
    }))
    .filter((x) => Number.isFinite(x.d) && x.d <= 15) // 15 km envelope
    .sort((a, b) => a.d - b.d)
    .map((x) => x.r);

  // Not enough coverage? Ingest a few pages then retry.
  if (nearby.length < minCount && GOOGLE_API_KEY) {
    const places = await googlePlacesSearchNearby(lat, lng, 10000, 3);
    if (places.length) {
      await upsertPlacesBatch(places);
      const refreshed = await prisma.restaurant.findMany({
        take: 1000,
        include: { photos: { take: 1 } },
      });
      nearby = refreshed
        .map((r) => ({
          r,
          d: haversineKm(here, { lat: Number(r.latitude), lng: Number(r.longitude) }),
        }))
        .filter((x) => Number.isFinite(x.d) && x.d <= 15)
        .sort((a, b) => a.d - b.d)
        .map((x) => x.r);
    }
  }

  // Fire-and-forget backfill to enrich legacy rows
  backfillMissingPlaceMetadata(nearby).catch(() => {});

  return nearby;
}

// ---------------------------------------------------------------------
// Preference-aware filtering helpers
// ---------------------------------------------------------------------

// Normalize a cuisine string from the user ("Indian", "indian food") -> "indian"
function normCuisine(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[_\s-]+/g, " ")
    .trim();
}

// Rough mapping from user-friendly labels to likely Google type keywords.
// (I cover the common ones we’ve seen; easy to extend if we add more prefs.)
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

// Build a flat set of keywords we’ll try to match against Google types
function cuisineKeywordsFromUser(user) {
  const prefs = user?.preferredCuisines || [];
  const out = new Set();
  for (const p of prefs) {
    const key = normCuisine(p);
    const list = CUISINE_KEYWORDS[key] || [key];
    for (const k of list) out.add(k);
  }
  return out;
}

// Check if a restaurant matches any cuisine keyword using primaryType/types/displayName
function restaurantMatchesCuisine(r, keywordSet) {
  if (!keywordSet || !keywordSet.size) return true; // no prefs = pass-all

  // Prepare lookup strings: primary type, all types, and display name as a fallback
  const primary = (r.primaryType || "").toLowerCase(); // e.g., "indian_restaurant"
  const types = Array.isArray(r.types) ? r.types.map((t) => String(t).toLowerCase()) : [];
  const display = (r.primaryTypeDisplayName || r.name || "").toLowerCase(); // "Indian restaurant"

  for (const k of keywordSet) {
    // If Google already has a type like "indian_restaurant", a simple substring works.
    const typeNeedle = k.replace(/\s+/g, "_"); // "middle eastern" -> "middle_eastern"
    if (primary.includes(typeNeedle)) return true;
    if (types.some((t) => t.includes(typeNeedle))) return true;

    // Fallback: human-friendly display name contains the keyword ("Indian", "Greek", etc.)
    if (display.includes(k)) return true;
  }
  return false;
}

// Given a nearby pool + user + coords, return a list that prioritizes cuisine matches.
// If matches are very small, I append closest non-matches so we never starve the ranker.
function filterAndPrioritizeByPreferences(pool, user, lat, lng, desiredMin = 60) {
  const keywords = cuisineKeywordsFromUser(user);

  // Distance cache so we don’t re-compute
  const here = { lat, lng };
  const withDist = pool.map((r) => ({
    r,
    d: haversineKm(here, { lat: Number(r.latitude), lng: Number(r.longitude) }),
  }));

  const matches = withDist
    .filter(({ r }) => restaurantMatchesCuisine(r, keywords))
    .sort((a, b) => a.d - b.d);

  if (matches.length >= desiredMin) {
    return matches.map((x) => x.r);
  }

  // Append near non-matches to keep the list healthy
  const nonMatches = withDist
    .filter(({ r }) => !restaurantMatchesCuisine(r, keywords))
    .sort((a, b) => a.d - b.d);

  const merged = [...matches.map((x) => x.r)];
  for (const n of nonMatches) {
    if (merged.length >= desiredMin) break;
    merged.push(n.r);
  }
  return merged.length ? merged : pool; // absolute fallback
}

// ---------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------

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

    // Close any active sessions for this user; then open a new one.
    await prisma.swipeSession.updateMany({
      where: { userId: user.id, status: "active" },
      data: { status: "completed", endedAt: new Date() },
    });
    const session = await prisma.swipeSession.create({ data: { userId: user.id } });

    // Build our nearby candidate pool, then preference-filter it up front.
    const pool = await ensureNearbyRestaurants(lat, lng, minPool);
    const filteredPool = filterAndPrioritizeByPreferences(pool, user, lat, lng, Math.max(60, minPool));

    // Prepare a light payload to warm the ranker (we still fetch real cards via /next)
    const userPrefs = {
      budgetMax: user.budgetMax ?? null,
      dietaryNeeds: user.dietaryNeeds ?? [],
      preferredCuisines: user.preferredCuisines ?? [],
    };

    const items = filteredPool.map((r) => {
      const dist = haversineKm({ lat, lng }, { lat: r.latitude, lng: r.longitude });
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

    // Warm the ranker (non-blocking if it fails)
    try {
      await fetch(`${RECS_SERVICE_URL}/rank`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {
      // Ignore rank warm-up errors
    }

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
      return res.status(400).json({ error: "Invalid session" });
    }

    const swipedIds = new Set(session.events.map((e) => e.restaurantId));

    // Start with nearby, then apply preference filter, then drop already-swiped.
    const pool = await ensureNearbyRestaurants(lat, lng, 100);
    const prefPool = filterAndPrioritizeByPreferences(pool, user, lat, lng, 100);
    const candidates = prefPool.filter((r) => !swipedIds.has(r.id));
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
          ...(r.primaryType ? [`type:${r.primaryType}`] : []),
          ...(Array.isArray(r.types) ? r.types.map((t) => `type:${t}`) : []),
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

    // Ask the ranker for an order; if it fails, keep the current list
    let wantIds;
    try {
      const r = await fetch(`${RECS_SERVICE_URL}/rank`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const ranked = r.ok ? await r.json() : { rankings: items.map((x) => x.id) };
      wantIds = ranked.rankings.slice(0, Math.max(1, Number(limit)));
    } catch {
      wantIds = items.slice(0, Math.max(1, Number(limit))).map((x) => x.id);
    }

    // Hydrate top K in ranked order
    const full = await prisma.restaurant.findMany({
      where: { id: { in: wantIds } },
      include: { photos: { take: 1 } }, // I include the first photo so the client can show an image immediately
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
