// src/group/pool.js
//
// Group pool builder: composes A + B user pools, tags items with source,
// de-dupes, and caches per session.
//
// Depends on the generic single-user pool:
//   src/recs/pool.js -> ensurePreferredPool({ prisma, lat, lng, user, desiredMin })

const { ensurePreferredPool } = require("../recs/pool");

const poolCache = new Map();           // sessionId -> { items, ids, fromMap, at }
const TTL_MS = 5 * 60 * 1000;          // 5 minutes cache

function logIf(log, ...args) { try { log && log(...args); } catch (_) {} }
function isFresh(entry) { return entry && Array.isArray(entry.items) && (Date.now() - entry.at) < TTL_MS; }

/**
 * Build a combined pool for two users at two locations.
 * Returns { items: [{...restaurant, from: "A"|"B"}], ids: string[], fromMap: { [id]: "A"|"B" } }
 */
async function buildGroupPool({ prisma, aUser, bUser, locA, locB, want = 12, log }) {
  const wantPerUser = Math.max(3, Math.ceil(want / 2));

  const listA = locA
    ? await ensurePreferredPool({
        prisma,
        lat: locA.lat,
        lng: locA.lng,
        user: aUser,
        desiredMin: wantPerUser,
      })
    : [];

  const listB = locB
    ? await ensurePreferredPool({
        prisma,
        lat: locB.lat,
        lng: locB.lng,
        user: bUser,
        desiredMin: wantPerUser,
      })
    : [];

  logIf(log, "[group] pool(A-picked)", listA.slice(0, wantPerUser).map(r => ({ id: r.id, name: r.name })));
  logIf(log, "[group] pool(B-picked)", listB.slice(0, wantPerUser).map(r => ({ id: r.id, name: r.name })));

  // De-dupe + tag with source
  const seen = new Set();
  const combined = [];

  function push(list, srcTag) {
    for (const r of list) {
      if (combined.length >= want) break;
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      combined.push({ ...r, from: srcTag });
    }
  }

  // Stage 1: take up to half from A then B
  push(listA, "A");
  push(listB, "B");

  // Stage 2: fill remaining from leftovers
  if (combined.length < want) push(listA.slice(combined.length), "A");
  if (combined.length < want) push(listB.slice(combined.length), "B");

  const ids = combined.map(x => x.id);
  const fromMap = Object.fromEntries(combined.map(x => [x.id, x.from]));

  logIf(log, "[group] pool(combined)", { total: combined.length, ids });

  return { items: combined, ids, fromMap };
}

/**
 * Cached builder keyed by sessionId.
 */
async function getOrBuildSessionPool({
  sessionId,
  prisma,
  aUser,
  bUser,
  locA,
  locB,
  want = 12,
  force = false,
  log,
}) {
  if (!sessionId) throw new Error("sessionId required");
  const cached = poolCache.get(sessionId);
  if (!force && isFresh(cached)) {
    logIf(log, "[group] pool(cache-hit)", { sessionId, poolCount: cached.items.length });
    return cached;
  }
  const built = await buildGroupPool({ prisma, aUser, bUser, locA, locB, want, log });
  const entry = { ...built, at: Date.now() };
  poolCache.set(sessionId, entry);
  return entry;
}

function clearPool(sessionId) {
  poolCache.delete(sessionId);
}

module.exports = {
  buildGroupPool,
  getOrBuildSessionPool,
  clearPool,
};
