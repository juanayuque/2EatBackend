// src/group/service.js
// Helpers for group swiping: building a 2-user pool, caching it in session.context,
// and picking the next card deterministically (one index per user).

const { ensurePreferredPool } = require("../recs/pool");
const { haversineKm, asFloat } = require("../utils/geo");

const BACKEND_PUBLIC_URL = process.env.BACKEND_PUBLIC_URL || "https://2eatapp.com";

// --- tiny utilities ---
const asLoc = (obj) =>
  obj && typeof obj.lat === "number" && typeof obj.lng === "number" ? obj : null;

const pickFields = (u) => ({
  id: u.id,
  displayName: u.displayName || null,
  username: u.username || null,
  email: u.email || null,
  // prefs needed by ensurePreferredPool / filters
  searchDistance: u.searchDistance ?? null,
  budgetMax: u.budgetMax ?? null,
  dietaryNeeds: Array.isArray(u.dietaryNeeds) ? u.dietaryNeeds : [],
  preferredCuisines: Array.isArray(u.preferredCuisines) ? u.preferredCuisines : [],
});

/**
 * Fetch a user's "preference payload" by id (only the fields we need).
 */
async function fetchUserLite(prisma, userId) {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      displayName: true,
      username: true,
      email: true,
      searchDistance: true,
      budgetMax: true,
      dietaryNeeds: true,
      preferredCuisines: true,
    },
  });
  return u ? pickFields(u) : null;
}

/**
 * Build a preferred pool for one user at a given location.
 * Returns an array of { id, name } minimal items.
 */
async function fetchForUserAt({ places, user, lat, lng, desiredMin }) {
  const pool = await ensurePreferredPool({
    places,
    lat,
    lng,
    user,
    desiredMin,
  });
  // normalize to id+name for caching
  return pool.map((r) => ({ id: r.id, name: r.name }));
}

/**
 * Create (and cache) the combined pool in session.context if missing.
 * Returns { poolIds, poolFrom } where poolFrom maps restaurantId -> 'A' | 'B'
 */
async function getOrBuildSessionPool({
  prisma,
  places,
  session, // GroupSwipeSession row (include: { aUserId, bUserId, context })
  want = 10, // how many from each user to try to include
  locA,
  locB,
  logger = () => {},
}) {
  const ctx = session.context || {};

  // Cached?
  if (Array.isArray(ctx.pool) && ctx.pool.length) {
    logger("pool(cache-hit)", { sessionId: session.id, poolCount: ctx.pool.length });
    return { poolIds: ctx.pool, poolFrom: ctx.poolFrom || {} };
  }

  // Resolve users & locations
  const aUser = session.aUserId ? await fetchUserLite(prisma, session.aUserId) : null;
  const bUser = session.bUserId ? await fetchUserLite(prisma, session.bUserId) : null;

  const locA_ = asLoc(locA || ctx.locA);
  const locB_ = asLoc(locB || ctx.locB);

  logger("pool(start)", {
    sessionId: session.id,
    want,
    aUser: aUser && { id: aUser.id, name: aUser.displayName || aUser.username || aUser.email || "A", prefs: {
      distance: aUser.searchDistance ?? null,
      budgetMax: aUser.budgetMax ?? null,
      dietaryNeeds: aUser.dietaryNeeds,
      preferredCuisines: aUser.preferredCuisines,
    }},
    bUser: bUser && { id: bUser.id, name: bUser.displayName || bUser.username || bUser.email || "B", prefs: {
      distance: bUser.searchDistance ?? null,
      budgetMax: bUser.budgetMax ?? null,
      dietaryNeeds: bUser.dietaryNeeds,
      preferredCuisines: bUser.preferredCuisines,
    }},
    locA: locA_,
    locB: locB_,
  });

  if (!locA_ && !locB_) {
    logger("pool(no-locations)", { sessionId: session.id });
    return { poolIds: [], poolFrom: {} };
  }

  const takeA = Math.max(0, Number(want || 0));
  const takeB = Math.max(0, Number(want || 0));
  let aPicks = [];
  let bPicks = [];

  if (aUser && locA_) {
    try {
      aPicks = await fetchForUserAt({
        places,
        user: aUser,
        lat: locA_.lat,
        lng: locA_.lng,
        desiredMin: takeA,
      });
    } catch (e) {
      logger("pool(A-error)", { message: e?.message || String(e) });
    }
  }

  if (bUser && locB_) {
    try {
      bPicks = await fetchForUserAt({
        places,
        user: bUser,
        lat: locB_.lat,
        lng: locB_.lng,
        desiredMin: takeB,
      });
    } catch (e) {
      logger("pool(B-error)", { message: e?.message || String(e) });
    }
  }

  // Tag and interleave: A1,B1,A2,B2,...
  const tagged = [];
  const maxLen = Math.max(aPicks.length, bPicks.length);
  for (let i = 0; i < maxLen; i++) {
    if (i < aPicks.length) tagged.push({ ...aPicks[i], from: "A" });
    if (i < bPicks.length) tagged.push({ ...bPicks[i], from: "B" });
  }

  // Deduplicate by id (preserve first seen source)
  const seen = new Set();
  const poolFrom = {};
  const combined = [];
  for (const r of tagged) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    combined.push(r);
    poolFrom[r.id] = r.from || null;
  }

  logger("pool(combined)", {
    sessionId: session.id,
    total: combined.length,
    ids: combined.map((x) => x.id),
  });

  // Persist to session.context
  const newCtx = {
    ...(ctx || {}),
    locA: locA_ || ctx.locA || null,
    locB: locB_ || ctx.locB || null,
    pool: combined.map((x) => x.id),
    poolFrom,
    poolBuiltAt: Date.now(),
  };

  await prisma.groupSwipeSession.update({
    where: { id: session.id },
    data: { context: newCtx },
  });

  return { poolIds: newCtx.pool, poolFrom: newCtx.poolFrom };
}

