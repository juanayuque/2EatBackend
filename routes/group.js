// routes/group.js
'use strict';

const express = require('express');
const prisma = require('../src/prisma');
const verifyFirebaseToken = require('../middleware/auth');

// Import pool helpers directly (primary path)
const poolMod = require('../src/group/pool');
// Import service utils (counts/finalize/save loc)
const {
  storeLocationForUser,
  getSessionCounts,
  maybeFinalizeSession,
} = require('../src/group/service');

// Resolve helpers with a safe fallback (in case someone re-exports later)
const getOrBuildSessionPool =
  typeof poolMod?.getOrBuildSessionPool === 'function'
    ? poolMod.getOrBuildSessionPool
    : (poolMod && typeof poolMod === 'function' ? poolMod : null);

const nextCardForUser =
  typeof poolMod?.nextCardForUser === 'function'
    ? poolMod.nextCardForUser
    : null;

// Config
const MAX_SWIPES = Number(process.env.GROUP_MAX_SWIPES || 15);
const END_ON_SUPERSTAR = process.env.END_ON_SUPERSTAR === '1';

const router = express.Router();
router.use(verifyFirebaseToken);

// ───────────────────────── helpers ─────────────────────────
async function authedUser(firebaseUid) {
  return prisma.user.findUnique({ where: { firebaseUid } });
}

function pickPairIds(session) {
  // Schema has aUserId/bUserId (your posted schema). If older fields exist in your DB,
  // we DO NOT select them here to avoid Prisma errors on unknown fields.
  return { aId: session.aUserId || null, bId: session.bUserId || null };
}

function partnerOf(session, meId) {
  const { aId, bId } = pickPairIds(session);
  if (meId === aId) return bId;
  if (meId === bId) return aId;
  return null;
}

function keyFor(session, meId) {
  const { aId, bId } = pickPairIds(session);
  if (meId === aId) return 'locA';
  if (meId === bId) return 'locB';
  return null;
}

// ─────────────────────── list sessions ─────────────────────
router.get('/sessions', async (req, res) => {
  try {
    const me = await authedUser(req.user.uid);
    if (!me) return res.status(404).json({ error: 'User not found' });

    const rows = await prisma.groupSwipeSession.findMany({
      where: {
        status: 'active',
        OR: [{ aUserId: me.id }, { bUserId: me.id }],
      },
      orderBy: { startedAt: 'desc' },
      select: {
        id: true,
        status: true,
        startedAt: true,
        aUserId: true,
        bUserId: true,
        aUser: { select: { id: true, displayName: true, username: true } },
        bUser: { select: { id: true, displayName: true, username: true } },
      },
    });

    // Compute counts per session
    const out = [];
    for (const s of rows) {
      const { youCount, partnerCount } = await getSessionCounts({
        sessionId: s.id,
        currentUserId: me.id,
      });
      const partnerId = partnerOf(s, me.id);
      const partner =
        partnerId === s.aUser?.id ? s.aUser :
        partnerId === s.bUser?.id ? s.bUser : null;

      out.push({
        id: s.id,
        status: s.status,
        startedAt: s.startedAt,
        partner: partner
          ? { id: partner.id, name: partner.displayName || 'Friend', username: partner.username || null }
          : { id: partnerId, name: 'Friend', username: null },
        youCount,
        partnerCount,
        limit: MAX_SWIPES,
      });
    }

    res.json({ sessions: out });
  } catch (err) {
    console.error('[group/sessions] error:', err);
    res.status(500).json({ error: 'sessions failed' });
  }
});

// ───────────────────── set/join (location) ──────────────────
// Client hits this when the screen opens to register its lat/lng.
// We compute locA/locB based on who the caller is.
router.post('/session/:id/start', async (req, res) => {
  try {
    const me = await authedUser(req.user.uid);
    if (!me) return res.status(404).json({ error: 'User not found' });

    const sessionId = String(req.params.id || '');
    const { lat, lng } = req.body || {};
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      return res.status(400).json({ error: 'lat,lng required' });
    }

    const s = await prisma.groupSwipeSession.findUnique({
      where: { id: sessionId },
      select: { id: true, status: true, aUserId: true, bUserId: true, context: true },
    });
    if (!s) return res.status(404).json({ error: 'Session not found' });

    const k = keyFor(s, me.id);
    if (!k) return res.status(403).json({ error: 'Not a participant' });

    await storeLocationForUser({ sessionId, userId: me.id, key: k, lat, lng });

    res.json({ ok: true });
  } catch (err) {
    console.error('[group/start] error:', err);
    res.status(500).json({ error: 'start failed' });
  }
});

