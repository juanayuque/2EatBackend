// src/services/placesService.js
// Centralised Google Places helpers + DB upserts

const { haversineKm, asFloat } = require("../utils/geo");

// Use global fetch (Node 18+) or fall back to node-fetch.
const fetchFn =
  (typeof fetch === "function" && fetch) ||
  ((...args) => import("node-fetch").then((m) => m.default(...args)));

function bboxFromCenter(lat, lng, radiusKm) {
  const dLat = radiusKm / 111;
  const dLng = radiusKm / (111 * Math.cos((lat * Math.PI) / 180));
  return { minLat: lat - dLat, maxLat: lat + dLat, minLng: lng - dLng, maxLng: lng + dLng };
}

/**
 * Normalise a Google Places object (Search or Details v1) into our DB shape.
 * Crucially: preserves photos[].name so our photo proxy can build URLs.
 */
function parseGooglePlace(p = {}) {
  const id =
    p.id ||
    p.googlePlaceId ||
    p.placeId ||
    p.place_id ||
    (typeof p.name === "string" && p.name.includes("/") ? p.name.split("/").pop() : undefined);

  const lat =
    p.latitude ??
    p.location?.latitude ??
    p.location?.latLng?.latitude ??
    p.geometry?.location?.lat ??
    p.lat;

  const lng =
    p.longitude ??
    p.location?.longitude ??
    p.location?.latLng?.longitude ??
    p.geometry?.location?.lng ??
    p.lng;

  const displayName = p.displayName?.text || p.title || "";

  const editorialSummary = p.editorialSummary?.text || p.editorial_summary || null;

  // photos → keep canonical resource name + dims only
  const photos = Array.isArray(p.photos)
    ? p.photos
        .map((ph) => {
          const name =
            ph?.name ||
            (typeof ph?.photo_reference === "string" ? ph.photo_reference : null);
          if (!name) return null;
          return {
            name,
            widthPx: ph.widthPx ?? ph.width ?? null,
            heightPx: ph.heightPx ?? ph.height ?? null,
          };
        })
        .filter(Boolean)
    : [];

  // Simple heuristic if explicit flags are absent
  const dogsHeuristic = /\bdog[- ]?friendly\b|\bpet[- ]?friendly\b|\bdogs welcome\b/i.test(
    `${editorialSummary || ""} ${displayName}`
  );

  return {
    id,
    googlePlaceId: id,
    name: displayName || "",
    latitude: lat,
    longitude: lng,
    formattedAddress: p.formattedAddress || p.vicinity || p.formatted_address || null,
    primaryTypeDisplayName: p.primaryTypeDisplayName?.text || p.primaryTypeDisplayName || null,
    primaryType: p.primaryType || (Array.isArray(p.types) ? p.types[0] : null),
    types: Array.isArray(p.types) ? p.types : [],
    rating: p.rating ?? null,
    userRatingCount: p.userRatingCount ?? p.user_ratings_total ?? null,
    priceLevel: p.priceLevel ?? p.price_level ?? null,
    servesVegetarianFood: p.servesVegetarianFood ?? null,
    editorialSummary,
    photos, // <- keep photos
    takeout: p.takeout ?? null,
    dineIn: p.dineIn ?? p.dine_in ?? null,
    curbsidePickup: p.curbsidePickup ?? p.curbside_pickup ?? null,
    delivery: p.delivery ?? null,
    outdoorSeating: p.outdoorSeating ?? p.outdoor_seating ?? null,
    allowsDogs: p.allowsDogs ?? (dogsHeuristic ? true : null),
    parkingOptions: p.parkingOptions ?? null,
    websiteUri: p.websiteUri ?? p.website_uri ?? null,
    internationalPhoneNumber: p.internationalPhoneNumber ?? p.international_phone_number ?? null,
    plusCode: p.plusCode ?? p.plus_code ?? null,
  };
}

/**
 * Lightweight Places Details (v1). Return the raw Place; the caller can merge
 * with a search result and we’ll normalise inside upsert.
 */
