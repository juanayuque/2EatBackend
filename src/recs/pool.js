// src/recs/pool.js
const { filterAndPrioritizeByPreferences, requirementsFromUser, radiusFromUser } = require("./filters");
const { discoverAndIngestAround, buildBiasQueries } = require("./discovery");

// Ensures a preference-filtered pool of at least `desiredMin` items.
// Expands radius progressively and triggers discovery when needed.
async function ensurePreferredPool({ places, lat, lng, user, desiredMin = 60 }) {
  const baseRadius = radiusFromUser(user);
  const expansion = [baseRadius, Math.max(baseRadius, 5), 10, 15, 20, 30, 50];
  const req = requirementsFromUser(user);
  const biasQueries = buildBiasQueries(user);

  const acc = new Map();

  for (const radiusKm of expansion) {
    const dbPool = await places.ensureNearbyRestaurantsStrict(
      lat,
      lng,
      Math.max(desiredMin, 200),
      radiusKm,
      req
    );

    const filtered = filterAndPrioritizeByPreferences(dbPool, user, lat, lng, desiredMin, radiusKm);
    for (const r of filtered) if (!acc.has(r.id)) acc.set(r.id, r);
    if (acc.size >= desiredMin) break;

    await discoverAndIngestAround(places, lat, lng, {
      cellRadiusMeters: Math.round(radiusKm * 1000) || 3000,
      rankPrefs: ["POPULARITY", "DISTANCE"],
      includeTypes: [["restaurant"]],
      biasQueries,
    });
  }

  if (acc.size < desiredMin) {
    const lastRadius = expansion[expansion.length - 1];
    const finalPool = await places.ensureNearbyRestaurantsStrict(
      lat,
      lng,
      Math.max(desiredMin, 240),
      lastRadius,
      req
    );
    const filtered = filterAndPrioritizeByPreferences(finalPool, user, lat, lng, desiredMin, lastRadius);
    for (const r of filtered) if (!acc.has(r.id)) acc.set(r.id, r);
  }

  return Array.from(acc.values()).slice(0, desiredMin);
}

module.exports = { ensurePreferredPool };
