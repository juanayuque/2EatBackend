// routes/group.js
const express = require("express");
const prisma = require("../src/prisma");
const verifyFirebaseToken = require("../middleware/auth");
const { createPlacesService } = require("../src/services/placesService");

// session-aware helpers
const {
  getOrBuildSessionPool,
  nextCardForUser,
  storeLocationForUser,
  getSessionCounts,
  maybeFinalizeSession,
} = require("../src/group/service");

const router = express.Router();
router.use(verifyFirebaseToken);

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const places = createPlacesService({ prisma, googleApiKey: GOOGLE_API_KEY });

const MAX_SWIPES = Number(process.env.GROUP_MAX_SWIPES || 15);
const END_ON_SUPERSTAR = process.env.END_ON_SUPERSTAR === "1");

function log(tag, obj = {}) {
  try {
    console.log(`[group] ${tag}`, JSON.stringify(obj, null, 2));
  } catch {
    console.log(`[group] ${tag}`, obj);
  }
}

async function authedUser(firebaseUid) {
  return prisma.user.findUnique({ where: { firebaseUid } });
}

// ───────────────────────── Sessions list (for meta) ─────────────────────────
// Used by the TSX to get partner name and initial counts.
router.get("/sessions", async (req, res) => {
  try {
    const me = await authedUser(req.user.uid);
    if (!me) return res.status(404).json({ error: "User not found" });

    const sessions = await prisma.groupSwipeSession.findMany({
      where: {
        status: "active",
        OR: [{ aUserId: me.id }, { bUserId: me.id }],
      },
      orderBy: { startedAt: "desc" },
      select: {
        id: true,
        status: true,
        aUserId: true,
        bUserId: true,
        aUser: { select: { id: true, displayName: true, username: true } },
        bUser: { select: { id: true, displayName: true, username: true } },
      },
    });

    const out = [];
    for (const s of sessions) {
      const { aCount, bCount } = await getSessionCounts({ prisma, session: s });
      const youAreA = s.aUserId === me.id;
      const youCount = youAreA ? aCount : bCount;
      const partnerCount = youAreA ? bCount : aCount;
      const partner = youAreA ? s.bUser : s.aUser;

      out.push({
        id: s.id,
        status: s.status,
        partner: {
          id: partner?.id || null,
          name: partner?.displayName || partner?.username || "Friend",
          username: partner?.username || null,
        },
        youCount,
        partnerCount,
        limit: MAX_SWIPES,
      });
    }

    res.set("Cache-Control", "no-store");
    res.json({ sessions: out });
  } catch (err) {
    console.error("[group/sessions] error:", err);
    res.status(500).json({ error: "sessions failed" });
  }
});

// ───────────────────────── Set per-user location into session ─────────────────────────
// Client calls this when each participant opens the session (stores locA/locB).
router.post("/session/:id/start", async (req, res) => {
  try {
    const me = await authedUser(req.user.uid);
    if (!me) return res.status(404).json({ error: "User not found" });

    const sessionId = String(req.params.id || "");
    const { lat, lng } = req.body || {};
    if (typeof lat !== "number" || typeof lng !== "number") {
      return res.status(400).json({ error: "lat/lng required" });
    }

    const session = await prisma.groupSwipeSession.findUnique({
      where: { id: sessionId },
      select: { id: true, status: true, aUserId: true, bUserId: true, context: true },
    });
    if (!session) return res.status(404).json({ error: "session not found" });
    if (session.status !== "active") return res.status(410).json({ error: "session not active" });
    if (![session.aUserId, session.bUserId].includes(me.id)) {
      return res.status(403).json({ error: "not a participant" });
    }

    await storeLocationForUser({
      prisma,
      session,
      userId: me.id,
      lat,
      lng,
      logger: (t, o) => log(t, o),
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("[group/start] error:", err);
    res.status(500).json({ error: "start failed" });
  }
});

// ───────────────────────── Live state (poll) ─────────────────────────
// Returns counts, limit, and the *next card* for the caller as `next`.
router.get("/session/:id/state", async (req, res) => {
  try {
    const me = await authedUser(req.user.uid);
    if (!me) return res.status(404).json({ error: "User not found" });

    const sessionId = String(req.params.id || "");
    const session = await prisma.groupSwipeSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        status: true,
        aUserId: true,
        bUserId: true,
        context: true,
      },
    });
    if (!session) return res.status(404).json({ error: "session not found" });
    if (![session.aUserId, session.bUserId].includes(me.id)) {
      return res.status(403).json({ error: "not a participant" });
    }

    // Ensure pooled list exists (or fetch from cache)
    const pool = await getOrBuildSessionPool({
      prisma,
      places,
      session,
      want: 10,
      logger: (t, o) => log(t, o),
    });

    // counts & who you are
    const { aCount, bCount } = await getSessionCounts({ prisma, session });
    const youAreA = session.aUserId === me.id;
    const youCount = youAreA ? aCount : bCount;
    const partnerCount = youAreA ? bCount : aCount;

    // compute your next card deterministically from your count
    const { next } = await nextCardForUser({
      prisma,
      session,
      userId: me.id,
      logger: (t, o) => log(t, o),
    });

    // maybe complete if both are done or no next left for both
    await maybeFinalizeSession({ prisma, session, logger: (t, o) => log(t, o) });

    // Fetch fresh status (in case finalized above)
    const fresh = await prisma.groupSwipeSession.findUnique({
      where: { id: sessionId },
      select: { status: true, context: true },
    });

    const ctx = fresh?.context || {};
    const hasLocA = !!ctx.locA;
    const hasLocB = !!ctx.locB;

    res.set("Cache-Control", "no-store");
    res.json({
      status: fresh?.status || session.status,
      youCount,
      partnerCount,
      limit: MAX_SWIPES,
      hasLocA,
      hasLocB,
      next: next || null, // what your TSX uses to set the current card
    });
  } catch (err) {
    console.error("[group/session/state] error:", err);
    res.status(500).json({ error: "state failed" });
  }
});

