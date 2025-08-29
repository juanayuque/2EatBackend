// src/recs/rank.js
const { haversineKm, distanceBand, asFloat } = require("../utils/geo");

// Fallback fetch for older Node
const fetchFn =
  (typeof fetch === "function" && fetch) ||
  ((...args) => import("node-fetch").then((mod) => mod.default(...args)));

// Builds user feature vector used by external ranker
function buildUserFeatures(user) {
  const band = (() => {
    const max = user?.budgetMax;
    if (max == null) return 0;
    if (max <= 15) return 1;
    if (max <= 30) return 2;
    if (max <= 60) return 3;
    return 4;
  })();

  return [
    `uband:${band}`,
    ...(user?.preferredCuisines || []).map((c) => `ucuisine:${c}`),
    ...(user?.dietaryNeeds || []).map((d) => `ureq:${d}`),
  ];
}

// Builds item feature records for the ranker. Uses minimal fields (no photos).
function buildItemFeatures(items, lat, lng) {
  return items.map((r) => {
    const dist = haversineKm({ lat, lng }, { lat: asFloat(r.latitude), lng: asFloat(r.longitude) });
    return {
      id: r.id,
      priceLevel: r.priceLevel ?? null,
      distanceKm: dist,
      features: [
        `price:${r.priceLevel ?? 0}`,
        `dist:${distanceBand(dist)}`,
        ...(r.primaryType ? [`type:${r.primaryType}`] : []),
        ...(Array.isArray(r.types) ? r.types.map((t) => `type:${t}`) : []),
      ],
    };
  });
}

// Fire-and-forget warmup so the model compiles/caches features early
async function warmupRankAsync({ rankUrl, userId, userFeatures, items, lat, lng }) {
  try {
    await fetchFn(`${rankUrl}/rank`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user: { id: userId, features: userFeatures },
        items: buildItemFeatures(items, lat, lng),
        interactions: [],
      }),
    });
  } catch {
    // Warmup issues should be ignored
  }
}

// Ranks within a single page (keeps cursor semantics across pages)
async function rankIdsWithinPage({ rankUrl, userId, userFeatures, items, interactions }) {
  try {
    const r = await fetchFn(`${rankUrl}/rank`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user: { id: userId, features: userFeatures },
        items,
        interactions,
      }),
    });
    if (!r.ok) return [];
    const json = await r.json();
    const arr = Array.isArray(json?.rankings) ? json.rankings : [];
    const valid = new Set(items.map((x) => x.id));
    return arr.filter((id) => valid.has(id));
  } catch {
    return [];
  }
}

module.exports = {
  buildUserFeatures,
  buildItemFeatures,
  warmupRankAsync,
  rankIdsWithinPage,
};
