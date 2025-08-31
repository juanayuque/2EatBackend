// src/group/service.js
// Small helpers used by routes/group.js

'use strict';

const DEFAULT_MAX = Number(process.env.GROUP_MAX_SWIPES || 15);

/**
 * Store a location (locA or locB) into session.context without clobbering other keys.
 */
async function storeLocationForUser(prisma, { sessionId, key, lat, lng }) {
  if (!sessionId || !key || typeof lat !== 'number' || typeof lng !== 'number') {
    throw new Error('sessionId, key, lat, lng required');
  }
  const s = await prisma.groupSwipeSession.findUnique({ where: { id: sessionId } });
  if (!s) throw new Error('session not found');

  const ctx = Object(s.context || {});
  ctx[key] = { lat, lng };

  await prisma.groupSwipeSession.update({
    where: { id: sessionId },
    data: { context: ctx },
  });
  return true;
}

/**
 * Return counts for A & B; the router can map them to "you/partner".
 */
async function getSessionCounts(prisma, { sessionId, limit = DEFAULT_MAX }) {
  if (!sessionId) throw new Error('sessionId required');
  const s = await prisma.groupSwipeSession.findUnique({
    where: { id: sessionId },
    include: { events: { select: { userId: true } } },
  });
  if (!s) throw new Error('session not found');

  // figure A/B from session row
  const aId = s.aUserId || null;
  const bId = s.bUserId || null;

  const aCount = aId ? s.events.filter(e => e.userId === aId).length : 0;
  const bCount = bId ? s.events.filter(e => e.userId === bId).length : 0;

  return { aUserId: aId, bUserId: bId, aCount, bCount, limit };
}

/**
 * If both finished (>= limit), mark session completed (idempotent).
 */
async function maybeFinalizeSession(prisma, { sessionId, limit = DEFAULT_MAX }) {
  if (!sessionId) throw new Error('sessionId required');

  const s = await prisma.groupSwipeSession.findUnique({
    where: { id: sessionId },
    include: { events: { select: { userId: true } } },
  });
  if (!s) return false;
  if (s.status !== 'active') return false;

  const aCount = s.aUserId ? s.events.filter(e => e.userId === s.aUserId).length : 0;
  const bCount = s.bUserId ? s.events.filter(e => e.userId === s.bUserId).length : 0;

  if (aCount >= limit && bCount >= limit) {
    await prisma.groupSwipeSession.update({
      where: { id: sessionId },
      data: { status: 'completed', endedAt: new Date() },
    });
    return true;
  }
  return false;
}

module.exports = {
  storeLocationForUser,
  getSessionCounts,
  maybeFinalizeSession,
  DEFAULT_MAX,
};
