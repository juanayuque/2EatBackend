// routes/recs.js
// DB-first nearby -> preference filter -> (rank) -> hydrate
// Guarantees: if there are nearby restaurants, /next returns at least one item.
// Also fixes Places v1 backfill by using resource names "places/<id>".
// Important change: /next now salvages a valid active session instead of 400-ing,
// and returns 409 only when the user has no active session (client should /start once).

const express = require("express");
const prisma = require("../src/prisma");
const verifyFirebaseToken = require("../middleware/auth");

const router = express.Router();

// --- Public health checks (no auth) ---
router.get("/__ping", (_req, res) => res.json({ ok: true, via: "recs", ts: Date.now() }));
router.get("/health", (_req, res) => res.json({ ok: true }));

// Everything below here requires a Firebase ID token
router.use(verifyFirebaseToken);

const RECS_SERVICE_URL =
  process.env.RECS_SERVICE_URL || process.env.RECS_URL || "http://127.0.0.1:8000";
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const BACKEND_PUBLIC_URL = process.env.BACKEND_PUBLIC_URL || "https://2eatapp.com";

// Boot log to confirm env at runtime
console.log("[recs] BOOT", {
  HAS_GOOGLE_API_KEY: !!GOOGLE_API_KEY,
  RECS_SERVICE_URL,
});

// ---------- helpers ----------
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
function distanceBand(km) { if (km <= 1) return "near"; if (km <= 5) return "mid"; return "far"; }
function priceBandFromBudget(budgetMax) {
  if (budgetMax == null) return 0;
  if (budgetMax <= 15) return 1;
  if (budgetMax <= 30) return 2;
  if (budgetMax <= 60) return 3;
  return 4;
}
// Prisma Decimal -> JS number (for distance calc & client payload)
const asFloat = (v) => parseFloat(String(v));

// ---------- Places ingest / backfill ----------
// I ask Google for only the fields we actually use to keep payloads small.
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

// Google v1 wants resource names "places/<id>".
// We store the raw "<id>" in DB (googlePlaceId), so I normalize before v1 calls.
const toPlaceName = (idOrName) =>
  String(idOrName).startsWith("places/") ? String(idOrName) : `places/${idOrName}`;

