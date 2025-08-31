"use strict";

const express = require("express");
const prisma = require("../src/prisma");
const verifyFirebaseToken = require("../middleware/auth");

const { maybeFinalizeSession, nextCardForUser, SWIPE_LIMIT, getSessionCounts } = require("../src/group/service");
const { getOrBuildSessionPool } = require("../src/group/pool");
const { labelOfUser, usernameOfUser } = require("../src/group/utils");

const router = express.Router();
router.use(verifyFirebaseToken);

const log = (tag, obj) => {
  try { console.log(`[group] ${tag}`, JSON.stringify(obj, null, 2)); }
  catch { console.log(`[group] ${tag}`, obj); }
};

// ─────────────────────────── Sessions list ───────────────────────────
router.get("/sessions", async (req, res) => {
  try {
    const me = await prisma.user.findUnique({ where: { firebaseUid: req.user.uid } });
    if (!me) return res.status(404).json({ error: "User not found" });

    const rows = await prisma.groupSwipeSession.findMany({
      where: { status: "active", OR: [{ aUserId: me.id }, { bUserId: me.id }] },
      orderBy: { startedAt: "desc" },
      select: {
        id: true, aUserId: true, bUserId: true,
        aUser: { select: { id: true, displayName: true, username: true, email: true } },
        bUser: { select: { id: true, displayName: true, username: true, email: true } },
      },
    });

    const sessions = [];
    for (const s of rows) {
      await maybeFinalizeSession(s.id);
      const sNow = await prisma.groupSwipeSession.findUnique({ where: { id: s.id }, select: { status: true } });
      if (sNow?.status !== "active") continue;

      const partner = s.aUserId === me.id ? s.bUser : s.aUser;
      const counts = await getSessionCounts(s.id);
      const you = s.aUserId === me.id ? (counts.get(s.aUserId) || 0) : (counts.get(s.bUserId) || 0);
      const them = s.aUserId === me.id ? (counts.get(s.bUserId) || 0) : (counts.get(s.aUserId) || 0);

      sessions.push({
        id: s.id,
        partner: { id: partner.id, name: labelOfUser(partner), username: usernameOfUser(partner) },
        youCount: you,
        partnerCount: them,
        limit: SWIPE_LIMIT,
      });
    }

    res.json({ sessions });
  } catch (e) {
    console.error("[group/sessions] error:", e);
    res.status(500).json({ error: "failed to load sessions" });
  }
});

// Store user location: locA/locB
router.post("/session/:id/start", async (req, res) => {
  try {
    const me = await prisma.user.findUnique({ where: { firebaseUid: req.user.uid } });
    if (!me) return res.status(404).json({ error: "User not found" });
    const s = await prisma.groupSwipeSession.findUnique({ where: { id: req.params.id }, select: { id: true, aUserId: true, bUserId: true, context: true } });
    if (!s) return res.status(404).json({ error: "Session not found" });
    if (s.aUserId !== me.id && s.bUserId !== me.id) return res.status(403).json({ error: "Not in this session" });

    const { lat, lng } = req.body || {};
    if (typeof lat !== "number" || typeof lng !== "number") return res.json({ ok: true });

    const key = (s.aUserId === me.id) ? "locA" : "locB";
    const ctx = s.context || {};
    await prisma.groupSwipeSession.update({ where: { id: s.id }, data: { context: { ...ctx, [key]: { lat, lng } } } });
    log("start(set-loc)", { sessionId: s.id, userId: me.id, key, lat, lng });
    res.json({ ok: true });
  } catch (e) {
    console.error("[group/session/start] error:", e);
    res.status(500).json({ error: "failed to start session" });
  }
});

