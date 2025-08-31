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

** Small geo helper: offset a point by distance km and bearing degrees */
function offsetPoint(lat, lng, km, bearingDeg) {
  const R = 6371; // km
  const brng = (bearingDeg * Math.PI) / 180;
  const lat1 = (lat * Math.PI) / 180;
  const lon1 = (lng * Math.PI) / 180;
  const dByR = km / R;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(dByR) +
      Math.cos(lat1) * Math.sin(dByR) * Math.cos(brng)
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(brng) * Math.sin(dByR) * Math.cos(lat1),
      Math.cos(dByR) - Math.sin(lat1) * Math.sin(lat2)
    );

  return { lat: (lat2 * 180) / Math.PI, lng: (lon2 * 180) / Math.PI };
}

/**
 * Text-search discovery using ONLY preferred cuisines.
 * For each cuisine:
 *  - Search at origin; upsert.
 *  - If created == 0 (all repeats), try 2km @ 45°, then 2km opposite of origin (225°),
 *    then 5km @ 0°. If 3 consecutive “no new” attempts, stop that cuisine.
 * Continues until we create up to targetNew restaurants (default 20) overall.
 *
 * Logs cuisines & per-cuisine matches + new.
 */
async function discoverCuisinesIncremental(
  places,
  originLat,
  originLng,
  cuisines,
  {
    radiusMeters = 3500,   // Text Search radius bias
    maxPages = 2,          // how deep to paginate Text Search
    targetNew = 20,        // total new to ingest
    log = console.log,
  } = {}
) {
  const cleanCuisines = (Array.isArray(cuisines) ? cuisines : [])
    .map((c) => String(c || "").trim())
    .filter(Boolean);

  log("[discover:cuisines] preferred =", cleanCuisines);

  if (cleanCuisines.length === 0) {
    log("[discover:cuisines] no preferred cuisines; skipping");
    return { created: 0, attempts: 0, perCuisine: [] };
  }

  let totalCreated = 0;
  let attempts = 0;
  const perCuisine = [];

  // Fixed attempt plan (relative to origin):
  // 1) origin (0km)
  // 2) 2km @ 45°
  // 3) 2km @ 225° (opposite of attempt #2 / opposite region from origin)
  // 4) 5km @ 0° (north)
  const attemptPlan = [
    { km: 0, bearing: 0 },
    { km: 2, bearing: 45 },
    { km: 2, bearing: 225 },
    { km: 5, bearing: 0 },
  ];

  for (const cuisine of cleanCuisines) {
    if (totalCreated >= targetNew) break;

    let createdForCuisine = 0;
    let noNewStreak = 0;

    for (let step = 0; step < attemptPlan.length; step++) {
      if (totalCreated >= targetNew) break;

      const { km, bearing } = attemptPlan[step];
      const loc =
        km === 0
          ? { lat: originLat, lng: originLng }
          : offsetPoint(originLat, originLng, km, bearing);

      const q = `${cuisine} restaurant`;

      attempts++;
      // Text Search only:
      const results = await places.googlePlacesSearchText(q, {
        lat: loc.lat,
        lng: loc.lng,
        radiusMeters,
        maxPages,
      });

      const found = Array.isArray(results) ? results.length : 0;
      let created = 0;

      if (found > 0) {
        // Upsert and measure how many are truly NEW rows
        const res = await places.upsertPlacesBatch(results);
        // Support both { created } or number return styles
        created =
          typeof res === "number"
            ? res
            : Math.max(0, Number(res?.created ?? 0));

        if (created > 0) {
          totalCreated += created;
          createdForCuisine += created;
          noNewStreak = 0;
        } else {
          noNewStreak += 1;
        }
      } else {
        noNewStreak += 1;
      }

      // log per-attempt
      log(
        `[discover:cuisines] cuisine="${cuisine}" attempt#${step + 1} @${km}km/${bearing}° => found=${found}, new=${created}, totalNew=${totalCreated}`
      );

      // After 3 consecutive no-new attempts for this cuisine, stop trying it
      if (noNewStreak >= 3) {
        log(
          `[discover:cuisines] cuisine="${cuisine}" no-new streak hit 3, stopping this cuisine`
        );
        break;
      }

      if (totalCreated >= targetNew) break;
    }

    perCuisine.push({ cuisine, created: createdForCuisine });
  }

  log(
    `[discover:cuisines] finished => totalNew=${totalCreated}, attempts=${attempts}, perCuisine=${JSON.stringify(
      perCuisine
    )}`
  );

  return { created: totalCreated, attempts, perCuisine };
}

module.exports = {
  generateRingCenters,
  buildBiasQueries,
  discoverAndIngestAround,
  discoverCuisinesIncremental,
};
