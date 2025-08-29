// src/recs/discovery.js
const { cuisineKeywordsFromUser, requirementsFromUser } = require("./filters");

// Generates ring centers around a point to spread discovery calls
function generateRingCenters(lat, lng, minKm = 2, maxKm = 12, stepKm = 2) {
  const centers = [];
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const earthKm = 6371;
  const lat1 = toRad(lat);
  const lon1 = toRad(lng);

  for (let r = minKm; r <= maxKm; r += stepKm) {
    const circumference = 2 * Math.PI * r;
    const points = Math.max(6, Math.round(circumference / stepKm));
    const angDist = r / earthKm;

    for (let i = 0; i < points; i++) {
      const bearing = (2 * Math.PI * i) / points;
      const lat2 = Math.asin(
        Math.sin(lat1) * Math.cos(angDist) +
          Math.cos(lat1) * Math.sin(angDist) * Math.cos(bearing)
      );
      const lon2 =
        lon1 +
        Math.atan2(
          Math.sin(bearing) * Math.sin(angDist) * Math.cos(lat1),
          Math.cos(angDist) - Math.sin(lat1) * Math.sin(lat2)
        );
      centers.push({ lat: toDeg(lat2), lng: toDeg(lon2) });
    }
  }
  return centers;
}

// Builds bias search queries from user prefs/requirements
function buildBiasQueries(user) {
  const req = requirementsFromUser(user);
  const requirementKeywords = [];
  const queries = new Set();

  if (req.vegetarian) requirementKeywords.push("vegetarian");
  if (req.petFriendly) requirementKeywords.push("pet friendly");
  if (req.parking) requirementKeywords.push("with parking");

  const cuisines = Array.from(cuisineKeywordsFromUser(user));

  if (requirementKeywords.length > 0 || cuisines.length > 0) {
    const allKeywords = [...cuisines, ...requirementKeywords, "restaurant"];
    queries.add(allKeywords.join(" "));
  }

  if (cuisines.length > 1) queries.add([...cuisines, "restaurant"].join(" "));
  for (const cuisine of cuisines) queries.add(`${cuisine} restaurant`);

  if (requirementKeywords.length > 1) queries.add([...requirementKeywords, "restaurant"].join(" "));
  if (req.vegetarian) queries.add("vegetarian restaurant");
  if (req.petFriendly) queries.add("pet friendly restaurant");
  if (req.parking) queries.add("restaurant with parking");

  if (queries.size === 0) queries.add("restaurant");

  const arr = Array.from(queries);
  if (requirementKeywords.length > 0 || cuisines.length > 0) {
    const mostSpecific = [...cuisines, ...requirementKeywords, "restaurant"].join(" ");
    const idx = arr.indexOf(mostSpecific);
    if (idx > 0) {
      const [s] = arr.splice(idx, 1);
      arr.unshift(s);
    }
  }
  return arr;
}

// Discovers additional candidates via Google Places; upserts them
async function discoverAndIngestAround(places, lat, lng, {
  cellRadiusMeters = 3000,
  rankPrefs = ["POPULARITY", "DISTANCE"],
  includeTypes = [["restaurant"]],
  maxCenters = 18,
  delayMs = 120,
  biasQueries = [],
} = {}) {
  const centers = generateRingCenters(lat, lng, 2, 12, 2).slice(0, maxCenters);
  const byId = new Map();

  for (const c of centers) {
    if (biasQueries.length) {
      for (const q of biasQueries) {
        const chunk = await places.googlePlacesSearchText(q, {
          lat: c.lat, lng: c.lng, radiusMeters: cellRadiusMeters, maxPages: 2,
        });
        for (const p of chunk || []) if (p?.id && !byId.has(p.id)) byId.set(p.id, p);
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      }
    } else {
      for (const rankPreference of rankPrefs) {
        for (const types of includeTypes) {
          const chunk = await places.googlePlacesSearchNearby(c.lat, c.lng, {
            radiusMeters: cellRadiusMeters, maxPages: 3, rankPreference, includedTypes: types,
          });
          for (const p of chunk || []) if (p?.id && !byId.has(p.id)) byId.set(p.id, p);
          if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        }
      }
    }
  }

  const discovered = Array.from(byId.values());
  if (!discovered.length) return { discovered: 0 };

  const created = await places.upsertPlacesBatch(discovered);
  return { discovered: discovered.length, created };
}

module.exports = {
  generateRingCenters,
  buildBiasQueries,
  discoverAndIngestAround,
};
