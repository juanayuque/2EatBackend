// src/services/placesService.js
// Centralised Google Places helpers + DB upserts

const { haversineKm, asFloat } = require("../utils/geo");

// Use global fetch when available (Node 18+). Fall back to node-fetch.
const fetchFn =
  (typeof fetch === "function" && fetch) ||
  (async (...args) => (await import("node-fetch")).default(...args));

function bboxFromCenter(lat, lng, radiusKm) {
  const dLat = radiusKm / 111;
  const dLng = radiusKm / (111 * Math.cos((lat * Math.PI) / 180));
  return { minLat: lat - dLat, maxLat: lat + dLat, minLng: lng - dLng, maxLng: lng + dLng };
}

// Normalize Google Places objects into the shape used by the DB layer
function parseGooglePlace(p) {
  const id =
    p?.id ||
    p?.googlePlaceId ||
    p?.placeId ||
    p?.place_id ||
    (p?.name && String(p.name).split("/").pop());

  // Places v1 coordinates
  const lat =
    p?.latitude ??
    p?.location?.latitude ??
    p?.location?.latLng?.latitude ??
    p?.geometry?.location?.lat ??
    p?.lat;

  const lng =
    p?.longitude ??
    p?.location?.longitude ??
    p?.location?.latLng?.longitude ??
    p?.geometry?.location?.lng ??
    p?.lng;

  const displayName = p?.displayName?.text || p?.title || "";
  const editorialSummary = p?.editorialSummary?.text || p?.editorial_summary || null;

  // photos: keep only what we need
  const photos = Array.isArray(p?.photos)
    ? p.photos
        .map((ph) => ({
          name: ph?.name || null,
          widthPx: Number(ph?.widthPx ?? ph?.width_px ?? ph?.width) || null,
          heightPx: Number(ph?.heightPx ?? ph?.height_px ?? ph?.height) || null,
        }))
        .filter((ph) => ph.name)
    : [];

  // Simple heuristic for pet-friendly signals
  const dogsHeuristic = /\bdog[- ]?friendly\b|\bpet[- ]?friendly\b|\bdogs welcome\b/i.test(
    `${editorialSummary || ""} ${displayName}`
  );

  return {
    // identity
    id,
    googlePlaceId: id,

    // basic fields
    name: displayName || "",
    latitude: lat,
    longitude: lng,
    formattedAddress: p?.formattedAddress || p?.vicinity || p?.formatted_address || null,
    primaryTypeDisplayName: p?.primaryTypeDisplayName?.text || p?.primaryTypeDisplayName || null,
    primaryType: p?.primaryType || (Array.isArray(p?.types) ? p.types[0] : null),
    types: Array.isArray(p?.types) ? p.types : [],

    // ratings / price
    rating: p?.rating ?? null,
    userRatingCount: p?.userRatingCount ?? p?.user_ratings_total ?? null,
    priceLevel: p?.priceLevel ?? p?.price_level ?? null,

    // amenities / summary
    servesVegetarianFood: p?.servesVegetarianFood ?? null,
    editorialSummary,
    takeout: p?.takeout ?? null,
    dineIn: p?.dineIn ?? p?.dine_in ?? null,
    curbsidePickup: p?.curbsidePickup ?? p?.curbside_pickup ?? null,
    delivery: p?.delivery ?? null,
    outdoorSeating: p?.outdoorSeating ?? p?.outdoor_seating ?? null,
    allowsDogs: p?.allowsDogs ?? (dogsHeuristic ? true : null),
    parkingOptions: p?.parkingOptions ?? null,

    // misc
    websiteUri: p?.websiteUri ?? p?.website_uri ?? null,
    internationalPhoneNumber: p?.internationalPhoneNumber ?? p?.international_phone_number ?? null,
    plusCode: p?.plusCode ?? p?.plus_code ?? null,

    // photos
    photos,
  };
}

