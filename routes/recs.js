// routes/recs.js
// DB-first nearby -> preference filter -> (rank) -> hydrate
// Guarantees: if there are nearby restaurants, /next returns at least one item.
// Uses Places v1 resource names "places/<id>" and a safe photo proxy.

const express = require("express");
const prisma = require("../src/prisma");
const verifyFirebaseToken = require("../middleware/auth");
const axios = require("axios");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const router = express.Router();

/* ───────────────────────── Public routes (no auth) ───────────────────────── */

router.get("/__ping", (_req, res) => res.json({ ok: true, via: "recs", ts: Date.now() }));
router.get("/health", (_req, res) => res.json({ ok: true }));

const RECS_SERVICE_URL =
  process.env.RECS_SERVICE_URL || process.env.RECS_URL || "http://127.0.0.1:8000";
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const BACKEND_PUBLIC_URL = process.env.BACKEND_PUBLIC_URL || "https://2eatapp.com";

const PHOTO_CACHE_DIR =
  process.env.PHOTO_CACHE_DIR || path.join(process.cwd(), ".photo-cache");

console.log("[recs] BOOT", {
  HAS_GOOGLE_API_KEY: !!GOOGLE_API_KEY,
  RECS_SERVICE_URL,
  BACKEND_PUBLIC_URL,
  PHOTO_CACHE_DIR,
});

// ---------- helpers ----------
// Google Places v1 -> our DB int (1..4)
function mapPriceLevelEnum(v) {
  if (v == null) return null;
  if (typeof v === "number") return v; // in case we already normalized
  switch (String(v)) {
    case "PRICE_LEVEL_INEXPENSIVE": return 1;
    case "PRICE_LEVEL_MODERATE":    return 2;
    case "PRICE_LEVEL_EXPENSIVE":   return 3;
    case "PRICE_LEVEL_VERY_EXPENSIVE": return 4;
    default: return null;
  }
}

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

/** Map Google v1 price enum -> int (or null). Prisma expects Int or Null. */
function normalizePriceLevel(v) {
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const s = v.toUpperCase();
    switch (s) {
      case "PRICE_LEVEL_INEXPENSIVE": return 1;
      case "PRICE_LEVEL_MODERATE": return 2;
      case "PRICE_LEVEL_EXPENSIVE": return 3;
      case "PRICE_LEVEL_VERY_EXPENSIVE": return 4;
      case "PRICE_LEVEL_UNSPECIFIED": return null;
      default: {
        // Some providers return just "INEXPENSIVE"/"MODERATE"/...; handle loosely.
        if (s.includes("VERY") && s.includes("EXPENSIVE")) return 4;
        if (s.includes("EXPENSIVE")) return 3;
        if (s.includes("MODERATE")) return 2;
        if (s.includes("INEXPENSIVE") || s.includes("CHEAP")) return 1;
        const num = s.match(/\d+/);
        return num ? Number(num[0]) : null;
      }
    }
  }
  return null;
}

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
  "places.editorialSummary",
  "places.photos.widthPx",
  "places.photos.heightPx",
  "places.photos.name",
].join(",");

const toPlaceName = (idOrName) =>
  String(idOrName).startsWith("places/") ? String(idOrName) : `places/${idOrName}`;