// State + next card
router.get("/session/:id/state", async (req, res) => {
  try {
    const me = await prisma.user.findUnique({ where: { firebaseUid: req.user.uid } });
    if (!me) return res.status(404).json({ error: "User not found" });

    const s = await prisma.groupSwipeSession.findUnique({
      where: { id: req.params.id },
      select: { id: true, status: true, aUserId: true, bUserId: true, context: true },
    });
    if (!s) return res.status(404).json({ error: "Session not found" });
    if (s.aUserId !== me.id && s.bUserId !== me.id) return res.status(403).json({ error: "Not in this session" });

    await maybeFinalizeSession(s.id);
    const fresh = await prisma.groupSwipeSession.findUnique({
      where: { id: s.id },
      select: { id: true, status: true, aUserId: true, bUserId: true, context: true },
    });
    if (!fresh) return res.status(404).json({ error: "Session not found" });

    const payload = await nextCardForUser({ meId: me.id, session: fresh });
    if (payload.next) {
      const { id, name } = payload.next;
      const counts = await getSessionCounts(fresh.id);
      const youCount = (fresh.aUserId === me.id) ? (counts.get(fresh.aUserId) || 0) : (counts.get(fresh.bUserId) || 0);
      const idx = youCount;
      log("nextCard", {
        sessionId: fresh.id,
        userId: me.id,
        countForUser: youCount,
        idx,
        restaurant: { id, name },
        from: payload.next.from || null,
      });
    } else {
      const counts = await getSessionCounts(fresh.id);
      const you = (fresh.aUserId === me.id) ? (counts.get(fresh.aUserId) || 0) : (counts.get(fresh.bUserId) || 0);
      const { poolIds } = await getOrBuildSessionPool({ session: fresh, wantEach: 10 });
      log("state(no-next)", {
        sessionId: fresh.id, youCount: you, limit: SWIPE_LIMIT, poolSize: poolIds.length,
        hasLocA: Boolean(fresh.context?.locA), hasLocB: Boolean(fresh.context?.locB),
      });
    }

    res.set("Cache-Control", "no-store");
    res.json({ status: fresh.status, ...payload });
  } catch (e) {
    console.error("[group/session/state] error:", e);
    res.status(500).json({ error: "failed to load state" });
  }
});

// Idempotent feedback
router.post("/session/:id/feedback", async (req, res) => {
  try {
    const me = await prisma.user.findUnique({ where: { firebaseUid: req.user.uid } });
    if (!me) return res.status(404).json({ error: "User not found" });

    const { restaurantId } = req.body || {};
    let action = String(req.body?.action || "").toUpperCase();
    if (!restaurantId || !["LIKE", "PASS", "SUPERSTAR"].includes(action)) {
      return res.status(400).json({ error: "restaurantId and valid action required" });
    }

    const s = await prisma.groupSwipeSession.findUnique({
      where: { id: req.params.id },
      select: { id: true, status: true, aUserId: true, bUserId: true },
    });
    if (!s) return res.status(404).json({ error: "Session not found" });
    if (s.status !== "active") return res.status(400).json({ error: "Session not active" });
    if (s.aUserId !== me.id && s.bUserId !== me.id) return res.status(403).json({ error: "Not in this session" });

    const last = await prisma.groupSwipeEvent.findFirst({
      where: { sessionId: s.id, userId: me.id },
      orderBy: { createdAt: "desc" },
    });

    // True duplicate: exact same restaurant + action as last — ignore.
    if (last && last.restaurantId === restaurantId && last.action === action) {
      return res.json({ ok: true, duplicate: true });
    }

    // Same restaurant, different action: update last instead of creating new.
    if (last && last.restaurantId === restaurantId && last.action !== action) {
      await prisma.groupSwipeEvent.update({
        where: { id: last.id },
        data: { action },
      });
      log("feedback(update-last)", {
        sessionId: s.id, userId: me.id, restaurantId, fromAction: last.action, toAction: action,
      });
      await maybeFinalizeSession(s.id);
      return res.json({ ok: true, updated: true });
    }

    const countForUser = await prisma.groupSwipeEvent.count({ where: { sessionId: s.id, userId: me.id } });
    await prisma.groupSwipeEvent.create({
      data: { sessionId: s.id, userId: me.id, restaurantId, action, position: countForUser + 1 },
    });

    log("feedback", { sessionId: s.id, userId: me.id, restaurantId, action, position: countForUser + 1 });
    await maybeFinalizeSession(s.id);
    res.json({ ok: true });
  } catch (e) {
    console.error("[group/session/feedback] error:", e);
    res.status(500).json({ error: "failed to record feedback" });
  }
});

module.exports = router;
