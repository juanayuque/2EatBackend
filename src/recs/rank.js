// src/recs/rank.js
const { haversineKm, distanceBand, asFloat } = require("../utils/geo");

// Fallback fetch for older Node
const fetchFn =
  (typeof fetch === "function" && fetch) ||
  ((...args) => import("node-fetch").then((mod) => mod.default(...args)));

const DBG = process.env.RECS_DEBUG === "1";

function log(...args) {
  if (DBG) console.log("[rank]", ...args);
}

/** Build user feature vector for the ranker */
function buildUserFeatures(user) {
  const max = user?.budgetMax;
  const band =
    max == null ? 0 :
    max <= 15 ? 1 :
    max <= 30 ? 2 :
    max <= 60 ? 3 : 4;

  return [
    `uband:${band}`,
    ...(Array.isArray(user?.preferredCuisines) ? user.preferredCuisines : []).map((c) => `ucuisine:${c}`),
    ...(Array.isArray(user?.dietaryNeeds) ? user.dietaryNeeds : []).map((d) => `ureq:${d}`),
  ];
}

/** Build item feature records for the ranker (no photos, minimal payload) */
function buildItemFeatures(items, lat, lng) {
  const arr = Array.isArray(items) ? items : [];
  return arr
    .filter((r) => r && typeof r.id === "string")
    .map((r) => {
      const dist = haversineKm(
        { lat, lng },
        { lat: asFloat(r.latitude), lng: asFloat(r.longitude) }
      );
      const features = [
        `price:${r.priceLevel ?? 0}`,
        `dist:${distanceBand(dist)}`,
        ...(r.primaryType ? [`type:${r.primaryType}`] : []),
        ...(Array.isArray(r.types) ? r.types.map((t) => `type:${t}`) : []),
      ];
      return {
        id: r.id,
        priceLevel: r.priceLevel ?? null,
        distanceKm: dist,
        features,
      };
    });
}

/** Internal: POST to /rank with timeout; returns rankings[] or null on failure */
async function requestRank({ rankUrl, payload, timeoutMs = 1200 }) {
  const controller = new (global.AbortController || (await import("abort-controller")).default)();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetchFn(`${rankUrl}/rank`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      log(`rank HTTP ${r.status}`);
      return null;
    }
    const json = await r.json().catch(() => null);
    if (!json || !Array.isArray(json.rankings)) {
      log("rank bad payload");
      return null;
    }
    return json.rankings;
  } catch (e) {
    log("rank error:", e?.message || e);
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Fire-and-forget warmup so the model compiles/caches features early */
async function warmupRankAsync({ rankUrl, userId, userFeatures, items, lat, lng, timeoutMs = 1000 }) {
  try {
    const payload = {
      user: { id: userId, features: userFeatures },
      items: buildItemFeatures(items, lat, lng),
      interactions: [],
    };
    // Ignore response; best-effort only
    await requestRank({ rankUrl, payload, timeoutMs });
  } catch {
    /* ignore warmup issues */
  }
}

/**
 * Rank within a single page.
 * Returns an ordered array of item IDs; if ranking fails, returns identity order.
 */
async function rankIdsWithinPage({
  rankUrl,
  userId,
  userFeatures,
  items,          // output of buildItemFeatures([...], lat, lng)
  interactions,
  timeoutMs = 1200,
}) {
  const safeItems = Array.isArray(items) ? items : [];
  const identity = safeItems.map((i) => i.id);

  // Nothing to rank
  if (!identity.length) return identity;

  const payload = {
    user: { id: userId, features: userFeatures },
    items: safeItems,
    interactions: Array.isArray(interactions) ? interactions : [],
  };

  const rankings = await requestRank({ rankUrl, payload, timeoutMs });
  if (!rankings || !rankings.length) {
    // Fallback: identity order (preserves cursor semantics)
    return identity;
  }

  // Keep only IDs that are in the current page
  const allowed = new Set(identity);
  const filtered = rankings.filter((id) => allowed.has(id));

  // If service dropped some ids, append the missing ones in identity order
  if (filtered.length < identity.length) {
    const missing = identity.filter((id) => !filtered.includes(id));
    return filtered.concat(missing);
  }

  return filtered;
}

module.exports = {
  buildUserFeatures,
  buildItemFeatures,
  warmupRankAsync,
  rankIdsWithinPage,
};
