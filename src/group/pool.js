// src/group/pool.js
// Group-specific pool helpers. Builds a combined pool for A & B and
// serves the "next" card deterministically for a given user.

'use strict';

const { ensurePreferredPool } = require('../recs/pool');

// in-proc cache: { [sessionId]: { ids: string[], fromById: Map<string,'A'|'B'|null>, builtAt: number } }
const POOLS = new Map();
const CACHE_MS = 10 * 60 * 1000; // 10 minutes

function getCached(sessionId) {
  const ent = POOLS.get(sessionId);
  if (!ent) return null;
  if (Date.now() - ent.builtAt > CACHE_MS) {
    POOLS.delete(sessionId);
    return null;
  }
  return ent;
}

async function buildPool({ prisma, places, session, want = 20 }) {
  // session.context holds locations like { locA: {lat,lng}, locB: {lat,lng} }
  const ctx = session.context || {};
  const locA = ctx.locA || ctx.a || null;
  const locB = ctx.locB || ctx.b || null;

  // Load users A & B
  const [aUser, bUser] = await Promise.all([
    session.aUserId ? prisma.user.findUnique({ where: { id: session.aUserId } }) : null,
    session.bUserId ? prisma.user.findUnique({ where: { id: session.bUserId } }) : null,
  ]);

  // Pull up to half from each side (fallback to whichever has results)
  const half = Math.max(1, Math.floor(want / 2));

  let aPool = [];
  if (aUser && locA) {
    aPool = await ensurePreferredPool({
      places,
      lat: Number(locA.lat),
      lng: Number(locA.lng),
      user: aUser,
      desiredMin: half,
    });
  }

  let bPool = [];
  if (bUser && locB) {
    bPool = await ensurePreferredPool({
      places,
      lat: Number(locB.lat),
      lng: Number(locB.lng),
      user: bUser,
      desiredMin: half,
    });
  }

  // Tag and combine, preserving order by each side
  const fromById = new Map();
  const out = [];

  function pushSide(arr, tag) {
    for (const r of arr) {
      if (!fromById.has(r.id)) {
        fromById.set(r.id, tag); // remember original source
        out.push(r.id);
      }
    }
  }

  pushSide(aPool, 'A');
  pushSide(bPool, 'B');

  // If one side was empty, you still get something (just one sided).
  // Cap to desired size (or leave full — up to you)
  const ids = out.slice(0, want);

  return { ids, fromById };
}

/**
 * Public: Build or reuse a session pool (IDs + origin map)
 */
async function getOrBuildSessionPool({ prisma, places, sessionId, want = 20 }) {
  if (!sessionId) throw new Error('sessionId required');

  // cached?
  const cached = getCached(sessionId);
  if (cached) return cached;

  // fetch session basics needed: user ids + context
  const session = await prisma.groupSwipeSession.findUnique({
    where: { id: sessionId },
    select: { id: true, aUserId: true, bUserId: true, context: true },
  });
  if (!session) throw new Error('session not found');

  const { ids, fromById } = await buildPool({ prisma, places, session, want });
  const ent = { ids, fromById, builtAt: Date.now() };
  POOLS.set(sessionId, ent);
  return ent;
}

/**
 * Public: Given user + session, return the next restaurant (and origin tag)
 * Deterministic: index = (# events for this user)
 */
async function nextCardForUser({ prisma, sessionId, userId, places, want = 20 }) {
  if (!sessionId || !userId) throw new Error('sessionId & userId required');

  // count swipes for *this* user in this session
  const [s, pool] = await Promise.all([
    prisma.groupSwipeSession.findUnique({
      where: { id: sessionId },
      include: { events: { select: { userId: true, restaurantId: true, position: true } } },
    }),
    getOrBuildSessionPool({ prisma, places, sessionId, want }),
  ]);
  if (!s) throw new Error('session not found');

  const userEvents = (s.events || []).filter(e => e.userId === userId);
  const idx = userEvents.length; // 0-based
  const id = pool.ids[idx] || null;
  if (!id) return { idx, restaurant: null, from: null };

  const from = pool.fromById.get(id) || null;
  const r = await prisma.restaurant.findUnique({
    where: { id },
    select: { id: true, name: true },
  });

  return { idx, restaurant: r, from };
}

module.exports = {
  getOrBuildSessionPool,
  nextCardForUser,
};
