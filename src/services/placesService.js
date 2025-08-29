// src/services/placesService.js
const { haversineKm, asFloat } = require("../utils/geo");

const fetchFn =
  (typeof fetch === "function" && fetch) ||
  ((...args) => import("node-fetch").then((m) => m.default(...args)));

function bboxFromCenter(lat, lng, radiusKm) {
  const dLat = radiusKm / 111;
  const dLng = radiusKm / (111 * Math.cos((lat * Math.PI) / 180));
  return { minLat: lat - dLat, maxLat: lat + dLat, minLng: lng - dLng, maxLng: lng + dLng };
}

function parseGooglePlace(p) {
  const id = p.id || p.googlePlaceId || p.placeId || p.place_id || (p.name && p.name.split("/").pop());
  const lat =
    p.location?.latitude ??
    p.location?.latLng?.latitude ??
    p.geometry?.location?.lat ??
    p.lat;
  const lng =
    p.location?.longitude ??
    p.location?.latLng?.longitude ??
    p.geometry?.location?.lng ??
    p.lng;

  const displayName = p.displayName?.text || p.name || p.title || "";
  const editorialSummary = p.editorialSummary?.text || p.editorial_summary || null;

  const dogsHeuristic =
    /\bdog[- ]?friendly\b|\bpet[- ]?friendly\b|\bdogs welcome\b/i.test(
      (editorialSummary || "") + " " + displayName
    );

  return {
    id,
    googlePlaceId: id,
    name: displayName || "",
    latitude: lat,
    longitude: lng,
    formattedAddress: p.formattedAddress || p.vicinity || p.formatted_address || null,
    primaryTypeDisplayName:
      p.primaryTypeDisplayName?.text || p.primaryTypeDisplayName || null,
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
    allowsDogs: p.allowsDogs ?? (dogsHeuristic ? true : null),
    parkingOptions: p.parkingOptions ?? null,
    websiteUri: p.websiteUri ?? p.website_uri ?? null,
    internationalPhoneNumber:
      p.internationalPhoneNumber ?? p.international_phone_number ?? null,
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
      ...(req?.vegetarian
        ? {
            AND: [
              {
                OR: [
                  { servesVegetarianFood: true },
                  { types: { has: "vegetarian_restaurant" } },
                  ...vegTextOR,
                ],
              },
            ],
          }
        : {}),
      ...(req?.petFriendly
        ? {
            AND: [
              {
                OR: [{ allowsDogs: true }, ...petTextOR],
              },
            ],
          }
        : {}),
      ...(req?.parking
        ? {
            AND: [
              {
                OR: [{ NOT: { parkingOptions: null } }, ...parkTextOR],
              },
            ],
          }
        : {}),
    };

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
    let created = 0;
    const chunks = [];
    const copy = Array.from(placesArr || []);
    while (copy.length) chunks.push(copy.splice(0, 50));

    for (const chunk of chunks) {
      await Promise.all(
        chunk.map(async (raw) => {
          const p = parseGooglePlace(raw);
          if (!p.googlePlaceId || !p.latitude || !p.longitude) return;
          const result = await prisma.restaurant.upsert({
            where: { googlePlaceId: String(p.googlePlaceId) },
            create: {
              googlePlaceId: String(p.googlePlaceId),
              name: p.name || "Unknown",
              latitude: Number(p.latitude),
              longitude: Number(p.longitude),
              formattedAddress: p.formattedAddress,
              internationalPhoneNumber: p.internationalPhoneNumber,
              websiteUri: p.websiteUri,
              primaryTypeDisplayName: p.primaryTypeDisplayName,
              primaryType: p.primaryType,
              types: p.types || [],
              rating: p.rating != null ? Number(p.rating) : null,
              userRatingCount: p.userRatingCount || 0,
              priceLevel: p.priceLevel != null ? Number(p.priceLevel) : null,
              servesVegetarianFood: p.servesVegetarianFood === true,
              editorialSummary: p.editorialSummary || null,
              plusCode: p.plusCode,
              takeout: p.takeout === true,
              dineIn: p.dineIn === true,
              curbsidePickup: p.curbsidePickup === true,
              delivery: p.delivery === true,
              outdoorSeating: p.outdoorSeating === true,
              allowsDogs: p.allowsDogs === true ? true : false,
              parkingOptions: p.parkingOptions || null,
            },
            update: {
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
              curbsidePickup:
                p.curbsidePickup == null ? undefined : p.curbsidePickup === true,
              delivery: p.delivery == null ? undefined : p.delivery === true,
              outdoorSeating:
                p.outdoorSeating == null ? undefined : p.outdoorSeating === true,
              allowsDogs:
                p.allowsDogs === true
                  ? true
                  : undefined,
              parkingOptions: p.parkingOptions ?? undefined,
            },
          });
          if (result.createdAt.getTime() === result.updatedAt.getTime()) created += 1;
        })
      );
    }
    return created;
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
        includedTypes: includedTypes,
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
          "X-Goog-FieldMask":
            "places.id,places.displayName,places.location,places.formattedAddress,places.primaryType,places.primaryTypeDisplayName,places.types,places.rating,places.userRatingCount,places.priceLevel,places.editorialSummary,places.parkingOptions",
        },
        body: JSON.stringify(body),
      });
      if (!r.ok) break;
      const j = await r.json();
      const places = Array.isArray(j.places) ? j.places : [];
      out.push(...places.map(parseGooglePlace));
      if (!j.nextPageToken) break;
      pageToken = j.nextPageToken;
      await new Promise((res) => setTimeout(res, 200));
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
        textQuery: query,
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
          "X-Goog-FieldMask":
            "places.id,places.displayName,places.location,places.formattedAddress,places.primaryType,places.primaryTypeDisplayName,places.types,places.rating,places.userRatingCount,places.priceLevel,places.editorialSummary,places.parkingOptions",
        },
        body: JSON.stringify(body),
      });
      if (!r.ok) break;
      const j = await r.json();
      const places = Array.isArray(j.places) ? j.places : [];
      out.push(...places.map(parseGooglePlace));
      if (!j.nextPageToken) break;
      pageToken = j.nextPageToken;
      await new Promise((res) => setTimeout(res, 200));
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
