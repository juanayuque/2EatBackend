// src/services/placesService.js
// Service responsible for Places discovery/ingest and nearby pool maintenance.
// Uses global fetch (Node 18+) or dynamically imports node-fetch in CJS.

const { normalizePriceLevel } = require("../utils/price");
const { haversineKm, asFloat } = require("../utils/geo");

// Use global fetch if present; otherwise dynamically import node-fetch (ESM) from CJS.
const fetchFn =
  (typeof fetch === "function" && fetch) ||
  ((...args) => import("node-fetch").then((mod) => mod.default(...args)));

// Backfill throttle
let _lastBackfillAt = 0;
const BACKFILL_MIN_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

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

function mapPlaceToRestaurantCreate(place) {
  const loc = place.location || {};
  const displayName = place.displayName?.text || place.displayName || place.name || "Unknown";
  const priceLevel = normalizePriceLevel(place.priceLevel);
  const ptdnRaw = place.primaryTypeDisplayName;
  const ptdn =
    typeof ptdnRaw === "string" ? ptdnRaw : ptdnRaw && ptdnRaw.text ? ptdnRaw.text : null;

  return {
    restaurant: {
      googlePlaceId: place.id,
      name: displayName,
      latitude: String(loc.latitude ?? 0),
      longitude: String(loc.longitude ?? 0),
      formattedAddress: place.formattedAddress || null,
      internationalPhoneNumber: place.nationalPhoneNumber || null,
      websiteUri: place.websiteUri || null,
      primaryTypeDisplayName: ptdn,
      primaryType: place.primaryType || null,
      types: Array.isArray(place.types) ? place.types : [],
      rating: place.rating != null ? String(place.rating) : null,
      userRatingCount: place.userRatingCount ?? null,
      editorialSummary: place.editorialSummary?.text || null,
      priceLevel,
      // Flags default; real enrichment elsewhere
      servesVegetarian: false, // DB: serves_vegetarian
      takeout: false,
      dineIn: false,
      curbsidePickup: false,
      delivery: false,
      outdoorSeating: false,
      allowsDogs: false, // DB: allows_dogs
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

function createPlacesService({ prisma, googleApiKey }) {
  const hasKey = !!googleApiKey;

  async function googlePlacesSearchNearby(
    lat,
    lng,
    {
      radiusMeters = 8000,
      maxPages = 3,
      rankPreference = "POPULARITY",
      includedTypes = ["restaurant"],
    } = {}
  ) {
    if (!hasKey) return [];
    const results = [];
    let pageToken;

    for (let i = 0; i < maxPages; i++) {
      const body = {
        includedTypes,
        maxResultCount: 20,
        rankPreference,
        locationRestriction: {
          circle: { center: { latitude: lat, longitude: lng }, radius: radiusMeters },
        },
        pageToken,
      };

      const r = await fetchFn("https://places.googleapis.com/v1/places:searchNearby", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": googleApiKey,
          "X-Goog-FieldMask": PLACES_FIELD_MASK,
        },
        body: JSON.stringify(body),
      });

      if (!r.ok) {
        const e = await r.text().catch(() => "");
        console.error("[placesService] searchNearby err", r.status, e.slice(0, 300));
        break;
      }
      const json = await r.json();
      results.push(...(json.places || []));
      pageToken = json.nextPageToken;
      if (!pageToken) break;
    }
    return results;
  }

  // NEW: Text Search with location bias (for requirements-focused queries)
  async function googlePlacesSearchText(
    textQuery,
    {
      latitude,
      longitude,
      radiusMeters = 6000,
      maxResults = 20,
    } = {}
  ) {
    if (!hasKey || !textQuery) return [];
    const body = {
      textQuery: String(textQuery),
      maxResultCount: Math.max(1, Math.min(20, maxResults)),
      locationBias: {
        circle: {
          center: { latitude, longitude },
          radius: Math.max(500, Math.min(20000, radiusMeters)),
        },
      },
    };

    const r = await fetchFn("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": googleApiKey,
        "X-Goog-FieldMask": PLACES_FIELD_MASK,
      },
      body: JSON.stringify(body),
    });

    if (!r.ok) {
      const e = await r.text().catch(() => "");
      console.error("[placesService] searchText err", r.status, e.slice(0, 300));
      return [];
    }

    const json = await r.json();
    return json.places || [];
  }

  async function upsertPlacesBatch(placesArr) {
    const ids = placesArr.map((p) => p.id).filter(Boolean);
    if (ids.length === 0) return 0;

    const existing = await prisma.restaurant.findMany({
      where: { googlePlaceId: { in: ids } },
      select: { googlePlaceId: true },
    });
    const existingSet = new Set(existing.map((x) => x.googlePlaceId));
    let created = 0;

    for (const p of placesArr) {
      if (!p?.id || existingSet.has(p.id)) continue;
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
      created++;

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
    console.log(`[placesService] upsert new=${created} skipped=${ids.length - created}`);
    return created;
  }

  async function backfillMissingPlaceMetadata(restaurants) {
    if (!hasKey) return;
    const missing = restaurants.filter(
      (r) => !r.primaryType || !r.types || r.types.length === 0 || r.priceLevel == null
    );
    if (!missing.length) return;

    console.log(`[placesService] backfill metadata for ${missing.length} restaurants…`);
    for (const r of missing.slice(0, 50)) {
      try {
        const name = toPlaceName(r.googlePlaceId);
        const url = `https://places.googleapis.com/v1/${name}?fields=${encodeURIComponent(
          "id,primaryType,primaryTypeDisplayName,types,priceLevel"
        )}`;
        const res = await fetchFn(url, { headers: { "X-Goog-Api-Key": googleApiKey } });
        if (!res.ok) continue;
        const d = await res.json();
        const ptdnRaw = d.primaryTypeDisplayName;
        const ptdn =
          typeof ptdnRaw === "string"
            ? ptdnRaw
            : ptdnRaw && ptdnRaw.text
            ? ptdnRaw.text
            : r.primaryTypeDisplayName || null;

        await prisma.restaurant.update({
          where: { id: r.id },
          data: {
            primaryType: d.primaryType || r.primaryType || null,
            primaryTypeDisplayName: ptdn,
            types: Array.isArray(d.types) ? d.types : r.types || [],
            priceLevel: normalizePriceLevel(d.priceLevel ?? r.priceLevel ?? null),
          },
        });
      } catch {}
    }
  }

  async function ensureNearbyRestaurants(lat, lng, minCount = 100, radiusKm = 15) {
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
      .filter((x) => Number.isFinite(x.d) && x.d <= radiusKm)
      .sort((a, b) => a.d - b.d)
      .map((x) => x.r);

    if (nearby.length < minCount && hasKey) {
      console.log(`[placesService] nearby=${nearby.length} < ${minCount} → ingesting Places…`);

      const radiusMeters = Math.max(2000, Math.min(20000, Math.round(radiusKm * 1000 * 1.2)));

      const popular = await googlePlacesSearchNearby(lat, lng, {
        radiusMeters,
        maxPages: 3,
        rankPreference: "POPULARITY",
      });
      const distance = await googlePlacesSearchNearby(lat, lng, {
        radiusMeters,
        maxPages: 3,
        rankPreference: "DISTANCE",
      });
      const uniq = new Map();
      for (const p of [...popular, ...distance]) if (p?.id && !uniq.has(p.id)) uniq.set(p.id, p);
      const list = Array.from(uniq.values());

      console.log(`[placesService] ingested places (unique): ${list.length}`);
      if (list.length) {
        await upsertPlacesBatch(list);
        const refreshed = await prisma.restaurant.findMany({
          take: 2000,
          include: { photos: { take: 1 } },
        });
        nearby = refreshed
          .map((r) => ({
            r,
            d: haversineKm(here, { lat: asFloat(r.latitude), lng: asFloat(r.longitude) }),
          }))
          .filter((x) => Number.isFinite(x.d) && x.d <= radiusKm)
          .sort((a, b) => a.d - b.d)
          .map((x) => x.r);
      }
    }

    const now = Date.now();
    if (now - _lastBackfillAt >= BACKFILL_MIN_INTERVAL_MS) {
      _lastBackfillAt = now;
      backfillMissingPlaceMetadata(nearby).catch(() => {});
    }

    console.log(`[placesService] ensureNearby: ${nearby.length} within ${radiusKm}km`);
    return nearby;
  }

  return {
    ensureNearbyRestaurants,
    googlePlacesSearchNearby,
    googlePlacesSearchText, // 👈 NEW export
    upsertPlacesBatch,
    backfillMissingPlaceMetadata,
    mapPlaceToRestaurantCreate,
  };
}

module.exports = { createPlacesService };
