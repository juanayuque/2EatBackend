// routes/recs.js
// DB-first nearby -> preference/requirement filter -> (rank) -> hydrate
// Guarantees: if there are nearby restaurants, /next returns at least one item.
// Uses Places v1 resource names "places/<id>" and a safe photo proxy.

const express = require("express");
const prisma = require("../src/prisma");
const verifyFirebaseToken = require("../middleware/auth");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

// Shared helpers from the Places service
const {
  ensureNearbyRestaurants,
  normalizePriceLevel,
  haversineKm,
  asFloat,
  distanceBand,
  priceBandFromBudget,
} = require("../src/services/placesService");

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

// ---------- preference + requirement helpers ----------

const norm = (s) => String(s || "").toLowerCase().replace(/[_\s-]+/g, " ").trim();
const lc = (s) => String(s || "").toLowerCase();

// Map of cuisine → keywords to search in primaryType / types / primaryTypeDisplayName.
// NOTE: "Fast Food" requirement from user: only look for the single keyword "fast".
const CUISINE_KEYWORDS = {
  indian: ["indian"],
  chinese: ["chinese", "szechuan", "sichuan", "cantonese", "hunan"],
  italian: ["italian", "pizza", "pasta", "sicilian", "tuscan"],
  japanese: ["japanese", "sushi", "ramen", "izakaya"],
  thai: ["thai"],
  mexican: ["mexican", "taqueria", "taco"],
  korean: ["korean", "bbq"],
  american: ["american", "bbq", "diner"],
  vietnamese: ["vietnamese", "pho", "banh mi", "bahn mi"],
  mediterranean: ["mediterranean", "greek", "turkish", "lebanese"],
  "middle eastern": ["middle eastern", "lebanese", "turkish", "persian", "iranian"],
  spanish: ["spanish", "tapas"],
  french: ["french", "bistro", "brasserie"],
  greek: ["greek"],
  turkish: ["turkish"],
  lebanese: ["lebanese"],
  persian: ["persian", "iranian"],

  // Fast Food (as requested: just "fast")
  "fast food": ["fast"],
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
  const display = (r.primaryTypeDisplayName || r.name || "").toLowerCase();
  for (const k of keywordSet) {
    const needle = k.replace(/\s+/g, "_");
    if (primary.includes(needle)) return true;
    if (types.some((t) => t.includes(needle))) return true;
    if (display.includes(k)) return true;
  }
  return false;
}

function textIncludesAny(r, needles) {
  const fields = [
    lc(r.name),
    lc(r.primaryTypeDisplayName),
    lc(r.editorialSummary),
  ].filter(Boolean);
  return needles.some((n) => fields.some((f) => f.includes(n)));
}

// Requirements come from user.dietaryNeeds (renamed to “Requirements” in UI):
// "Vegetarian", "Pet Friendly", "Parking"
function requirementsFromUser(user) {
  const needs = new Set((user?.dietaryNeeds || []).map((x) => norm(x)));
  return {
    vegetarian: needs.has("vegetarian"),
    petFriendly: needs.has("pet friendly"),
    parking: needs.has("parking"),
  };
}

