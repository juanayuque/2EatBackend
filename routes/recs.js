// routes/recs.js
// DB-first nearby -> preference filter -> (rank) -> hydrate
// Guarantees: if there are nearby restaurants, /next returns at least one item.
// Also fixes Places v1 backfill by using resource names "places/<id>".

const express = require("express");
const prisma = require("../src/prisma");
const verifyFirebaseToken = require("../middleware/auth");

const router = express.Router();

// --- Public health checks (no auth) ---
router.get("/__ping", (_req, res) => res.json({ ok: true, via: "recs", ts: Date.now() }));
router.get("/health", (_req, res) => res.json({ ok: true }));

const RECS_SERVICE_URL =
  process.env.RECS_SERVICE_URL || process.env.RECS_URL || "http://127.0.0.1:8000";
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

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
const asFloat = (v) => parseFloat(String(v));

// ---------- Places ingest / backfill ----------
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

// Helper: Google v1 expects resource names "places/<id>".
// We store plain "<id>" in DB (googlePlaceId). Normalize when calling Google.
const toPlaceName = (idOrName) =>
  String(idOrName).startsWith("places/") ? String(idOrName) : `places/${idOrName}`;

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

function mapPlaceToRestaurantCreate(place) {
  const loc = place.location || {};
  const displayName = place.displayName?.text || place.displayName || place.name || "Unknown";
  return {
    restaurant: {
      // We store the raw ID (not "places/<id>") in googlePlaceId
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
          name: place.photos[0].name, // already a "places/<id>/photos/<id>"
          widthPx: place.photos[0].widthPx || null,
          heightPx: place.photos[0].heightPx || null,
        }
      : null,
  };
}

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

// Fix: use resource name when calling v1 get; add logging so you know it ran
async function backfillMissingPlaceMetadata(restaurants) {
  if (!GOOGLE_API_KEY) return;
  const missing = restaurants.filter(
    (r) => !r.primaryType || !r.types || r.types.length === 0
  );
  if (!missing.length) return;
  console.log(`[recs] backfill metadata for ${missing.length} restaurants…`);
  for (const r of missing.slice(0, 50)) { // throttle
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
    } catch (e) {
      // swallow; best-effort
    }
  }
}

