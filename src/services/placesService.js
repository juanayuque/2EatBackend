// src/services/placesService.js
// Centralised Google Places helpers + DB upserts

const { haversineKm, asFloat } = require("../utils/geo");

// Use global fetch when available (Node 18+). Fall back to node-fetch with proper argument spreading.
const fetchFn =
  (typeof fetch === "function" && fetch) ||
  (async (...args) => (await import("node-fetch")).default(...args));

function bboxFromCenter(lat, lng, radiusKm) {
  const dLat = radiusKm / 111;
  const dLng = radiusKm / (111 * Math.cos((lat * Math.PI) / 180));
  return { minLat: lat - dLat, maxLat: lat + dLat, minLng: lng - dLng, maxLng: lng + dLng };
}

// Normalises Google Places objects into the shape used by the DB layer
function parseGooglePlace(p) {
  const id =
    p.id ||
    p.googlePlaceId ||
    p.placeId ||
    p.place_id ||
    (p.name && p.name.split("/").pop());

  // Places v1 returns coordinates under `location.{latitude,longitude}`; older shapes also supported
    const lat =
    p.latitude ??
    p.location?.latitude ??
    p.location?.latLng?.latitude ??
    p.geometry?.location?.lat ??
    p.lat;

  const lng =
    p.location?.longitude ??
    p.location?.latLng?.longitude ??
    p.geometry?.location?.lng ??
    p.lng;

  // `p.name` is often a resource path like "places/<id>", so avoid using it as the human name
  const displayName = p.displayName?.text || p.title || "";

  const editorialSummary = p.editorialSummary?.text || p.editorial_summary || null;

  // Simple heuristic for pet-friendly signals in absence of explicit fields
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
    takeout: p.takeout ?? null,
    dineIn: p.dineIn ?? p.dine_in ?? null,
    curbsidePickup: p.curbsidePickup ?? p.curbside_pickup ?? null,
    delivery: p.delivery ?? null,
    outdoorSeating: p.outdoorSeating ?? p.outdoor_seating ?? null,
    // Keep null when unknown so downstream filters don't treat "unknown" as "no"
    allowsDogs: p.allowsDogs ?? (dogsHeuristic ? true : null),
    parkingOptions: p.parkingOptions ?? null,
    websiteUri: p.websiteUri ?? p.website_uri ?? null,
    internationalPhoneNumber: p.internationalPhoneNumber ?? p.international_phone_number ?? null,
    plusCode: p.plusCode ?? p.plus_code ?? null,
  };
}

function createPlacesService({ prisma, googleApiKey }) {
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
   * Strict filter variant (vegetarian / pet-friendly / parking).
   * Constructs a single AND array so multiple requirements combine correctly.
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
      where.AND.push({
        OR: [{ allowsDogs: true }, ...petTextOR],
      });
    }

    if (req?.parking) {
      where.AND.push({
        OR: [{ NOT: { parkingOptions: null } }, ...parkTextOR],
      });
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

  async function upsertPlacesBatch(placesArr) {
  // 1) Normalise and filter unusable records
  const normalized = [];
  for (const raw of Array.from(placesArr || [])) {
    const alreadyNormalized =
      raw && typeof raw === "object" &&
      raw.googlePlaceId && raw.latitude != null && raw.longitude != null;
    const p = alreadyNormalized ? raw : parseGooglePlace(raw);
    if (!p?.googlePlaceId || !p?.latitude || !p?.longitude) continue;
    normalized.push(p);
  }
  if (!normalized.length) return { created: 0, createdIds: [], updated: 0 };

  // 2) Find which IDs already exist
  const ids = normalized.map((p) => String(p.googlePlaceId));
  const existingRows = await prisma.restaurant.findMany({
    where: { googlePlaceId: { in: ids } },
    select: { googlePlaceId: true },
  });
  const existing = new Set(existingRows.map((r) => String(r.googlePlaceId)));

  // 3) Build create & update payloads
  const createData = [];
  const updates = [];
  const createdIds = [];

  for (const p of normalized) {
    const id = String(p.googlePlaceId);

    const createShape = {
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

    const updateShape = {
      name: p.name || undefined,
      latitude: p.latitude != null ? Number(p.latitude) : undefined,
      longitude: p.longitude != null ? Number(p.longitude) : undefined,
      formattedAddress: p.formattedAddress ?? undefined,
      internationalPhoneNumber: p.internationalPhoneNumber ?? undefined,
      websiteUri: p.websiteUri ?? undefined,
      primaryTypeDisplayName: p.primaryTypeDisplayName ?? undefined,
      primaryType: p.primaryType ?? undefined,
      types: Array.isArray(p.types) ? p.types : undefined,
      rating: p.rating != null ? Number(p.rating) : undefined,
      userRatingCount: p.userRatingCount ?? undefined,
      priceLevel: p.priceLevel != null ? Number(p.priceLevel) : undefined,
      servesVegetarianFood:
        p.servesVegetarianFood == null ? undefined : p.servesVegetarianFood === true,
      editorialSummary: p.editorialSummary ?? undefined,
      plusCode: p.plusCode ?? undefined,
      takeout: p.takeout == null ? undefined : p.takeout === true,
      dineIn: p.dineIn == null ? undefined : p.dineIn === true,
      curbsidePickup: p.curbsidePickup == null ? undefined : p.curbsidePickup === true,
      delivery: p.delivery == null ? undefined : p.delivery === true,
      outdoorSeating: p.outdoorSeating == null ? undefined : p.outdoorSeating === true,
      allowsDogs: p.allowsDogs == null ? undefined : !!p.allowsDogs,
      parkingOptions: p.parkingOptions ?? undefined,
    };

    if (existing.has(id)) {
      updates.push({ id, data: updateShape });
    } else {
      createData.push(createShape);
      createdIds.push(id);
    }
  }

  // 4) Create new rows (count is exact) + update existing
  let created = 0;

  if (createData.length) {
    const r = await prisma.restaurant.createMany({
      data: createData,
      skipDuplicates: true, // safety against races
    });
    created += r.count || 0;
  }

  if (updates.length) {
    const batchSize = 50;
    for (let i = 0; i < updates.length; i += batchSize) {
      const slice = updates.slice(i, i + batchSize);
      await Promise.all(
        slice.map((u) =>
          prisma.restaurant.update({
            where: { googlePlaceId: u.id },
            data: u.data,
          })
        )
      );
    }
  }

  return { created, createdIds, updated: updates.length };
}


  // Conservative field mask with widely supported fields; avoids INVALID_ARGUMENTs
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
  ].join(",");

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

      // Token propagation needs a brief delay
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

      // Token propagation needs a brief delay
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
  };
}

module.exports = { createPlacesService };