// ───────────────────────── Feedback (LIKE/PASS/SUPERSTAR) ─────────────────────────
// Idempotent: if the same restaurant+action from this user already exists, we no-op.
router.post("/session/:id/feedback", async (req, res) => {
  try {
    const me = await authedUser(req.user.uid);
    if (!me) return res.status(404).json({ error: "User not found" });

    const sessionId = String(req.params.id || "");
    let { restaurantId, action } = req.body || {};
    action = String(action || "").toUpperCase();

    if (!restaurantId || !["LIKE", "PASS", "SUPERSTAR"].includes(action)) {
      return res.status(400).json({ error: "restaurantId + valid action required" });
    }

    const s = await prisma.groupSwipeSession.findUnique({
      where: { id: sessionId },
      include: { events: { orderBy: { createdAt: "asc" } } },
    });
    if (!s) return res.status(404).json({ error: "session not found" });
    if (![s.aUserId, s.bUserId].includes(me.id)) {
      return res.status(403).json({ error: "not a participant" });
    }
    if (s.status !== "active") {
      return res.status(410).json({ ok: false, sessionCompleted: true });
    }

    log("feedback", {
      sessionId,
      userId: me.id,
      restaurantId,
      action,
      position: s.events.length + 1,
    });

    // Strong idempotency: skip if an identical (sessionId, userId, restaurantId, action) exists
    const already = await prisma.groupSwipeEvent.findFirst({
      where: { sessionId, userId: me.id, restaurantId, action },
      select: { id: true },
    });
    if (already) {
      return res.json({
        ok: true,
        duplicate: true,
        shouldRerank: false,
        shouldSuggestMatch: false,
        sessionCompleted: false,
      });
    }

    // Also guard against repeat of the very last event (common with double taps)
    const last = s.events[s.events.length - 1];
    if (last && last.userId === me.id && last.restaurantId === restaurantId && last.action === action) {
      return res.json({
        ok: true,
        duplicate: true,
        shouldRerank: false,
        shouldSuggestMatch: false,
        sessionCompleted: false,
      });
    }

    let sessionCompleted = false;
    const position = s.events.length + 1;

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
      const endNow = reached || (END_ON_SUPERSTAR && action === "SUPERSTAR");
      if (endNow) {
        await tx.groupSwipeSession.update({
          where: { id: sessionId },
          data: { status: "completed", endedAt: new Date() },
        });
        sessionCompleted = true;
      }
    });

    const nextCount = (s.totalSwipes ?? s.events.length) + 1;
    const shouldRerank = nextCount % 5 === 0;
    const shouldSuggestMatch = sessionCompleted || nextCount >= MAX_SWIPES;

    res.json({ ok: true, shouldRerank, shouldSuggestMatch, sessionCompleted });
  } catch (err) {
    console.error("[group/session/feedback] error:", err);
    res.status(500).json({ error: "feedback failed" });
  }
});

module.exports = router;
