// src/services/placesService.js
// Service focused on Google Places ingest and local DB helpers.
// I keep HTTP calls, normalization, and DB upserts here so routes stay thin.

const fetchFn =
  (typeof fetch === "function" && fetch) ||
  ((...args) => import("node-fetch").then((m) => m.default(...args)));

function createPlacesService({ prisma, googleApiKey }) {
  if (!googleApiKey) {
    console.warn("[placesService] GOOGLE_API_KEY is missing; discovery calls will fail.");
  }

  // v1 Places field mask — only what I actually use anywhere downstream.
  const FIELD_MASK = [
    "places.id",
    "places.name",
    "places.displayName",
    "places.primaryType",
    "places.primaryTypeDisplayName",
    "places.types",
    "places.location",
    "places.formattedAddress",
    "places.priceLevel",
    "places.editorialSummary",
  ].join(",");

  // v1 payloads sometimes put ID inside resource name (places/XYZ) — keep a safe fallback.
  function idFromResourceName(name) {
    if (!name || typeof name !== "string") return null;
    const parts = name.split("/");
    return parts.length >= 2 ? parts[1] : null;
  }

  // Haversine just for local sorting. I keep it here so service is self-contained.
  function haversineKm(a, b) {
    const R = 6371;
    const dLat = ((b.lat - a.lat) * Math.PI) / 180;
    const dLng = ((b.lng - a.lng) * Math.PI) / 180;
    const sa =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((a.lat * Math.PI) / 180) *
        Math.cos((b.lat * Math.PI) / 180) *
        Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(sa), Math.sqrt(1 - sa));
    return R * c;
  }

  // Make sure I always return the fields routes expect.
  function normalizePlaceV1(p) {
    const loc = p.location || {};
    const id = p.id || idFromResourceName(p.name);

    return {
      id: id || null,
      name: p.displayName?.text || p.displayName || p.name || null,
      latitude: typeof loc.latitude === "number" ? loc.latitude : null,
      longitude: typeof loc.longitude === "number" ? loc.longitude : null,
      primaryType: p.primaryType || null,
      primaryTypeDisplayName:
        p.primaryTypeDisplayName?.text ||
        p.primaryTypeDisplayName ||
        null,
      types: Array.isArray(p.types) ? p.types : [],
      formattedAddress: p.formattedAddress || null,
      editorialSummary: p.editorialSummary?.text || null,
      priceLevel: typeof p.priceLevel === "number" ? p.priceLevel : null,
      // These booleans rarely come from Places; leave null so downstream can infer from text if needed.
      servesVegetarianFood: null,
      allowsDogs: null,
    };
  }

  // Nearby search. When keyword is present, I purposely route to Text Search for better signal.
  async function googlePlacesSearchNearby(
    lat,
    lng,
    {
      radiusMeters = 3000,
      maxPages = 1,
      rankPreference = "POPULARITY",
      includedTypes = ["restaurant"],
      keyword = null, // if present, I use text search instead
    } = {}
  ) {
    if (!googleApiKey) return [];

    if (keyword && String(keyword).trim().length) {
      const typeStr = Array.isArray(includedTypes)
        ? includedTypes[0] || "restaurant"
        : includedTypes || "restaurant";
      return await googlePlacesSearchText(lat, lng, {
        textQuery: `${keyword} ${typeStr}`,
        radiusMeters,
        maxPages,
      });
    }

    const url = "https://places.googleapis.com/v1/places:searchNearby";
    const body = {
      includedTypes: Array.isArray(includedTypes)
        ? includedTypes
        : [includedTypes || "restaurant"],
      maxResultCount: 20, // v1 Nearby caps at 20; no reliable page token in this simplified path
      rankPreference,
      locationRestriction: {
        circle: {
          center: { latitude: lat, longitude: lng },
          radius: radiusMeters,
        },
      },
    };

    const headers = {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": googleApiKey,
      "X-Goog-FieldMask": FIELD_MASK,
    };

    const all = [];
    for (let page = 0; page < Math.max(1, maxPages); page++) {
      const r = await fetchFn(url, { method: "POST", headers, body: JSON.stringify(body) });
      if (!r.ok) break;
      const j = await r.json();
      const chunk = (j.places || []).map(normalizePlaceV1);
      all.push(...chunk);
      // No stable pagination here in my minimal usage — bail after first page.
      break;
    }
    return all.filter((x) => x.id && x.latitude != null && x.longitude != null);
  }

  // Text search with location bias. This is what I use to bias vegetarian/dog-friendly/parking discovery.
  async function googlePlacesSearchText(
    lat,
    lng,
    {
      textQuery,
      radiusMeters = 3000,
      maxPages = 1,
    } = {}
  ) {
    if (!googleApiKey || !textQuery) return [];

    const url = "https://places.googleapis.com/v1/places:searchText";
    const headers = {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": googleApiKey,
      "X-Goog-FieldMask": FIELD_MASK,
    };

    const body = {
      textQuery,
      maxResultCount: 20,
      locationBias: {
        circle: { center: { latitude: lat, longitude: lng }, radius: radiusMeters },
      },
    };

    const all = [];
    for (let page = 0; page < Math.max(1, maxPages); page++) {
      const r = await fetchFn(url, { method: "POST", headers, body: JSON.stringify(body) });
      if (!r.ok) break;
      const j = await r.json();
      const chunk = (j.places || []).map(normalizePlaceV1);
      all.push(...chunk);
      // Similar to nearby, I’m not walking nextPage tokens in this slim flow.
      break;
    }
    return all.filter((x) => x.id && x.latitude != null && x.longitude != null);
  }

  // Batch upsert to the restaurants table. I avoid throwing on duplicates.
  async function upsertPlacesBatch(placesArr) {
    if (!Array.isArray(placesArr) || placesArr.length === 0) return 0;
    let created = 0;

    for (const p of placesArr) {
      if (!p?.id) continue;
      try {
        await prisma.restaurant.upsert({
          where: { id: p.id },
          update: {
            name: p.name ?? undefined,
            latitude: p.latitude ?? undefined,
            longitude: p.longitude ?? undefined,
            primaryType: p.primaryType ?? undefined,
            primaryTypeDisplayName: p.primaryTypeDisplayName ?? undefined,
            types: Array.isArray(p.types) ? p.types : undefined,
            formattedAddress: p.formattedAddress ?? undefined,
            editorialSummary: p.editorialSummary ?? undefined,
            priceLevel: typeof p.priceLevel === "number" ? p.priceLevel : undefined,
          },
          create: {
            id: p.id,
            name: p.name || "",
            latitude: p.latitude,
            longitude: p.longitude,
            primaryType: p.primaryType || null,
            primaryTypeDisplayName: p.primaryTypeDisplayName || null,
            types: Array.isArray(p.types) ? p.types : [],
            formattedAddress: p.formattedAddress || null,
            editorialSummary: p.editorialSummary || null,
            priceLevel: typeof p.priceLevel === "number" ? p.priceLevel : null,
          },
        });
        created++;
      } catch {
        // ignore constraint violations — I only need the record present/up-to-date
      }
    }

    return created;
  }

  // Pull a local pool near (lat,lng). I bound by a box in SQL and sort by Haversine in memory.
  async function ensureNearbyRestaurants(lat, lng, minCount = 100, radiusKm = 15) {
    const R = Math.max(0.5, Number(radiusKm) || 15);
    const latDeg = R / 110.574; // ~km per degree latitude
    const lngDeg = R / (111.320 * Math.cos((lat * Math.PI) / 180) || 1); // protect against NaN at poles

    const minLat = lat - latDeg;
    const maxLat = lat + latDeg;
    const minLng = lng - lngDeg;
    const maxLng = lng + lngDeg;

    // I grab more than needed; then I sort by true distance and trim.
    const rows = await prisma.restaurant.findMany({
      where: {
        latitude: { gte: minLat, lte: maxLat },
        longitude: { gte: minLng, lte: maxLng },
      },
      take: Math.max(minCount * 3, 300),
      select: {
        id: true,
        name: true,
        latitude: true,
        longitude: true,
        primaryType: true,
        primaryTypeDisplayName: true,
        types: true,
        formattedAddress: true,
        editorialSummary: true,
        priceLevel: true,
        servesVegetarianFood: true,
        allowsDogs: true,
        parkingOptions: true,
      },
    });

    const here = { lat, lng };
    const withDist = rows
      .filter((r) => typeof r.latitude === "number" && typeof r.longitude === "number")
      .map((r) => ({
        ...r,
        _distKm: haversineKm(here, { lat: r.latitude, lng: r.longitude }),
      }));
    withDist.sort((a, b) => a._distKm - b._distKm);

    return withDist.slice(0, Math.max(1, minCount));
  }

  return {
    googlePlacesSearchNearby,
    googlePlacesSearchText,
    upsertPlacesBatch,
    ensureNearbyRestaurants,
  };
}

module.exports = { createPlacesService };