/**
 * Compute the next card for a given user:
 * - index = number of events by this user in this session
 * - item = context.pool[index]
 * Returns { idx, countForUser, restaurant, from } or null if none.
 */
async function nextCardForUser({ prisma, session, userId, logger = () => {} }) {
  const ctx = session.context || {};
  const pool = Array.isArray(ctx.pool) ? ctx.pool : [];
  if (!pool.length) return null;

  const countForUser = await prisma.groupSwipeEvent.count({
    where: { sessionId: session.id, userId },
  });
  const idx = countForUser; // deterministic, one index per user
  if (idx < 0 || idx >= pool.length) return { idx, countForUser, restaurant: null, from: null };

  const id = pool[idx];
  const r = await prisma.restaurant.findUnique({
    where: { id },
    include: { photos: { take: 1 } },
  });
  if (!r) return { idx, countForUser, restaurant: null, from: null };

  const photoName = r.photos?.[0]?.name || null;
  const photoUrl = photoName
    ? `${BACKEND_PUBLIC_URL}/api/recs/photo?name=${encodeURIComponent(photoName)}&w=1200`
    : null;

  // distance is only meaningful if we have a reference (locA/locB) – we omit here
  const restaurant = {
    id: r.id,
    name: r.name,
    address: r.formattedAddress,
    priceLevel: r.priceLevel ?? null,
    photoUrl,
    primaryType: r.primaryType,
    types: r.types,
    editorialSummary: r.editorialSummary || null,
    editorial_summary: r.editorialSummary || null,
    allowsDogs: r.allowsDogs ?? null,
    parkingOptions: r.parkingOptions ?? null,
  };

  const from = ctx.poolFrom && ctx.poolFrom[id] ? ctx.poolFrom[id] : null;

  logger("nextCard", {
    sessionId: session.id,
    userId,
    countForUser,
    idx,
    restaurant: { id: restaurant.id, name: restaurant.name },
    from,
  });

  return { idx, countForUser, restaurant, from };
}

/**
 * Store a lat/lng into the session context for the correct side (locA/locB).
 * Decides based on whether userId matches aUserId or bUserId.
 */
async function storeLocationForUser({ prisma, session, userId, lat, lng, logger = () => {} }) {
  const key =
    session.aUserId && session.aUserId === userId
      ? "locA"
      : session.bUserId && session.bUserId === userId
      ? "locB"
      : null;

  if (!key) return { updated: false, reason: "user-not-in-session" };

  const ctx = session.context || {};
  const newCtx = { ...ctx, [key]: { lat, lng } };

  await prisma.groupSwipeSession.update({
    where: { id: session.id },
    data: { context: newCtx },
  });

  logger("start(set-loc)", { sessionId: session.id, userId, key, lat, lng });
  return { updated: true, key };
}

module.exports = {
  fetchUserLite,
  fetchForUserAt,
  getOrBuildSessionPool,
  nextCardForUser,
  storeLocationForUser,
};
