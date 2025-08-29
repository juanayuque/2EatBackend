// src/recs/pool.js
const {
  filterAndPrioritizeByPreferences,
  filterCuisineOnly,                 // <-- NEW import
  requirementsFromUser,
  radiusFromUser,
  cuisineKeywordsFromUser,
  findCuisineMatchDetail,
} = require("./filters");
const { discoverAndIngestAround, buildBiasQueries } = require("./discovery");
const { haversineKm, asFloat } = require("../utils/geo");

// Only pass TRUE requirements to the DB layer.
function activeDbReq(user) {
  const r = requirementsFromUser(user);
  const dbReq = {};
  if (r.vegetarian)  dbReq.vegetarian  = true;
  if (r.petFriendly) dbReq.petFriendly = true;
  if (r.parking)     dbReq.parking     = true;
  return Object.keys(dbReq).length ? dbReq : undefined;
}

// Ensures a preference-filtered pool of at least `desiredMin` items.
// Strategy:
//   1) STRICT pass (cuisine-only) over expansion radii (+ discovery as needed)
//   2) If still short → FLEXIBLE pass (matches first, then nearest fill)
//   3) Final wide pass (flexible) if still short
async function ensurePreferredPool({ places, lat, lng, user, desiredMin = 60 }) {
  const baseRadius = radiusFromUser(user);
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

  // ─────────────────────── 1) STRICT PASS (cuisine-only) ───────────────────────
  for (const radiusKm of expansion) {
    console.log(`\n[pool] (STRICT) ---- radiusKm=${radiusKm}km ----`);
    const dbPool = await places.ensureNearbyRestaurantsStrict(
      lat, lng, Math.max(desiredMin, 200), radiusKm, reqDB
    );
    console.log(`[pool] (STRICT) radius=${radiusKm}km dbPool size=${dbPool.length}`);

    const want = Math.max(0, desiredMin - acc.size);
    const strict = filterCuisineOnly(dbPool, user, lat, lng, want, radiusKm);
    console.log(`[pool] (STRICT) radius=${radiusKm}km cuisineOnly size=${strict.length} (acc before=${acc.size})`);

    // Log match details (sample 10)
    const hits = [];
    for (const r of strict) {
      const d = findCuisineMatchDetail(r, kwSet);
      if (d) {
        const km = haversineKm({ lat, lng }, { lat: asFloat(r.latitude), lng: asFloat(r.longitude) });
        hits.push({ id: r.id, name: r.name, km: Number.isFinite(km) ? +km.toFixed(1) : null, keyword: d.keyword, where: d.where });
      }
    }
    console.log(`[pool] (STRICT) radius=${radiusKm}km cuisine hits ${hits.length}/${strict.length} (sample 10):`, hits.slice(0,10));

    for (const r of strict) if (!acc.has(r.id)) acc.set(r.id, r);
    console.log(`[pool] (STRICT) radius=${radiusKm}km acc after=${acc.size}`);

    if (acc.size >= desiredMin) {
      console.log(`[pool] ✅ satisfied via STRICT at radius=${radiusKm}km`);
      break;
    }

    // Still short → try to enrich DB before next strict radius
    const discoveryRes = await discoverAndIngestAround(places, lat, lng, {
      cellRadiusMeters: Math.round(radiusKm * 1000) || 3000,
      rankPrefs: ["POPULARITY", "DISTANCE"],
      includeTypes: [["restaurant"]],
      biasQueries,
    });
    console.log(`[pool] (STRICT) discovery at radius=${radiusKm}km →`, discoveryRes);
  }

  if (acc.size >= desiredMin) {
    const out = Array.from(acc.values()).slice(0, desiredMin);
    console.log(`[pool] returning (STRICT-only) size=${out.length} (acc=${acc.size})\n`);
    return out;
  }

  // ─────────────────────── 2) FLEXIBLE PASS (fallback) ───────────────────────
  for (const radiusKm of expansion) {
    console.log(`\n[pool] (FLEX) ---- radiusKm=${radiusKm}km ----`);
    const dbPool = await places.ensureNearbyRestaurantsStrict(
      lat, lng, Math.max(desiredMin, 200), radiusKm, reqDB
    );
    console.log(`[pool] (FLEX) radius=${radiusKm}km dbPool size=${dbPool.length}`);

    const filtered = filterAndPrioritizeByPreferences(dbPool, user, lat, lng, desiredMin, radiusKm);
    // Only take new items not already in acc
    const newOnes = [];
    for (const r of filtered) if (!acc.has(r.id)) newOnes.push(r);

    console.log(`[pool] (FLEX) radius=${radiusKm}km candidates (new)=${newOnes.length} (acc before=${acc.size})`);

    // Log: how many of these fallback items are cuisine matches
    const hits = [];
    for (const r of newOnes) {
      const d = findCuisineMatchDetail(r, kwSet);
      if (d) {
        const km = haversineKm({ lat, lng }, { lat: asFloat(r.latitude), lng: asFloat(r.longitude) });
        hits.push({ id: r.id, name: r.name, km: Number.isFinite(km) ? +km.toFixed(1) : null, keyword: d.keyword, where: d.where });
      }
    }
    console.log(`[pool] (FLEX) radius=${radiusKm}km cuisine matches among fallback ${hits.length}/${newOnes.length} (sample 10):`, hits.slice(0,10));

    for (const r of newOnes) {
      if (acc.size >= desiredMin) break;
      acc.set(r.id, r);
    }
    console.log(`[pool] (FLEX) radius=${radiusKm}km acc after=${acc.size}`);

    if (acc.size >= desiredMin) {
      console.log(`[pool] ✅ satisfied via FLEX at radius=${radiusKm}km`);
      break;
    }
  }

  // ─────────────────────── 3) Final wide pass (flexible) ───────────────────────
  if (acc.size < desiredMin) {
    const lastRadius = expansion[expansion.length - 1];
    console.log(`\n[pool] final wide pass: radius=${lastRadius}km (acc=${acc.size} < desiredMin=${desiredMin})`);

    const finalPool = await places.ensureNearbyRestaurantsStrict(
      lat, lng, Math.max(desiredMin, 240), lastRadius, reqDB
    );
    console.log(`[pool] final pass dbPool size=${finalPool.length}`);

    const filtered = filterAndPrioritizeByPreferences(finalPool, user, lat, lng, desiredMin, lastRadius);
    const newOnes = filtered.filter((r) => !acc.has(r.id));
    console.log(`[pool] final pass new candidates=${newOnes.length} (acc before=${acc.size})`);

    const hits = [];
    for (const r of newOnes) {
      const d = findCuisineMatchDetail(r, kwSet);
      if (d) {
        const km = haversineKm({ lat, lng }, { lat: asFloat(r.latitude), lng: asFloat(r.longitude) });
        hits.push({ id: r.id, name: r.name, km: Number.isFinite(km) ? +km.toFixed(1) : null, keyword: d.keyword, where: d.where });
      }
    }
    console.log(`[pool] final pass cuisine matches among fallback ${hits.length}/${newOnes.length} (sample 10):`, hits.slice(0,10));

    for (const r of newOnes) {
      if (acc.size >= desiredMin) break;
      acc.set(r.id, r);
    }
    console.log(`[pool] final pass acc after=${acc.size}`);
  }

  const out = Array.from(acc.values()).slice(0, desiredMin);
  console.log(`[pool] returning size=${out.length} (acc=${acc.size})\n`);
  return out;
}

module.exports = { ensurePreferredPool };