// Pull a few pages of nearby restaurants from Places v1 (server-side; never exposes API key)
async function googlePlacesSearchNearby(lat, lng, radiusMeters = 8000, maxPages = 3) {
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

// Map a Places v1 object into our Restaurant + (optional) Photo create shape
function mapPlaceToRestaurantCreate(place) {
  const loc = place.location || {};
  const displayName = place.displayName?.text || place.displayName || place.name || "Unknown";
  return {
    restaurant: {
      // Store raw Places ID (e.g., "ChIJ...") in googlePlaceId
      googlePlaceId: place.id,
      name: displayName,
      latitude: String(loc.latitude ?? 0),
      longitude: String(loc.longitude ?? 0),
      formattedAddress: place.formattedAddress || null,
      internationalPhoneNumber: place.nationalPhoneNumber || null,
      websiteUri: place.websiteUri || null,
      primaryTypeDisplayName: place.primaryTypeDisplayName || null,
      primaryType: place.primaryType || null,
      types: Array.isArray(place.types) ? place.types : [],
      rating: place.rating != null ? String(place.rating) : null,
      userRatingCount: place.userRatingCount ?? null,
      priceLevel: place.priceLevel ?? null,
      // The booleans below are placeholders we might fill later if needed.
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
          // This is already a v1 resource name like "places/<id>/photos/<photoId>"
          name: place.photos[0].name,
          widthPx: place.photos[0].widthPx || null,
          heightPx: place.photos[0].heightPx || null,
        }
      : null,
  };
}

// Upsert the places we fetched. I store the first photo (if any) so we can serve it later from our photo proxy.
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

// Best-effort backfill for older rows that are missing primaryType/types (Places v1)
async function backfillMissingPlaceMetadata(restaurants) {
  if (!GOOGLE_API_KEY) return;
  const missing = restaurants.filter(
    (r) => !r.primaryType || !r.types || r.types.length === 0
  );
  if (!missing.length) return;
  console.log(`[recs] backfill metadata for ${missing.length} restaurants…`);
  for (const r of missing.slice(0, 50)) { // throttle a bit
    try {
      const name = toPlaceName(r.googlePlaceId);
      const url = `https://places.googleapis.com/v1/${name}?fields=${encodeURIComponent(
        "id,primaryType,primaryTypeDisplayName,types"
      )}`;
      const res = await fetch(url, { headers: { "X-Goog-Api-Key": GOOGLE_API_KEY } });
      if (!res.ok) continue;
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
      // best effort only
    }
  }
}

// Build/refresh nearby pool; ingest if thin; always log the count
async function ensureNearbyRestaurants(lat, lng, minCount = 100) {
  const here = { lat, lng };

  // I include a single photo per restaurant so I can compute the photo URL without extra queries.
  const all = await prisma.restaurant.findMany({
    take: 2000,
    include: { photos: { take: 1 } },
  });

  let nearby = all
    .map((r) => ({
      r,
      d: haversineKm(here, { lat: asFloat(r.latitude), lng: asFloat(r.longitude) }),
    }))
    .filter((x) => Number.isFinite(x.d) && x.d <= 15) // 15km envelope
    .sort((a, b) => a.d - b.d)
    .map((x) => x.r);

  if (nearby.length < minCount && GOOGLE_API_KEY) {
    console.log(`[recs] nearby=${nearby.length} < ${minCount} → ingesting Places…`);
    const places = await googlePlacesSearchNearby(lat, lng, 10000, 3);
    console.log(`[recs] ingested places: ${places.length}`);
    if (places.length) {
      await upsertPlacesBatch(places);
      const refreshed = await prisma.restaurant.findMany({
        take: 3000,
        include: { photos: { take: 1 } },
      });
      nearby = refreshed
        .map((r) => ({
          r,
          d: haversineKm(here, { lat: asFloat(r.latitude), lng: asFloat(r.longitude) }),
        }))
        .filter((x) => Number.isFinite(x.d) && x.d <= 15)
        .sort((a, b) => a.d - b.d)
        .map((x) => x.r);
    }
  }

  // Kick a best-effort backfill for missing primaryType/types. I don't await this.
  backfillMissingPlaceMetadata(nearby).catch(() => {});
  console.log(`[recs] ensureNearby: ${nearby.length} within 15km`);
  return nearby;
}

// ---------- preference filter ----------
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

// From user.preferredCuisines I derive a keyword set, expanding common synonyms
function cuisineKeywordsFromUser(user) {
  const out = new Set();
  for (const p of user?.preferredCuisines || []) {
    const key = norm(p);
    (CUISINE_KEYWORDS[key] || [key]).forEach((k) => out.add(k));
  }
  return out;
}

// Decide if a restaurant matches the user's cuisine keywords.
// I check primaryType (snake case), types (array of snake case), and the display/name (free text).
function restaurantMatchesCuisine(r, keywordSet) {
  if (!keywordSet || !keywordSet.size) return true;
  const primary = (r.primaryType || "").toLowerCase();               // e.g. "indian_restaurant"
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

// Filter by preference but keep enough supply by topping up with nearest non-matches
function filterAndPrioritizeByPreferences(pool, user, lat, lng, desiredMin = 60) {
  const keys = cuisineKeywordsFromUser(user);
  const here = { lat, lng };
  const withDist = pool.map((r) => ({
    r,
    d: haversineKm(here, { lat: asFloat(r.latitude), lng: asFloat(r.longitude) }),
  }));
  const matches = withDist.filter(({ r }) => restaurantMatchesCuisine(r, keys)).sort((a, b) => a.d - b.d);
  if (matches.length >= desiredMin) return matches.map((x) => x.r);
  const non = withDist.filter(({ r }) => !restaurantMatchesCuisine(r, keys)).sort((a, b) => a.d - b.d);
  const merged = [...matches.map((x) => x.r)];
  for (const n of non) { if (merged.length >= desiredMin) break; merged.push(n.r); }
  return merged.length ? merged : pool;
}

// ---------- image proxy (no key leakage to client) ----------
router.get("/photo", async (req, res) => {
  try {
    if (!GOOGLE_API_KEY) return res.status(503).send("photo proxy disabled");
    const name = String(req.query.name || "");
    const w = req.query.w ? Number(req.query.w) : undefined;
    const h = req.query.h ? Number(req.query.h) : undefined;

    // Allow only patterns like: places/<id>/photos/<id>
    if (!/^places\/[A-Za-z0-9_\-]+\/photos\/[A-Za-z0-9_\-]+$/.test(name)) {
      return res.status(400).send("bad name");
    }

    const usp = new URLSearchParams();
    if (w) usp.set("maxWidthPx", String(w));
    if (h) usp.set("maxHeightPx", String(h));

    const url = `https://places.googleapis.com/v1/${name}/media?${usp.toString()}`;
    const r = await fetch(url, { headers: { "X-Goog-Api-Key": GOOGLE_API_KEY } });
    if (!r.ok) return res.sendStatus(r.status);

    res.set("Cache-Control", "public, max-age=86400, s-maxage=86400");
    const ct = r.headers.get("content-type") || "image/jpeg";
    res.set("Content-Type", ct);
    return r.body.pipe(res);
  } catch (e) {
    console.error("photo proxy error", e);
    res.sendStatus(500);
  }
});

// ---------- routes ----------

// Start a swipe/recs session (also preference-prime the pool)
router.post("/start", async (req, res) => {
  try {
    const uid = req.user.uid;
    const { lat, lng, minPool = 100 } = req.body || {};
    if (typeof lat !== "number" || typeof lng !== "number") {
      return res.status(400).json({ error: "lat/lng required" });
    }
    const user = await prisma.user.findUnique({ where: { firebaseUid: uid } });
    if (!user) return res.status(404).json({ error: "User not found. Sync profile first." });

    // I force single-active-session semantics: close any previous active sessions.
    await prisma.swipeSession.updateMany({
      where: { userId: user.id, status: "active" },
      data: { status: "completed", endedAt: new Date() },
    });
    const session = await prisma.swipeSession.create({ data: { userId: user.id } });

    const pool = await ensureNearbyRestaurants(lat, lng, minPool);
    const filteredPool = filterAndPrioritizeByPreferences(pool, user, lat, lng, Math.max(60, minPool));
    console.log(`[recs/start] user=${user.id} pool=${pool.length} prefPool=${filteredPool.length}`);

    // Warm the ranker (best-effort; don't await)
    try {
      const items = filteredPool.slice(0, 200).map((r) => {
        const dist = haversineKm({ lat, lng }, { lat: asFloat(r.latitude), lng: asFloat(r.longitude) });
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
        body: JSON.stringify({ user: { id: user.id, features: userFeatures }, items, interactions: [] }),
      }).catch(() => {});
    } catch {
      // best-effort warm
    }

    res.json({ sessionId: session.id });
  } catch (e) {
    console.error("recs/start error:", e);
    res.status(500).json({ error: "start failed" });
  }
});

// Next cards – robust to stale sessionIds; falls back to local order if ranker misbehaves
router.post("/next", async (req, res) => {
  try {
    const uid = req.user.uid;
    const { sessionId, lat, lng, limit = 1 } = req.body || {};
    if (!sessionId || typeof lat !== "number" || typeof lng !== "number") {
      return res.status(400).json({ error: "sessionId, lat, lng required" });
    }

    const user = await prisma.user.findUnique({ where: { firebaseUid: uid } });
    if (!user) return res.status(404).json({ error: "User not found" });

    // Try the provided session first
    let session = await prisma.swipeSession.findUnique({
      where: { id: sessionId },
      include: { events: true },
    });

    // If it’s stale/closed or doesn’t belong to this user, salvage the latest active one
    if (!session || session.userId !== user.id || session.status !== "active") {
      const latestActive = await prisma.swipeSession.findFirst({
        where: { userId: user.id, status: "active" },
        orderBy: { startedAt: "desc" },
        include: { events: true },
      });
      if (!latestActive) {
        // Tell the client to /start once. This avoids an error loop in StrictMode.
        return res.status(409).json({ error: "No active session" });
      }
      session = latestActive;
    }

    const swipedIds = new Set(session.events.map((e) => e.restaurantId));

    // Build a pool from DB (ingest/backfill happens inside ensureNearby if needed)
    const pool = await ensureNearbyRestaurants(lat, lng, 100);

    // Apply the user's cuisine preferences (using primaryType/types)
    const prefPool = filterAndPrioritizeByPreferences(pool, user, lat, lng, 100);

    // Remove already-swiped items for this session
    const candidates = prefPool.filter((r) => !swipedIds.has(r.id));

    // If nothing matches prefs, fall back to any nearby non-swiped
    const finalPool = candidates.length ? candidates : pool.filter((r) => !swipedIds.has(r.id));
    if (!finalPool.length) {
      console.log(`[recs/next] user=${user.id} cand=0 → returning empty`);
      return res.json({ items: [] });
    }

    // Prepare lightweight feature list for ranker
    const items = finalPool.map((r) => {
      const dist = haversineKm({ lat, lng }, { lat: asFloat(r.latitude), lng: asFloat(r.longitude) });
      return {
        id: r.id, // This is our DB id – ranker returns these
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

    // Build interaction history from this session
    const interactions = session.events.map((e) => ({
      userId: user.id,
      itemId: e.restaurantId,
      action: e.action,
    }));

    // Default order (distance) in case the ranker is down or returns junk
    let wantIds = items.slice(0, Math.max(1, Number(limit))).map((x) => x.id);

    // Ask ranker (best-effort). I only accept IDs that exist in our candidate set.
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
      // fine – we'll fall back to default order
    }

    // Hydrate the chosen IDs for the client (include one photo so we can build photoUrl)
    let full = await prisma.restaurant.findMany({
      where: { id: { in: wantIds } },
      include: { photos: { take: 1 } },
    });

    // If hydration is partial, top up with the next nearest items from finalPool
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

    // Preserve the ranker's order (fallback items come after)
    const order = new Map(wantIds.map((id, i) => [id, i]));
    full.sort((a, b) => (order.get(a.id) ?? 9999) - (order.get(b.id) ?? 9999));

    // Shape response for the app (distance + photoUrl are ready to use)
    const clientItems = full.map((r) => {
      const photoName = r.photos?.[0]?.name || null; // "places/<id>/photos/<photoId>"
      const photoUrl = photoName
        ? `${BACKEND_PUBLIC_URL}/api/recs/photo?name=${encodeURIComponent(photoName)}&w=1200`
        : null;
      const dist = haversineKm({ lat, lng }, { lat: asFloat(r.latitude), lng: asFloat(r.longitude) });
      return {
        id: r.id,
        name: r.name,
        address: r.formattedAddress,
        priceLevel: r.priceLevel ?? null,
        distance: dist,   // km
        photoUrl,         // used directly by the client
        primaryType: r.primaryType,
        types: r.types,
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

// Feedback / finalize / winner (unchanged)
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