// ───────────────────────── state ────────────────────────────
// Returns live counts + the *current* card for this user (as `next`)
router.get('/session/:id/state', async (req, res) => {
  try {
    if (!getOrBuildSessionPool || !nextCardForUser) {
      throw new Error('pool helpers not loaded (check src/group/pool.js exports)');
    }

    const me = await authedUser(req.user.uid);
    if (!me) return res.status(404).json({ error: 'User not found' });

    const sessionId = String(req.params.id || '');
    const s = await prisma.groupSwipeSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        status: true,
        aUserId: true,
        bUserId: true,
        context: true,
      },
    });
    if (!s) return res.status(404).json({ error: 'Session not found' });

    // finalize opportunistically
    const status = await maybeFinalizeSession({
      sessionId,
      maxSwipes: MAX_SWIPES,
      endOnSuperstar: END_ON_SUPERSTAR,
    });

    // counts
    const { youCount, partnerCount } = await getSessionCounts({
      sessionId,
      currentUserId: me.id,
    });

    // Build/ensure a pool if we have both locations; otherwise we’ll still try with whichever exists.
    const ctx = (s.context && typeof s.context === 'object') ? s.context : {};
    const locA = ctx.locA || null;
    const locB = ctx.locB || null;

    // Fetch both users (for combined prefs inside pool builder)
    const [userA, userB] = await Promise.all([
      s.aUserId ? prisma.user.findUnique({ where: { id: s.aUserId } }) : null,
      s.bUserId ? prisma.user.findUnique({ where: { id: s.bUserId } }) : null,
    ]);

    const want = 10; // per user; pool builder can use 2*want
    await getOrBuildSessionPool({
      prisma,
      sessionId,
      want,
      aUser: userA,
      bUser: userB,
      locA,
      locB,
    });

    // Current card for this user
    const card = await nextCardForUser({ prisma, sessionId, userId: me.id });

    res.set('Cache-Control', 'no-store');
    return res.json({
      status,
      youCount,
      partnerCount,
      limit: MAX_SWIPES,
      next: card || null, // { id, name, ... client-facing fields, from: "A"|"B"|"both"|null }
    });
  } catch (err) {
    console.error('[group/session/state] error:', err);
    res.status(500).json({ error: 'state failed' });
  }
});

// ─────────────────────── feedback ───────────────────────────
// Records the action and relies on polling state to deliver the *next* card.
router.post('/session/:id/feedback', async (req, res) => {
  try {
    const me = await authedUser(req.user.uid);
    if (!me) return res.status(404).json({ error: 'User not found' });

    const sessionId = String(req.params.id || '');
    let { restaurantId, action } = req.body || {};
    action = String(action || '').toUpperCase();

    if (!restaurantId || !['LIKE', 'PASS', 'SUPERSTAR'].includes(action)) {
      return res.status(400).json({ error: 'restaurantId & action required' });
    }

    const s = await prisma.groupSwipeSession.findUnique({
      where: { id: sessionId },
      include: { events: { orderBy: { createdAt: 'asc' } } },
    });
    if (!s) return res.status(404).json({ error: 'Session not found' });
    if (s.status !== 'active') {
      return res.status(410).json({ ok: false, sessionCompleted: true });
    }
    const { aId, bId } = pickPairIds(s);
    if (me.id !== aId && me.id !== bId) {
      return res.status(403).json({ error: 'Not a participant' });
    }

    // Idempotency (prevents rapid dupes when UI double-submits)
    const last = s.events[s.events.length - 1];
    if (last && last.userId === me.id && last.restaurantId === restaurantId && last.action === action) {
      return res.json({ ok: true, duplicate: true, sessionCompleted: false });
    }

    const position = s.events.length + 1;
    let sessionCompleted = false;

    await prisma.$transaction(async (tx) => {
      await tx.groupSwipeEvent.create({
        data: { sessionId, userId: me.id, restaurantId, action, position },
      });
      const updated = await tx.groupSwipeSession.update({
        where: { id: sessionId },
        data: { totalSwipes: { increment: 1 } },
        select: { totalSwipes: true },
      });

      const reached = (updated.totalSwipes ?? position) >= MAX_SWIPES;
      const endNow = reached || (END_ON_SUPERSTAR && action === 'SUPERSTAR');
      if (endNow) {
        await tx.groupSwipeSession.update({
          where: { id: sessionId },
          data: { status: 'completed', endedAt: new Date() },
        });
        sessionCompleted = true;
      }
    });

    res.json({ ok: true, sessionCompleted });
  } catch (err) {
    console.error('[group/feedback] error:', err);
    res.status(500).json({ error: 'feedback failed' });
  }
});

module.exports = router;