// Nearby search around (lat,lng). Uses v1 "locationRestriction".
async function googlePlacesSearchNearby(lat, lng, radiusMeters = 8000, maxPages = 3) {
  if (!GOOGLE_API_KEY) return [];
  const results = [];
  let pageToken;
  for (let i = 0; i < maxPages; i++) {
    const body = {
      includedTypes: ["restaurant"],
      maxResultCount: 20,
      locationRestriction: {
        circle: {
          center: { latitude: lat, longitude: lng },
          radius: radiusMeters,
        },
      },
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
    if (!r.ok) {
      try {
        const e = await r.text();
        console.error("[recs] searchNearby upstream err", r.status, e.slice(0, 300));
      } catch {}
      break;
    }
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
  const ptdnRaw = place.primaryTypeDisplayName;
  const ptdn = typeof ptdnRaw === "string" ? ptdnRaw : (ptdnRaw && ptdnRaw.text) ? ptdnRaw.text : null;
  const priceLevel = normalizePriceLevel(place.priceLevel);

  return {
    restaurant: {
      googlePlaceId: place.id,
      name: displayName,
      latitude: String(loc.latitude ?? 0),
      longitude: String(loc.longitude ?? 0),
      formattedAddress: place.formattedAddress || null,
      internationalPhoneNumber: place.nationalPhoneNumber || null,
      websiteUri: place.websiteUri || null,
      primaryTypeDisplayName: place.primaryTypeDisplayName?.text || null,
      primaryType: place.primaryType || null,
      types: Array.isArray(place.types) ? place.types : [],
      rating: place.rating != null ? String(place.rating) : null,
      userRatingCount: place.userRatingCount ?? null,
      editorialSummary: place.editorialSummary?.text || null,
      priceLevel, // <-- INT or null
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
          name: place.photos[0].name, // "places/<id>/photos/<photoId>"
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
        editorialSummary: mapped.restaurant.editorialSummary,
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

// Backfill any missing type metadata (and priceLevel) for legacy rows
async function backfillMissingPlaceMetadata(restaurants) {
  if (!GOOGLE_API_KEY) return;
  const missing = restaurants.filter(
    (r) => !r.primaryType || !r.types || r.types.length === 0 || r.priceLevel == null
  );
  if (!missing.length) return;
  console.log(`[recs] backfill metadata for ${missing.length} restaurants…`);
  for (const r of missing.slice(0, 50)) {
    try {
      const name = toPlaceName(r.googlePlaceId);
      const url = `https://places.googleapis.com/v1/${name}?fields=${encodeURIComponent(
        "id,primaryType,primaryTypeDisplayName,types,priceLevel"
      )}`;
      const res = await fetch(url, { headers: { "X-Goog-Api-Key": GOOGLE_API_KEY } });
      if (!res.ok) continue;
      const d = await res.json();
      const ptdnRaw = d.primaryTypeDisplayName;
      const ptdn = typeof ptdnRaw === "string" ? ptdnRaw : (ptdnRaw && ptdnRaw.text) ? ptdnRaw.text : r.primaryTypeDisplayName || null;
      await prisma.restaurant.update({
        where: { id: r.id },
        data: {
          primaryType: d.primaryType || r.primaryType || null,
          primaryTypeDisplayName: ptdn,
          types: Array.isArray(d.types) ? d.types : r.types || [],
          priceLevel: normalizePriceLevel(d.priceLevel ?? r.priceLevel ?? null),
        },
      });
    } catch {
      // best-effort
    }
  }
}

// Build/refresh nearby pool; ingest from Places if thin; always log the count
async function ensureNearbyRestaurants(lat, lng, minCount = 100) {
  const here = { lat, lng };

  const all = await prisma.restaurant.findMany({
    take: 2000,
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


// ----------------------- photo proxy (no auth) ----------------------
router.get("/photo", async (req, res) => {
  try {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) return res.status(503).send("photo proxy disabled");

    const raw = String(req.query.name || "");
    const name = decodeURIComponent(raw);

    // Strictly allow only "places/<id>/photos/<photo_id>"
    const m = /^places\/([^/]+)\/photos\/([^/]+)$/.exec(name);
    if (!m) return res.status(400).send("bad name");
    const placeId = m[1];

    // width/height: support both ?w/h and ?maxWidthPx/maxHeightPx
    const w = req.query.w || req.query.maxWidthPx;
    const h = req.query.h || req.query.maxHeightPx;

    const buildMediaUrl = (photoName) => {
      const params = new URLSearchParams();
      if (w) params.set("maxWidthPx", String(w));
      if (h) params.set("maxHeightPx", String(h));
      params.set("key", apiKey); // use query param per Places v1 examples
      return `https://places.googleapis.com/v1/${photoName}/media?${params.toString()}`;
    };

    async function streamMedia(photoName) {
      const mediaUrl = buildMediaUrl(photoName);

      // First request without following redirects (expect 302)
      const head = await axios.get(mediaUrl, {
        responseType: "stream",
        maxRedirects: 0,
        validateStatus: (s) => s >= 200 && s < 400, // accept 302
      });

      const finalUrl = head.status === 302 && head.headers.location
        ? head.headers.location
        : mediaUrl;

      const img = await axios.get(finalUrl, { responseType: "stream" });

      res.setHeader("Content-Type", img.headers["content-type"] || "image/jpeg");
      res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=86400");
      res.setHeader("Access-Control-Allow-Origin", "*");
      img.data.pipe(res);
    }

    try {
      // Try with the stored photo name first
      return await streamMedia(name);
    } catch (err) {
      const status = err?.response?.status;
      console.error("[recs/photo] media upstream", status || "", err?.message || "");

      // If Google says the resource is invalid/stale, refresh photos for the place and retry once
      if (status === 400 || status === 404) {
        try {
          const det = await axios.get(
            `https://places.googleapis.com/v1/places/${placeId}?fields=photos.name&key=${apiKey}`
          );
          const newName = det?.data?.photos?.[0]?.name;
          if (newName && newName !== name) {
            // best-effort DB update so we stop requesting the stale token
            try {
              await prisma.photo.updateMany({ where: { name }, data: { name: newName } });
            } catch (_) {}
            return await streamMedia(newName);
          }
        } catch (e2) {
          console.error("[recs/photo] details fetch failed", e2?.response?.status || "", e2?.message || "");
        }
      }

      // Graceful no-content so the UI can show its fallback image
      return res.status(204).end();
    }
  } catch (e) {
    console.error("photo proxy error", e);
    return res.status(204).end();
  }
});



/* ───────────────────────── Everything below needs auth ───────────────────── */
router.use(verifyFirebaseToken);

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

// ---------- routes ----------
router.get("/lookup", async (req, res) => {
  try {
    const idsParam = String(req.query.ids || "");
    const ids = idsParam.split(",").map(s => s.trim()).filter(Boolean);
    if (!ids.length) return res.json({ items: [] });

    const rows = await prisma.restaurant.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        name: true,
        editorialSummary: true,
        formattedAddress: true,
        priceLevel: true,
        photos: { take: 1 },
      },
    });

    const items = rows.map(r => ({
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
    console.error("recs/lookup error:", e);
    res.status(500).json({ error: "lookup failed" });
  }
});

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

    let session = await prisma.swipeSession.findFirst({
  where: { userId: user.id, status: "active" },
  orderBy: { startedAt: "desc" }, // use existing field
  include: { events: true },
});
    if (!session) {
      session = await prisma.swipeSession.create({ data: { userId: user.id } });
    }

    const pool = await ensureNearbyRestaurants(lat, lng, minPool);
    const filteredPool = filterAndPrioritizeByPreferences(pool, user, lat, lng, Math.max(60, minPool));
    console.log(`[recs/start] user=${user.id} pool=${pool.length} prefPool=${filteredPool.length}`);

    // Warm the ranker (best-effort)
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

    const swipedIds = new Set(session.events.map((e) => e.restaurantId));
    const pool = await ensureNearbyRestaurants(lat, lng, 100);
    const prefPool = filterAndPrioritizeByPreferences(pool, user, lat, lng, 100);
    const candidates = prefPool.filter((r) => !swipedIds.has(r.id));

    const finalPool = candidates.length ? candidates : pool.filter((r) => !swipedIds.has(r.id));
    if (!finalPool.length) {
      console.log(`[recs/next] user=${user.id} cand=0 → returning empty`);
      return res.json({ items: [] });
    }

    const items = finalPool.map((r) => {
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
      const dist = haversineKm({ lat, lng }, { lat: asFloat(r.latitude), lng: asFloat(r.longitude) });
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

    // hydrate winner for immediate UI render
const winner = await prisma.restaurant.findUnique({
  where: { id: winnerRestaurantId },
  include: { photos: { take: 1 } },
});
let winnerPhotoUrl = null;
const photoName = winner?.photos?.[0]?.name || null;
if (photoName) {
  winnerPhotoUrl = `${BACKEND_PUBLIC_URL}/api/recs/photo?name=${encodeURIComponent(photoName)}&w=1200`;
}
const payloadWinner = winner && {
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
      winner: r && {
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
