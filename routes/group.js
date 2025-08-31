// routes/group.js
// Group swiping (DB-only). No Places API calls here.

const express = require("express");
const prisma = require("../src/prisma");
const verifyFirebaseToken = require("../middleware/auth");

const { getOrBuildSessionPool, clearPool } = require("../src/group/pool");

const router = express.Router();
router.use(verifyFirebaseToken);

const MAX_SWIPES = Number(process.env.GROUP_MAX_SWIPES || 15);
const END_ON_SUPERSTAR = process.env.END_ON_SUPERSTAR === "1";

// ───────────────────────── helpers ─────────────────────────

async function authedUser(firebaseUid) {
  return prisma.user.findUnique({ where: { firebaseUid } });
}

function prefsFromUser(u) {
  if (!u) return { distance: null, budgetMax: null, dietaryNeeds: [], preferredCuisines: [] };
  return {
    distance: u.searchDistance ?? null,
    budgetMax: u.budgetMax ?? null,
    dietaryNeeds: Array.isArray(u.dietaryNeeds) ? u.dietaryNeeds : [],
    preferredCuisines: Array.isArray(u.preferredCuisines) ? u.preferredCuisines : [],
  };
}

function extractLoc(ctx, key) {
  const c = (ctx && typeof ctx === "object" && ctx) || {};
  const v = c[key];
  if (!v || typeof v !== "object") return null;
  const lat = Number(v.lat);
  const lng = Number(v.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

async function putLocationInContext({ sessionId, key, lat, lng, by }) {
  if (!sessionId || !key || typeof lat !== "number" || typeof lng !== "number") {
    throw new Error("sessionId, key, lat, lng required");
  }
  const s = await prisma.groupSwipeSession.findUnique({ where: { id: sessionId }, select: { context: true } });
  const ctx = (s?.context && typeof s.context === "object" && s.context) || {};
  ctx[key] = { lat, lng, by, at: Date.now() };
  await prisma.groupSwipeSession.update({ where: { id: sessionId }, data: { context: ctx } });
}

function userABFromSession(session) {
  // A = aUser (or startedBy as fallback), B = bUser
  const userA = session.aUser || session.startedBy || null;
  const userB = session.bUser || null;
  return { userA, userB };
}

function tagForUserId(session, uid) {
  if (session.aUserId && session.aUserId === uid) return "A";
  if (session.bUserId && session.bUserId === uid) return "B";
  if (session.startedById && session.startedById === uid && !session.aUserId) return "A";
  return null;
}

// ───────────────────────── endpoints ─────────────────────────

// List my recent group sessions (tolerant; no params required).
router.get("/sessions", async (req, res) => {
  try {
    const me = await authedUser(req.user.uid);
    if (!me) return res.status(404).json({ error: "User not found" });

    const sessions = await prisma.groupSwipeSession.findMany({
      where: {
        OR: [{ startedById: me.id }, { aUserId: me.id }, { bUserId: me.id }],
      },
      orderBy: { startedAt: "desc" },
      take: 10,
      select: { id: true, status: true, startedAt: true, endedAt: true, aUserId: true, bUserId: true, startedById: true },
    });

    res.json({ sessions });
  } catch (err) {
    console.error("[group/sessions] error:", err);
    res.status(500).json({ error: "failed" });
  }
});

// Save a location for A or B (locA / locB) into session.context
router.post("/session/:id/start", async (req, res) => {
  try {
    const me = await authedUser(req.user.uid);
    if (!me) return res.status(404).json({ error: "User not found" });

    const sessionId = String(req.params.id || "");
    const { key, lat, lng } = req.body || {};
    if (!["locA", "locB"].includes(String(key))) {
      return res.status(400).json({ error: "key must be locA or locB" });
    }
    await putLocationInContext({ sessionId, key, lat, lng, by: me.id });
    // Clear any cached pool so fresh loc is used on next state call.
    clearPool(sessionId);
    return res.json({ ok: true });
  } catch (err) {
    console.error("[group/start] error:", err);
    res.status(400).json({ error: err.message || "start failed" });
  }
});

// Current state + next card for *me* (stable based on my own count)
router.get("/session/:id/state", async (req, res) => {
  try {
    const me = await authedUser(req.user.uid);
    if (!me) return res.status(404).json({ error: "User not found" });

    const sessionId = String(req.params.id || "");
    const session = await prisma.groupSwipeSession.findUnique({
      where: { id: sessionId },
      include: {
        events: { orderBy: { createdAt: "asc" } },
        aUser: true,
        bUser: true,
        startedBy: true,
      },
    });
    if (!session) return res.status(404).json({ error: "Session not found" });

    // Completed? Just return counters and no next.
    const allEvents = session.events || [];
    const youCount = allEvents.filter((e) => e.userId === me.id).length;
    const partnerCount = allEvents.length - youCount;

    if (session.status !== "active") {
      return res.json({
        status: session.status,
        youCount,
        partnerCount,
        limit: MAX_SWIPES,
        next: null,
      });
    }

    const { userA, userB } = userABFromSession(session);
    const aPrefs = prefsFromUser(userA);
    const bPrefs = prefsFromUser(userB);

    const locA = extractLoc(session.context, "locA");
    const locB = extractLoc(session.context, "locB");

    // Build (or reuse) the combined pool from DB only
    const pool = await getOrBuildSessionPool({
      sessionId,
      prisma,
      aUser: { id: userA?.id, name: userA?.displayName || userA?.username || null, prefs: aPrefs, tag: "A" },
      bUser: { id: userB?.id, name: userB?.displayName || userB?.username || null, prefs: bPrefs, tag: "B" },
      locA,
      locB,
      want: 12,
      log: console.log,
    });

    // Your personal index through the common pool is your count.
    const idx = youCount;
    const nextItem = idx < pool.items.length ? pool.items[idx] : null;

    if (nextItem) {
      console.log("[group] nextCard", {
        sessionId,
        userId: me.id,
        countForUser: youCount,
        idx,
        restaurant: { id: nextItem.id, name: nextItem.name },
        from: nextItem.from || null, // "A" | "B"
      });
    } else {
      console.log("[group] state(no-next)", {
        sessionId,
        youCount,
        partnerCount,
        limit: MAX_SWIPES,
        poolSize: pool.items.length,
      });
    }

    res.set("Cache-Control", "no-store");
    return res.json({
      status: session.status,
      youCount,
      partnerCount,
      limit: MAX_SWIPES,
      next: nextItem
        ? {
            id: nextItem.id,
            name: nextItem.name,
            from: nextItem.from || null, // surface source to the client if you want
          }
        : null,
    });
  } catch (err) {
    console.error("[group/session/state] error:", err);
    res.status(500).json({ error: "state failed" });
  }
});

// Record feedback with idempotency (prevents rapid dupes)
router.post("/session/:id/feedback", async (req, res) => {
  try {
    const me = await authedUser(req.user.uid);
    if (!me) return res.status(404).json({ error: "User not found" });

    const sessionId = String(req.params.id || "");
    let { restaurantId, action, position } = req.body || {};
    action = String(action || "").toUpperCase();
    if (!restaurantId || !["LIKE", "PASS", "SUPERSTAR"].includes(action)) {
      return res.status(400).json({ error: "restaurantId and valid action required" });
    }

    const s = await prisma.groupSwipeSession.findUnique({
      where: { id: sessionId },
      include: { events: { orderBy: { createdAt: "asc" } } },
    });
    if (!s) return res.status(404).json({ error: "Session not found" });
    if (s.status !== "active") return res.status(410).json({ ok: false, sessionCompleted: true });

    // Idempotency (same user, same restaurant, same action as last -> no-op)
    const last = [...(s.events || [])].reverse().find((e) => e.userId === me.id);
    if (last && last.restaurantId === restaurantId && last.action === action) {
      return res.json({
        ok: true,
        duplicate: true,
        shouldRerank: false,
        shouldSuggestMatch: false,
        sessionCompleted: false,
      });
    }

    const nextPos = (s.events?.length || 0) + 1;
    let sessionCompleted = false;

    await prisma.$transaction(async (tx) => {
      await tx.groupSwipeEvent.create({
        data: { sessionId, userId: me.id, restaurantId, action, position: position || nextPos },
      });
      const updated = await tx.groupSwipeSession.update({
        where: { id: sessionId },
        data: { totalSwipes: { increment: 1 } },
        select: { totalSwipes: true },
      });

      const reached = (updated.totalSwipes ?? nextPos) >= MAX_SWIPES;
      const endNow = reached || (END_ON_SUPERSTAR && action === "SUPERSTAR");
      if (endNow) {
        await tx.groupSwipeSession.update({
          where: { id: sessionId },
          data: { status: "completed", endedAt: new Date() },
        });
        sessionCompleted = true;
        clearPool(sessionId); // optional: free cache on completion
      }
    });

    // Suggest re-rank every N (client may ignore)
    const nextCountForMe =
      (s.events?.filter((e) => e.userId === me.id).length || 0) + 1;
    const shouldRerank = nextCountForMe % 5 === 0;
    const shouldSuggestMatch = sessionCompleted || nextCountForMe >= MAX_SWIPES;

    return res.json({ ok: true, shouldRerank, shouldSuggestMatch, sessionCompleted });
  } catch (err) {
    console.error("[group/feedback] error:", err);
    res.status(500).json({ error: "feedback failed" });
  }
});

module.exports = router;
