// src/group/service.js
'use strict';

const prisma = require('../prisma'); // shared Prisma client
const { getOrBuildSessionPool, nextCardForUser } = require('./pool');

/**
 * Persist a user's location into the group's session context.
 * Expects key to be "locA" or "locB" (the caller decides which).
 */
async function storeLocationForUser({ sessionId, userId, key, lat, lng }) {
  if (!sessionId || !key || typeof lat !== 'number' || typeof lng !== 'number') {
    throw new Error('sessionId, key, lat, lng required');
  }
  // Merge into existing JSON context
  const s = await prisma.groupSwipeSession.findUnique({
    where: { id: sessionId },
    select: { context: true },
  });
  const ctx = (s?.context && typeof s.context === 'object') ? s.context : {};
  const next = { ...ctx, [key]: { lat, lng, at: Date.now(), by: userId || null } };

  await prisma.groupSwipeSession.update({
    where: { id: sessionId },
    data: { context: next },
  });

  return { ok: true, key, lat, lng };
}

/**
 * Return per-user swipe counts so the UI can render "You X/Y • Friend A/B".
 * If you pass currentUserId, we’ll also shape counts as {youCount, partnerCount}.
 */
async function getSessionCounts({ sessionId, currentUserId } = {}) {
  if (!sessionId) throw new Error('sessionId required');

  const s = await prisma.groupSwipeSession.findUnique({
    where: { id: sessionId },
    select: { aUserId: true, bUserId: true, status: true },
  });
  if (!s) throw new Error('session not found');

  // Count events grouped by user
  const grouped = await prisma.groupSwipeEvent.groupBy({
    by: ['userId'],
    where: { sessionId },
    _count: { _all: true },
  });

  const byUser = Object.fromEntries(grouped.map(g => [g.userId, g._count._all]));
  const aCount = byUser[s.aUserId] || 0;
  const bCount = byUser[s.bUserId] || 0;

  if (!currentUserId) {
    return {
      aUserId: s.aUserId,
      bUserId: s.bUserId,
      aCount,
      bCount,
      status: s.status,
    };
  }

  const youIsA = currentUserId === s.aUserId;
  return {
    youCount: youIsA ? aCount : bCount,
    partnerCount: youIsA ? bCount : aCount,
    aUserId: s.aUserId,
    bUserId: s.bUserId,
    status: s.status,
  };
}

/**
 * Opportunistically mark a session completed if both users hit MAX
 * or if either SUPERSTAR’d (when endOnSuperstar is true).
 * Returns the (possibly updated) status.
 */
async function maybeFinalizeSession({ sessionId, maxSwipes = 15, endOnSuperstar = false } = {}) {
  if (!sessionId) throw new Error('sessionId required');

  const s = await prisma.groupSwipeSession.findUnique({
    where: { id: sessionId },
    select: { id: true, status: true },
  });
  if (!s) throw new Error('session not found');
  if (s.status !== 'active') return s.status;

  // Per-user counts
  const grouped = await prisma.groupSwipeEvent.groupBy({
    by: ['userId'],
    where: { sessionId },
    _count: { _all: true },
  });
  const counts = grouped.map(g => g._count._all);
  const bothAtMax = counts.length >= 2 && counts.every(c => c >= maxSwipes);

  let superstar = null;
  if (endOnSuperstar) {
    const star = await prisma.groupSwipeEvent.findFirst({
      where: { sessionId, action: 'SUPERSTAR' },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    superstar = !!star;
  }

  if (bothAtMax || superstar) {
    await prisma.groupSwipeSession.update({
      where: { id: sessionId },
      data: { status: 'completed', endedAt: new Date() },
    });
    return 'completed';
  }
  return 'active';
}

// IMPORTANT: CommonJS named exports
module.exports = {
  // re-export pool helpers so routes can destructure from this module
  getOrBuildSessionPool,
  nextCardForUser,

  // local utilities used by routes/group.js
  storeLocationForUser,
  getSessionCounts,
  maybeFinalizeSession,
};