// Places Details v1 — used to enrich search hits that lack photos/address/etc
async function fetchPlaceDetailsV1(placeId) {
  const key = process.env.GOOGLE_API_KEY || process.env.PLACES_API_KEY;
  if (!key) throw new Error("Missing GOOGLE_API_KEY/PLACES_API_KEY");

  const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?languageCode=en`;
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
      "rating",
      "userRatingCount",
      "priceLevel",
      "editorialSummary",
      "websiteUri",
      "internationalPhoneNumber",
      "photos.name",
      "photos.widthPx",
      "photos.heightPx",
    ].join(","),
  };

  const r = await fetchFn(url, { headers });
  if (!r.ok) throw new Error(`details ${r.status}`);
  const j = await r.json();
  return parseGooglePlace(j);
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

  // Strict filter helper retained (unchanged)
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

  /**
   * Upsert a batch of Places into Restaurant table.
   * Then attach photo rows WITHOUT using connectOrCreate (no unique index required).
   */
  async function upsertPlacesBatch(placesArr) {
    // 1) Normalize and filter unusable records
    const normalized = [];
    for (const raw of Array.from(placesArr || [])) {
      const alreadyNormalized =
        raw && typeof raw === "object" && raw.googlePlaceId && raw.latitude != null && raw.longitude != null;
      const p = alreadyNormalized ? raw : parseGooglePlace(raw);
      if (!p?.googlePlaceId || !p?.latitude || !p?.longitude) continue;
      normalized.push(p);
    }
    if (!normalized.length) return { created: 0, createdIds: [], updated: 0 };

    // 2) Find which IDs already exist (and fetch IDs for later)
    const gpids = normalized.map((p) => String(p.googlePlaceId));
    const existingRows = await prisma.restaurant.findMany({
      where: { googlePlaceId: { in: gpids } },
      select: { id: true, googlePlaceId: true },
    });
    const existingMap = new Map(existingRows.map((r) => [String(r.googlePlaceId), r.id]));
    const existingSet = new Set(existingRows.map((r) => String(r.googlePlaceId)));

    // 3) Build create & update payloads
    const createData = [];
    const updates = [];

    for (const p of normalized) {
      const id = String(p.googlePlaceId);

      const baseFields = {
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
        userRatingCount: p.userRatingCount ?? 0,
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

      if (existingSet.has(id)) {
        const updateShape = {};
        for (const [k, v] of Object.entries(baseFields)) {
          if (v !== null && v !== undefined) updateShape[k] = v;
        }
        updates.push({ id, data: updateShape });
      } else {
        createData.push({
          googlePlaceId: id,
          ...baseFields,
        });
      }
    }

    // 4) Create new restaurants (exact count) + update existing
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

    // 5) Refresh map: we need DB IDs for all (including just-created)
    const allRows = await prisma.restaurant.findMany({
      where: { googlePlaceId: { in: gpids } },
      select: { id: true, googlePlaceId: true },
    });
    const idByGpid = new Map(allRows.map((r) => [String(r.googlePlaceId), r.id]));

    // 6) Attach PHOTOS in a separate pass (NO connectOrCreate)
    // Gather desired photos per restaurantId
    const desiredByRest = new Map(); // restaurantId -> Map(name -> {name,widthPx,heightPx})
    for (const p of normalized) {
      const rid = idByGpid.get(String(p.googlePlaceId));
      if (!rid) continue;
      if (!Array.isArray(p.photos) || p.photos.length === 0) continue;

      let m = desiredByRest.get(rid);
      if (!m) {
        m = new Map();
        desiredByRest.set(rid, m);
      }
      for (const ph of p.photos) {
        const nm = String(ph?.name || "").trim();
        if (!nm) continue;
        // de-dupe by name per restaurant
        if (!m.has(nm)) {
          m.set(nm, {
            name: nm,
            widthPx: ph?.widthPx != null ? Number(ph.widthPx) : null,
            heightPx: ph?.heightPx != null ? Number(ph.heightPx) : null,
          });
        }
      }
    }

    // Nothing to do
    if (desiredByRest.size === 0) {
      return { created, createdIds: gpids.filter((g) => !existingSet.has(g)), updated: updates.length };
    }

    const targetRestaurantIds = Array.from(desiredByRest.keys());

    // Fetch existing photos once for all target restaurants
    const existingPhotos = await prisma.photo.findMany({
      where: { restaurantId: { in: targetRestaurantIds } },
      select: { restaurantId: true, name: true },
    });

    // Build a lookup: restaurantId -> Set(existing names)
    const haveByRest = new Map();
    for (const row of existingPhotos) {
      const rid = row.restaurantId;
      if (!haveByRest.has(rid)) haveByRest.set(rid, new Set());
      haveByRest.get(rid).add(row.name);
    }

    // Compute missing photos and bulk-insert
    const toCreate = [];
    for (const [rid, mapNames] of desiredByRest.entries()) {
      const have = haveByRest.get(rid) || new Set();
      for (const ph of mapNames.values()) {
        if (!have.has(ph.name)) {
          toCreate.push({
            restaurantId: rid,
            name: ph.name,
            widthPx: ph.widthPx,
            heightPx: ph.heightPx,
          });
        }
      }
    }

    if (toCreate.length) {
      // Single bulk insert; no unique index required since we filtered by existing rows.
      await prisma.photo.createMany({ data: toCreate });
    }

    return { created, createdIds: gpids.filter((g) => !existingSet.has(g)), updated: updates.length };
  }

  // Conservative field mask with widely supported fields
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
    "places.internationalPhoneNumber",
    "places.photos.name",
    "places.photos.widthPx",
    "places.photos.heightPx",
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
    fetchPlaceDetailsV1, // expose for enrichment in routes
  };
}

module.exports = { createPlacesService };
