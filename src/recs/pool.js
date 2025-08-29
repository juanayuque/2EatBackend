// src/recs/pool.js
const {
  filterAndPrioritizeByPreferences,
  requirementsFromUser,
  radiusFromUser,
  cuisineKeywordsFromUser,
  findCuisineMatchDetail,
} = require("./filters");
const { discoverAndIngestAround, buildBiasQueries } = require("./discovery");
const { haversineKm, asFloat } = require("../utils/geo");

// Only pass TRUE requirements to the DB layer.
// If a requirement is false, we omit it so the DB doesn't filter on it.
function activeDbReq(user) {
  const r = requirementsFromUser(user);
  const dbReq = {};
  if (r.vegetarian) dbReq.vegetarian = true;
  if (r.petFriendly) dbReq.petFriendly = true;
  if (r.parking) dbReq.parking = true;
  return Object.keys(dbReq).length ? dbReq : undefined;
}

// Ensures a preference-filtered pool of at least `desiredMin` items.
// Expands radius progressively and triggers discovery when needed.
async function ensurePreferredPool({ places, lat, lng, user, desiredMin = 60 }) {
  const baseRadius = radiusFromUser(user);
  // Keep first pass at the user's chosen radius, then widen out.
  const expansion = Array.from(new Set([baseRadius, Math.max(baseRadius, 5), 10, 15, 20, 30, 50]));

  const reqRaw = requirementsFromUser(user);
  const reqDB = activeDbReq(user);
  const rawCuisines = Array.isArray(user?.preferredCuisines) ? user.preferredCuisines : [];
  const expandedCuisineKeywords = Array.from(cuisineKeywordsFromUser(user));
  const biasQueries = buildBiasQueries(user);

  console.log(
    `[pool] user=${user?.id ?? "unknown"} lat=${lat} lng=${lng} baseRadiusKm=${baseRadius} desiredMin=${desiredMin}`
  );
  console.log(`[pool] requirements(raw)=`, reqRaw);
  console.log(`[pool] requirements(DB filter applied)=`, reqDB ?? "(none)");
  console.log(`[pool] preferredCuisines(raw)=`, rawCuisines);
  console.log(`[pool] preferredCuisines(expanded keywords)=`, expandedCuisineKeywords);
  console.log(`[pool] discovery biasQueries=`, biasQueries);
  console.log(`[pool] radius expansion plan (km)=`, expansion);

  const acc = new Map();
  const kwSet = new Set(expandedCuisineKeywords);

  for (const radiusKm of expansion) {
    console.log(`\n[pool] ---- pass radiusKm=${radiusKm}km ----`);

    // Pull a generous slice from DB (prefiltered only by TRUE requirements)
    const dbPool = await places.ensureNearbyRestaurantsStrict(
      lat,
      lng,
      Math.max(desiredMin, 200),
      radiusKm,
      reqDB
    );
    console.log(`[pool] radius=${radiusKm}km dbPool size=${dbPool.length}`);

    // Apply full preference filtering + prioritization (cuisine-first, then nearest)
    const filtered = filterAndPrioritizeByPreferences(dbPool, user, lat, lng, desiredMin, radiusKm);
    console.log(
      `[pool] radius=${radiusKm}km filtered size=${filtered.length} (acc before=${acc.size})`
    );

    // Log cuisine match details (sample up to 10) with distance
    const hitRows = [];
    for (const r of filtered) {
      const d = findCuisineMatchDetail(r, kwSet);
      if (d) {
        const km = haversineKm(
          { lat, lng },
          { lat: asFloat(r.latitude), lng: asFloat(r.longitude) }
        );
        hitRows.push({
          id: r.id,
          name: r.name,
          km: Number.isFinite(km) ? +km.toFixed(1) : null,
          keyword: d.keyword,
          where: d.where, // "primaryType" | "types" | "text"
        });
      }
    }
    console.log(
      `[pool] radius=${radiusKm}km cuisine hits ${hitRows.length}/${filtered.length} (sample 10):`,
      hitRows.slice(0, 10)
    );

    // De-dup across passes
    for (const r of filtered) if (!acc.has(r.id)) acc.set(r.id, r);
    console.log(`[pool] radius=${radiusKm}km acc after=${acc.size}`);

    if (acc.size >= desiredMin) {
      console.log(
        `[pool] ✅ target satisfied: desiredMin=${desiredMin} at radius=${radiusKm}km`
      );
      break;
    }

    // Try discovery to enrich DB for next iterations (biased by prefs)
    const discoveryRes = await discoverAndIngestAround(places, lat, lng, {
      cellRadiusMeters: Math.round(radiusKm * 1000) || 3000,
      rankPrefs: ["POPULARITY", "DISTANCE"],
      includeTypes: [["restaurant"]],
      biasQueries,
    });
    console.log(`[pool] discovery at radius=${radiusKm}km →`, discoveryRes);
  }

  // Final wide pass if still short
  if (acc.size < desiredMin) {
    const lastRadius = expansion[expansion.length - 1];
    console.log(
      `\n[pool] final wide pass: radius=${lastRadius}km (acc=${acc.size} < desiredMin=${desiredMin})`
    );

    const finalPool = await places.ensureNearbyRestaurantsStrict(
      lat,
      lng,
      Math.max(desiredMin, 240),
      lastRadius,
      reqDB
    );
    console.log(`[pool] final pass dbPool size=${finalPool.length}`);

    const filtered = filterAndPrioritizeByPreferences(
      finalPool,
      user,
      lat,
      lng,
      desiredMin,
      lastRadius
    );
    console.log(
      `[pool] final pass filtered size=${filtered.length} (acc before=${acc.size})`
    );

    // Log cuisine match details on final pass too (sample up to 10)
    const hitRows = [];
    for (const r of filtered) {
      const d = findCuisineMatchDetail(r, kwSet);
      if (d) {
        const km = haversineKm(
          { lat, lng },
          { lat: asFloat(r.latitude), lng: asFloat(r.longitude) }
        );
        hitRows.push({
          id: r.id,
          name: r.name,
          km: Number.isFinite(km) ? +km.toFixed(1) : null,
          keyword: d.keyword,
          where: d.where,
        });
      }
    }
    console.log(
      `[pool] final pass cuisine hits ${hitRows.length}/${filtered.length} (sample 10):`,
      hitRows.slice(0, 10)
    );

    for (const r of filtered) if (!acc.has(r.id)) acc.set(r.id, r);
    console.log(`[pool] final pass acc after=${acc.size}`);
  }

  const out = Array.from(acc.values()).slice(0, desiredMin);
  console.log(`[pool] returning size=${out.length} (acc=${acc.size})\n`);
  return out;
}

module.exports = { ensurePreferredPool };