async function fetchPlaceDetailsV1(placeId) {
  const key = process.env.GOOGLE_API_KEY || process.env.PLACES_API_KEY;
  if (!key) throw new Error("Missing GOOGLE_API_KEY/PLACES_API_KEY");
  const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(
    placeId
  )}?languageCode=en`;
  const headers = {
    "X-Goog-Api-Key": key,
    "X-Goog-FieldMask": [
      "id",
      "displayName",
      "formattedAddress",
      "location",
      "primaryType",
      "primaryTypeDisplayName",
      "types",
      "priceLevel",
      "editorialSummary",
      "photos.name",
      "photos.widthPx",
      "photos.heightPx",
      "websiteUri",
      "internationalPhoneNumber",
    ].join(","),
  };
  const r = await fetchFn(url, { headers });
  if (!r.ok) throw new Error(`details ${r.status}`);
  return await r.json();
}

function createPlacesService({ prisma, googleApiKey }) {
  // Conservative field mask that includes photos
  const GOOGLE_FIELD_MASK = [
    "places.id",
    "places.displayName",
    "places.formattedAddress",
    "places.location",
    "places.primaryType",
    "places.primaryTypeDisplayName",
    "places.types",
    "places.rating",
    "places.userRatingCount",
    "places.priceLevel",
    "places.editorialSummary",
    "places.websiteUri",
    "places.googleMapsUri",
    "places.nationalPhoneNumber",
    "places.internationalPhoneNumber",
    "places.regularOpeningHours.openNow",
    "places.photos.name",
    "places.photos.widthPx",
    "places.photos.heightPx",
  ].join(",");

  async function ensureNearbyRestaurants(lat, lng, minCount = 100, radiusKm = 15) {
    const box = bboxFromCenter(lat, lng, radiusKm);
    const rows = await prisma.restaurant.findMany({
      where: {
        latitude: { gte: box.minLat, lte: box.maxLat },
        longitude: { gte: box.minLng, lte: box.maxLng },
      },
      take: Math.max(minCount * 3, 300),
    });
    const here = { lat, lng };
    const withDist = rows.map((r) => ({
      r,
      d: haversineKm(here, { lat: asFloat(r.latitude), lng: asFloat(r.longitude) }),
    }));
    withDist.sort((a, b) => a.d - b.d);
    return withDist.map((x) => x.r).slice(0, Math.max(minCount, 1));
  }

  /**
   * Variant with strict filters combined via AND (vegetarian / pet-friendly / parking).
   */
  async function ensureNearbyRestaurantsStrict(lat, lng, minCount = 100, radiusKm = 15, req = {}) {
    const box = bboxFromCenter(lat, lng, radiusKm);

    const petTextOR = [
      { name: { contains: "dog", mode: "insensitive" } },
      { name: { contains: "pet friendly", mode: "insensitive" } },
      { editorialSummary: { contains: "dog", mode: "insensitive" } },
      { editorialSummary: { contains: "dogs welcome", mode: "insensitive" } },
      { editorialSummary: { contains: "pet friendly", mode: "insensitive" } },
    ];

    const parkTextOR = [
      { editorialSummary: { contains: "parking", mode: "insensitive" } },
      { editorialSummary: { contains: "car park", mode: "insensitive" } },
      { name: { contains: "parking", mode: "insensitive" } },
      { name: { contains: "car park", mode: "insensitive" } },
    ];

    const vegTextOR = [
      { editorialSummary: { contains: "vegetarian", mode: "insensitive" } },
      { editorialSummary: { contains: "vegan", mode: "insensitive" } },
      { name: { contains: "vegetarian", mode: "insensitive" } },
      { name: { contains: "vegan", mode: "insensitive" } },
    ];

    const where = {
      latitude: { gte: box.minLat, lte: box.maxLat },
      longitude: { gte: box.minLng, lte: box.maxLng },
      AND: [],
    };

    if (req?.vegetarian) {
      where.AND.push({
        OR: [{ servesVegetarianFood: true }, { types: { has: "vegetarian_restaurant" } }, ...vegTextOR],
      });
    }
    if (req?.petFriendly) {
      where.AND.push({ OR: [{ allowsDogs: true }, ...petTextOR] });
    }
    if (req?.parking) {
      where.AND.push({ OR: [{ NOT: { parkingOptions: null } }, ...parkTextOR] });
    }
    if (where.AND.length === 0) delete where.AND;

    const rows = await prisma.restaurant.findMany({
      where,
      take: Math.max(minCount * 5, 800),
    });

    const here = { lat, lng };
    const withDist = rows.map((r) => ({
      r,
      d: haversineKm(here, { lat: asFloat(r.latitude), lng: asFloat(r.longitude) }),
    }));
    withDist.sort((a, b) => a.d - b.d);
    return withDist.map((x) => x.r);
  }

  /**
   * Upsert a batch of places. Uses per-item upsert so we can write related photos
   * with connectOrCreate (createMany cannot do nested writes).
   * Assumes Photo.name is unique in the Prisma schema.
   */
  async function upsertPlacesBatch(placesArr) {
    const normalized = [];
    for (const raw of Array.from(placesArr || [])) {
      const already =
        raw && typeof raw === "object" && raw.googlePlaceId && raw.latitude != null && raw.longitude != null;
      const p = already ? raw : parseGooglePlace(raw);
      if (!p?.googlePlaceId || !p?.latitude || !p?.longitude) continue;
      normalized.push(p);
    }
    if (!normalized.length) return { created: 0, createdIds: [], updated: 0 };

    let created = 0;
    const createdIds = [];

    for (const p of normalized) {
      const id = String(p.googlePlaceId);

      const baseData = {
        googlePlaceId: id,
        name: p.name || "Unknown",
        latitude: Number(p.latitude),
        longitude: Number(p.longitude),
        formattedAddress: p.formattedAddress ?? null,
        internationalPhoneNumber: p.internationalPhoneNumber ?? null,
        websiteUri: p.websiteUri ?? null,
        primaryTypeDisplayName: p.primaryTypeDisplayName ?? null,
        primaryType: p.primaryType ?? null,
        types: Array.isArray(p.types) ? p.types : [],
        rating: p.rating != null ? Number(p.rating) : null,
        userRatingCount: p.userRatingCount || 0,
        priceLevel: p.priceLevel != null ? Number(p.priceLevel) : null,
        servesVegetarianFood: p.servesVegetarianFood == null ? null : p.servesVegetarianFood === true,
        editorialSummary: p.editorialSummary ?? null,
        plusCode: p.plusCode ?? null,
        takeout: p.takeout == null ? null : p.takeout === true,
        dineIn: p.dineIn == null ? null : p.dineIn === true,
        curbsidePickup: p.curbsidePickup == null ? null : p.curbsidePickup === true,
        delivery: p.delivery == null ? null : p.delivery === true,
        outdoorSeating: p.outdoorSeating == null ? null : p.outdoorSeating === true,
        allowsDogs: p.allowsDogs == null ? null : !!p.allowsDogs,
        parkingOptions: p.parkingOptions ?? null,
      };

      const photoWrites =
        Array.isArray(p.photos) && p.photos.length
          ? {
              connectOrCreate: p.photos.map((ph) => ({
                where: { name: ph.name }, // Photo.name must be unique
                create: {
                  name: ph.name,
                  widthPx: ph.widthPx ?? null,
                  heightPx: ph.heightPx ?? null,
                },
              })),
            }
          : undefined;

      const res = await prisma.restaurant.upsert({
        where: { googlePlaceId: id },
        create: { ...baseData, photos: photoWrites },
        update: { ...baseData, photos: photoWrites },
        select: { googlePlaceId: true, createdAt: true, updatedAt: true },
      });

      if (res && res.createdAt.getTime() === res.updatedAt.getTime()) {
        created++;
        createdIds.push(id);
      }
    }

    return { created, createdIds, updated: normalized.length - created };
  }

  async function googlePlacesSearchNearby(
    lat,
    lng,
    { radiusMeters = 3000, maxPages = 3, rankPreference = "POPULARITY", includedTypes = ["restaurant"] } = {}
  ) {
    if (!googleApiKey) return [];
    const out = [];
    let pageToken = null;

    for (let page = 0; page < maxPages; page++) {
      const body = {
        includedTypes,
        maxResultCount: 20,
        rankPreference,
        locationRestriction: {
          circle: {
            center: { latitude: lat, longitude: lng },
            radius: radiusMeters,
          },
        },
      };

      const url = pageToken
        ? `https://places.googleapis.com/v1/places:searchNearby?pageToken=${encodeURIComponent(pageToken)}`
        : `https://places.googleapis.com/v1/places:searchNearby`;

      const r = await fetchFn(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": googleApiKey,
          "X-Goog-FieldMask": GOOGLE_FIELD_MASK,
        },
        body: JSON.stringify(body),
      });

      if (!r.ok) break;

      const j = await r.json();
      const places = Array.isArray(j.places) ? j.places : [];
      out.push(...places.map(parseGooglePlace));

      if (!j.nextPageToken) break;
      pageToken = j.nextPageToken;

      // nextPageToken needs a short delay before it becomes valid
      await new Promise((res) => setTimeout(res, 1500));
    }
    return out;
  }

  async function googlePlacesSearchText(
    query,
    { lat, lng, radiusMeters = 3000, maxPages = 2 } = {}
  ) {
    if (!googleApiKey) return [];
    const out = [];
    let pageToken = null;

    for (let page = 0; page < maxPages; page++) {
      const body = {
        textQuery: String(query || "").trim(),
        maxResultCount: 20,
        locationBias: {
          circle: {
            center: { latitude: lat, longitude: lng },
            radius: radiusMeters,
          },
        },
      };

      const url = pageToken
        ? `https://places.googleapis.com/v1/places:searchText?pageToken=${encodeURIComponent(pageToken)}`
        : `https://places.googleapis.com/v1/places:searchText`;

      const r = await fetchFn(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": googleApiKey,
          "X-Goog-FieldMask": GOOGLE_FIELD_MASK,
        },
        body: JSON.stringify(body),
      });

      if (!r.ok) break;

      const j = await r.json();
      const places = Array.isArray(j.places) ? j.places : [];
      out.push(...places.map(parseGooglePlace));

      if (!j.nextPageToken) break;
      pageToken = j.nextPageToken;

      await new Promise((res) => setTimeout(res, 1500));
    }
    return out;
  }

  return {
    ensureNearbyRestaurants,
    ensureNearbyRestaurantsStrict,
    upsertPlacesBatch,
    googlePlacesSearchNearby,
    googlePlacesSearchText,
    fetchPlaceDetailsV1, 
  };
}

module.exports = { createPlacesService };