// DB has booleans: servesVegetarianFood, allowsDogs.
// Parking may be absent; try best-effort with text/types if not available.
function restaurantMeetsRequirements(r, req) {
  let ok = true;

  if (req.vegetarian) {
    const hasField = r.servesVegetarianFood === true;
    const hasType = Array.isArray(r.types) && r.types.map(lc).includes("vegetarian_restaurant");
    const hasText = textIncludesAny(r, ["vegetarian", "vegan"]);
    ok = ok && (hasField || hasType || hasText);
  }

  if (req.petFriendly) {
    const hasField = r.allowsDogs === true; // Prisma boolean
    const hasText = textIncludesAny(r, ["dog friendly", "pet friendly", "dogs welcome"]);
    ok = ok && (hasField || hasText);
  }

  if (req.parking) {
    // Try structured field if present; otherwise text-y guess.
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
 * Preference filter (requirements → cuisines → distance).
 * 1) Enforce requirements first (hard filter).
 * 2) Within those, take cuisine matches by nearest first; then non-cuisine within requirements.
 * 3) If still short, relax requirements (use nearest cuisine matches, then nearest others).
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

  // Respect user radius; null means unlimited
  const within = Number.isFinite(radiusKm) ? withDist.filter((x) => x.d <= radiusKm) : withDist;

  const byCuisine = (rows) =>
    rows
      .filter(({ r }) => restaurantMatchesCuisine(r, keys))
      .sort((a, b) => a.d - b.d)
      .map((x) => x.r);

  const byNearest = (rows) => rows.sort((a, b) => a.d - b.d).map((x) => x.r);

  // 1) Apply requirements if any were set
  const reqRows = hasAnyReq ? within.filter(({ r }) => restaurantMeetsRequirements(r, req)) : within;
  const nonReqRows = hasAnyReq ? within.filter(({ r }) => !restaurantMeetsRequirements(r, req)) : [];

  let merged = [];

  // 2) Fill from requirement-compliant rows first
  const reqCuisine = byCuisine(reqRows);
  merged.push(...reqCuisine);
  if (merged.length < desiredMin) {
    const reqNearest = byNearest(reqRows).filter((r) => !merged.includes(r));
    merged.push(...reqNearest);
  }

  // 3) If still short, relax requirements to avoid empty pools
  if (merged.length < desiredMin && nonReqRows.length) {
    const nonReqCuisine = byCuisine(nonReqRows).filter((r) => !merged.includes(r));
    merged.push(...(nonReqCuisine);
    if (merged.length < desiredMin) {
      const nonReqNearest = byNearest(nonReqRows).filter((r) => !merged.includes(r));
      merged.push(...nonReqNearest);
    }
  }

  // Ensure at least something is returned (fully relaxed)
  if (!merged.length) merged = byNearest(within);

  return merged.slice(0, Math.max(desiredMin, 1));
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
      orderBy: { startedAt: "desc" },
      include: { events: true },
    });
    if (!session) {
      session = await prisma.swipeSession.create({ data: { userId: user.id } });
    }

    // Build the pool; radius is user.searchDistance (km) or default 15
    const radiusKm = user.searchDistance === null ? Infinity : Number(user.searchDistance || 15);
    const pool = await ensureNearbyRestaurants(lat, lng, minPool);
    const filteredPool = filterAndPrioritizeByPreferences(pool, user, lat, lng, Math.max(60, minPool), radiusKm);

    console.log(`[recs/start] user=${user.id} pool=${pool.length} prefPool=${filteredPool.length} radiusKm=${radiusKm}`);

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
        ...(user.dietaryNeeds || []).map((d) => `ureq:${d}`), // requirements as features
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
    if (!session || session.userId !== user.id || session.status !== "active") {
      return res.status(400).json({ error: "Invalid session" });
    }

    // Optional session cap — front-end also prompts at 15
    const SESSION_MAX_SWIPES = 60; // allow long browsing, but not infinite
    if ((session.totalSwipes ?? session.events.length) >= SESSION_MAX_SWIPES) {
      return res.json({ items: [], sessionCompleted: true });
    }

    const swipedIds = new Set(session.events.map((e) => e.restaurantId));
    const clientExcluded = new Set(
      Array.isArray(excludeIds) ? excludeIds.filter((x) => typeof x === "string") : []
    );

    const radiusKm = user.searchDistance === null ? Infinity : Number(user.searchDistance || 15);
    const pool = await ensureNearbyRestaurants(lat, lng, 100);
    const prefPool = filterAndPrioritizeByPreferences(pool, user, lat, lng, 100, radiusKm);

    // Remove anything already swiped or explicitly excluded by the client
    const candidates = prefPool.filter(
      (r) => !swipedIds.has(r.id) && !clientExcluded.has(r.id)
    );

    const basePool = candidates.length
      ? candidates
      : pool.filter((r) => !swipedIds.has(r.id) && !clientExcluded.has(r.id));

    if (!basePool.length) {
      console.log(`[recs/next] user=${user.id} cand=0 → returning empty`);
      return res.json({ items: [] });
    }

    const items = basePool.map((r) => {
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
              ...(user.dietaryNeeds || []).map((d) => `ureq:${d}`),
            ],
          },
          items,
          interactions,
        }),
      });
      if (r.ok) {
        const ranked = await r.json();
        const candidateSet = new Set(basePool.map((x) => x.id));
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
      const missing = basePool.filter((r) => !wantIds.includes(r.id)).slice(0, need);
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
        // include requirement booleans if present (can help client-side badges)
        servesVegetarianFood: r.servesVegetarianFood ?? null,
        allowsDogs: r.allowsDogs ?? null,
      };
    });

    console.log(
      `[recs/next] user=${user.id} nearby=${pool.length} pref=${prefPool.length} cand=${basePool.length} returned=${clientItems.length}`
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
    if (!sessionId || !restaurantId || !["LIKE", "PASS", "SUPERSTAR"].includes(String(action || "").toUpperCase())) {
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
        data: { sessionId, userId: user.id, restaurantId, action: String(action).toUpperCase(), position },
      });
      await tx.swipeSession.update({
        where: { id: sessionId },
        data: { totalSwipes: { increment: 1 } },
      });
      if (String(action).toUpperCase() === "SUPERSTAR") {
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
    const SESSION_MAX_SWIPES = 60;
    const sessionCompleted = nextCount >= SESSION_MAX_SWIPES;

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