// Build/refresh nearby pool; ingest if thin; always log the count
async function ensureNearbyRestaurants(lat, lng, minCount = 100) {
  const here = { lat, lng };

  const all = await prisma.restaurant.findMany({
    take: 1500,
    include: { photos: { take: 1 } },
  });

  let nearby = all
    .map((r) => ({
      r,
      d: haversineKm(here, { lat: asFloat(r.latitude), lng: asFloat(r.longitude) }),
    }))
    .filter((x) => Number.isFinite(x.d) && x.d <= 15)
    .sort((a, b) => a.d - b.d)
    .map((x) => x.r);

  if (nearby.length < minCount && GOOGLE_API_KEY) {
    console.log(`[recs] nearby=${nearby.length} < ${minCount} → ingesting Places…`);
    const places = await googlePlacesSearchNearby(lat, lng, 10000, 3);
    console.log(`[recs] ingested places: ${places.length}`);
    if (places.length) {
      await upsertPlacesBatch(places);
      const refreshed = await prisma.restaurant.findMany({
        take: 2000,
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
  const primary = (r.primaryType || "").toLowerCase();               // "indian_restaurant"
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

// ---------- PUBLIC image proxy (moved BEFORE auth) ----------
// ---------- PUBLIC image proxy with local disk cache ----------
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const PHOTO_CACHE_DIR = process.env.PHOTO_CACHE_DIR || path.join(process.cwd(), ".photo-cache");
// optional: days to keep files before re-fetch
const PHOTO_CACHE_TTL_MS = Number(process.env.PHOTO_CACHE_TTL_MS || 30 * 24 * 60 * 60 * 1000); // 30 days

async function ensureDir(p) {
  try { await fsp.mkdir(p, { recursive: true }); } catch {}
}
function cacheKeyFor(name, w, h) {
  const key = `${name}|w=${w || ""}|h=${h || ""}`;
  return crypto.createHash("sha1").update(key).digest("hex") + ".jpg";
}
function isFresh(stat) {
  if (!PHOTO_CACHE_TTL_MS) return true;
  const age = Date.now() - stat.mtimeMs;
  return age < PHOTO_CACHE_TTL_MS;
}

router.get("/photo", async (req, res) => {
  try {
    if (!GOOGLE_API_KEY) return res.status(503).send("photo proxy disabled");
    const name = String(req.query.name || "");
    const w = req.query.w ? Number(req.query.w) : undefined;
    const h = req.query.h ? Number(req.query.h) : undefined;

    // Strictly validate resource name (prevents SSRF). Google names look like: places/<id>/photos/<id>
    if (!/^places\/[A-Za-z0-9_\-]+\/photos\/[A-Za-z0-9_\-]+$/.test(name)) {
      console.warn("[recs/photo] bad name:", name);
      return res.status(400).send("bad name");
    }

    await ensureDir(PHOTO_CACHE_DIR);
    const filename = cacheKeyFor(name, w, h);
    const filePath = path.join(PHOTO_CACHE_DIR, filename);

    // Serve cached file if fresh
    try {
      const stat = await fsp.stat(filePath);
      if (stat.isFile() && isFresh(stat)) {
        res.set("Cache-Control", "public, max-age=86400, s-maxage=86400");
        res.type("jpg");
        return fs.createReadStream(filePath).pipe(res);
      }
    } catch (_) {
      // cache miss
    }

    // Fetch from Google Places Photos v1
    const usp = new URLSearchParams();
    if (w) usp.set("maxWidthPx", String(w));
    if (h) usp.set("maxHeightPx", String(h));
    const url = `https://places.googleapis.com/v1/${name}/media?${usp.toString()}`;

    const r = await fetch(url, { headers: { "X-Goog-Api-Key": GOOGLE_API_KEY } });
    if (!r.ok) {
      console.warn("[recs/photo] upstream status", r.status, "for", name);
      return res.sendStatus(r.status);
    }

    // Stream to both disk and client
    res.set("Cache-Control", "public, max-age=86400, s-maxage=86400");
    const ct = r.headers.get("content-type") || "image/jpeg";
    res.set("Content-Type", ct);

    // Write-through cache
    const tmpFile = filePath + ".part";
    await ensureDir(path.dirname(filePath));
    const out = fs.createWriteStream(tmpFile);
    r.body.pipe(out);
    r.body.on("end", async () => {
      try { await fsp.rename(tmpFile, filePath); } catch {}
    });
    r.body.on("error", async () => {
      try { await fsp.unlink(tmpFile); } catch {}
    });

    // Also pipe to the response
    r.body.pipe(res);
  } catch (e) {
    console.error("photo proxy error", e);
    res.sendStatus(500);
  }
});


// --- Everything below here requires a Firebase ID token
router.use(verifyFirebaseToken);

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
    } catch {}

    res.json({ sessionId: session.id });
  } catch (e) {
    console.error("recs/start error:", e);
    res.status(500).json({ error: "start failed" });
  }
});

// Next cards – ALWAYS falls back to local order if ranker returns unknown IDs
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
    const pool = await ensureNearbyRestaurants(lat, lng, 100);
    const prefPool = filterAndPrioritizeByPreferences(pool, user, lat, lng, 100);
    const candidates = prefPool.filter((r) => !swipedIds.has(r.id));

    // If still empty, fall back to any nearby non-swiped
    const finalPool = candidates.length ? candidates : pool.filter((r) => !swipedIds.has(r.id));
    if (!finalPool.length) {
      console.log(`[recs/next] user=${user.id} cand=0 → returning empty`);
      return res.json({ items: [] });
    }

    // lightweight feature list for ranker
    const items = finalPool.map((r) => {
      const dist = haversineKm({ lat, lng }, { lat: asFloat(r.latitude), lng: asFloat(r.longitude) });
      return {
        id: r.id, // IMPORTANT: this is the DB id; ranker must return these
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

    // interactions from the session
    const interactions = session.events.map((e) => ({
      userId: user.id,
      itemId: e.restaurantId,
      action: e.action,
    }));

    // Ask ranker, but be robust if it returns IDs we can't hydrate
    let wantIds = items.slice(0, Math.max(1, Number(limit))).map((x) => x.id); // default fallback
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
        // Only keep ids that exist in our candidate set to avoid hydration=0
        const candidateSet = new Set(finalPool.map((x) => x.id));
        const safe = (ranked.rankings || []).filter((id) => candidateSet.has(id));
        wantIds = (safe.length ? safe : wantIds).slice(0, Math.max(1, Number(limit)));
      }
    } catch {
      // ignore – we'll use the default wantIds
    }

    // hydrate and shape for client
    let full = await prisma.restaurant.findMany({
      where: { id: { in: wantIds } },
      include: { photos: { take: 1 } },
    });

    // If hydration came back empty or partial (ranker mismatch), fall back locally
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

    // Preserve order: ranker first, then our local fallback
    const order = new Map(wantIds.map((id, i) => [id, i]));
    full.sort((a, b) => (order.get(a.id) ?? 9999) - (order.get(b.id) ?? 9999));

    const clientItems = full.map((r) => {
      const photoName = r.photos?.[0]?.name || null; // "places/<id>/photos/<id>"
      // ✅ Return a RELATIVE URL so it works on any origin (dev or prod) and doesn’t rely on env.
      const photoUrl = photoName ? `/api/recs/photo?name=${encodeURIComponent(photoName)}&w=1200` : null;
      const dist = haversineKm({ lat, lng }, { lat: asFloat(r.latitude), lng: asFloat(r.longitude) });
      return {
        id: r.id,
        name: r.name,
        address: r.formattedAddress,
        priceLevel: r.priceLevel ?? null,
        distance: dist,   // km – your UI reads `current.distance`
        photoUrl,         // your UI reads `current.photoUrl`
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
