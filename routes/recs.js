// routes/recs.js
const express = require("express");
const prisma = require("../src/prisma");
const verifyFirebaseToken = require("../middleware/auth");

const router = express.Router();

// --- Public health checks (no auth) ---
router.get("/__ping", (_req, res) => res.json({ ok: true, via: "recs", ts: Date.now() }));
router.get("/health", (_req, res) => res.json({ ok: true }));

// Everything below here requires a Firebase ID token
router.use(verifyFirebaseToken);

const RECS_SERVICE_URL = process.env.RECS_SERVICE_URL || "http://127.0.0.1:8000";
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY; // <- we read this to talk to Places v1

// ---------------------------------------------------------------------
// Small math helpers (unchanged)
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
// 🧩 NEW: Places v1 ingestion + backfill
// I only call Google if (1) we don't have enough nearby rows or
// (2) some nearby rows are missing primaryType/types (backfill).
// ---------------------------------------------------------------------

// I keep the field mask tight so we only pay for the data we store/use.
const PLACES_FIELD_MASK =
  [
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

// I use the official v1 `places:searchNearby` so I can get primaryType/types directly.
async function googlePlacesSearchNearby(lat, lng, radiusMeters = 6000, maxPages = 3) {
  if (!GOOGLE_API_KEY) return []; // hard-fail to "no ingestion" if key missing

  const results = [];
  let pageToken = undefined;

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

// I map a Places v1 "place" into our Restaurant + Photo shape.
function mapPlaceToRestaurantCreate(place) {
  const loc = place.location || {};
  const displayName = place.displayName?.text || place.displayName || place.name || "Unknown";

  return {
    restaurant: {
      googlePlaceId: place.id, // stable ID in v1
      name: displayName,
      latitude: String(loc.latitude ?? 0),
      longitude: String(loc.longitude ?? 0),
      formattedAddress: place.formattedAddress || null,
      internationalPhoneNumber: place.nationalPhoneNumber || null,
      websiteUri: place.websiteUri || null,
      primaryTypeDisplayName: place.primaryTypeDisplayName || null,

      // 👇 New fields pulled from Places v1
      primaryType: place.primaryType || null,
      types: Array.isArray(place.types) ? place.types : [],

      rating: place.rating != null ? String(place.rating) : null, // Prisma Decimal accepts string
      userRatingCount: place.userRatingCount ?? null,
      priceLevel: place.priceLevel ?? null,
      // These boolean flags are best-effort; not always available from Places v1 directly.
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

    // I only persist the first photo to keep the DB slim (you already fetch by name)
    photo: place.photos?.[0]
      ? {
          name: place.photos[0].name,
          widthPx: place.photos[0].widthPx || null,
          heightPx: place.photos[0].heightPx || null,
        }
      : null,
  };
}

// I upsert a batch of Places into our DB; duplicates are keyed by googlePlaceId.
async function upsertPlacesBatch(places) {
  for (const p of places) {
    const mapped = mapPlaceToRestaurantCreate(p);

    // Upsert the restaurant
    const r = await prisma.restaurant.upsert({
      where: { googlePlaceId: mapped.restaurant.googlePlaceId },
      create: mapped.restaurant,
      update: {
        // I update lightweight fields that might change
        name: mapped.restaurant.name,
        formattedAddress: mapped.restaurant.formattedAddress,
        websiteUri: mapped.restaurant.websiteUri,
        primaryTypeDisplayName: mapped.restaurant.primaryTypeDisplayName,
        primaryType: mapped.restaurant.primaryType, // 👈 keep it fresh
        types: mapped.restaurant.types,             // 👈 keep it fresh
        rating: mapped.restaurant.rating,
        userRatingCount: mapped.restaurant.userRatingCount,
        priceLevel: mapped.restaurant.priceLevel,
      },
    });

    // Upsert/create the first photo if present and new
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

// For older rows missing primaryType/types, I backfill by fetching place details (small, capped concurrency).
async function backfillMissingPlaceMetadata(restaurants, concurrency = 2) {
  if (!GOOGLE_API_KEY) return;

  const missing = restaurants.filter(
    (r) => !r.primaryType || !r.types || r.types.length === 0
  );

  // Nothing to do
  if (!missing.length) return;

  const chunks = [];
  for (let i = 0; i < missing.length; i += concurrency) {
    chunks.push(missing.slice(i, i + concurrency));
  }

  // I run this in small waves to avoid hammering the API
  for (const group of chunks) {
    await Promise.all(
      group.map(async (r) => {
        try {
          // Places v1 details
          const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(
            r.googlePlaceId
          )}?fields=${encodeURIComponent(
            "id,primaryType,primaryTypeDisplayName,types"
          )}`;

          const res = await fetch(url, {
            headers: { "X-Goog-Api-Key": GOOGLE_API_KEY },
          });
          if (!res.ok) return;
          const d = await res.json();

          await prisma.restaurant.update({
            where: { id: r.id },
            data: {
              primaryType: d.primaryType || r.primaryType || null,
              primaryTypeDisplayName:
                d.primaryTypeDisplayName || r.primaryTypeDisplayName || null,
              types: Array.isArray(d.types) ? d.types : r.types || [],
            },
          });
        } catch {
          // best-effort; ignore failures
        }
      })
    );
  }
}

/**
 * My nearby resolver stays DB-first (cheap). If the pool is too small, I do a quick
 * Google Places v1 ingest to boost coverage, then re-query locally. I also kick off
 * a background backfill for legacy rows missing primaryType/types.
 */
async function ensureNearbyRestaurants(lat, lng, minCount = 100) {
  // 1) Pull a chunk from the DB and filter by distance in-process (no PostGIS needed)
  const all = await prisma.restaurant.findMany({
    take: 600,
    include: { photos: { take: 1 } },
  });

  const here = { lat, lng };
  let nearby = all
    .map((r) => ({
      r,
      d: haversineKm(here, { lat: Number(r.latitude), lng: Number(r.longitude) }),
    }))
    .filter((x) => Number.isFinite(x.d) && x.d <= 15) // 15km envelope
    .sort((a, b) => a.d - b.d)
    .map((x) => x.r);

  // 2) If we don't have enough locally, ingest a few pages from Places v1 and try again
  if (nearby.length < minCount && GOOGLE_API_KEY) {
    const places = await googlePlacesSearchNearby(lat, lng, /*meters*/ 10000, /*pages*/ 3);
    if (places.length) {
      await upsertPlacesBatch(places);
      // Re-query (I only pull a modest number; we already have the fresh rows in DB)
      const refreshed = await prisma.restaurant.findMany({
        take: 800,
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

  // 3) Kick off best-effort backfill for missing primaryType/types (don’t block the request)
  //    I purposefully don't await this—it's fire-and-forget.
  backfillMissingPlaceMetadata(nearby).catch(() => {});

  return nearby;
}
