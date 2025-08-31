// routes/groupRequests.js
// Group "friend" requests (invite + accept/decline/cancel + list)

const express = require("express");
const prisma = require("../src/prisma");
const verifyFirebaseToken = require("../middleware/auth");

const router = express.Router();
router.use(verifyFirebaseToken);

const STATUS = {
  PENDING: "PENDING",
  ACCEPTED: "ACCEPTED",
  DECLINED: "DECLINED",
  CANCELED: "CANCELED",
};

async function authedUser(firebaseUid) {
  return prisma.user.findUnique({ where: { firebaseUid } });
}

function liteUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    displayName: u.displayName || null,
    username: u.username || null,
    photoUrl: u.photoUrl || null,
  };
}

/** any active session between the two users, regardless of order */
function activeSessionWhere(aId, bId) {
  return {
    status: "active",
    OR: [
      { AND: [{ aUserId: aId }, { bUserId: bId }] },
      { AND: [{ aUserId: bId }, { bUserId: aId }] },
      // if you sometimes only have startedById set early:
      { AND: [{ startedById: aId }, { OR: [{ aUserId: bId }, { bUserId: bId }] }] },
      { AND: [{ startedById: bId }, { OR: [{ aUserId: aId }, { bUserId: aId }] }] },
    ],
  };
}

/* ─────────────────────────────── List pending ─────────────────────────────── */

router.get("/requests", async (req, res) => {
  try {
    const me = await prisma.user.findUnique({
      where: { firebaseUid: req.user.uid },
      select: { id: true },
    });
    if (!me) return res.status(404).json({ error: "User not found" });

    const pending = await prisma.groupRequest.findMany({
      where: { status: STATUS.PENDING, OR: [{ toUserId: me.id }, { fromUserId: me.id }] },
      orderBy: { createdAt: "desc" },
      include: {
        fromUser: { select: { id: true, displayName: true, username: true } },
        toUser: { select: { id: true, displayName: true, username: true } },
      },
      take: 50,
    });

    const incoming = pending
      .filter((r) => r.toUserId === me.id)
      .map((r) => ({
        id: r.id,
        fromUserId: r.fromUserId,
        fromName: r.fromUser.displayName || r.fromUser.username || "Friend",
        fromUsername: r.fromUser.username || null,
      }));

    const outgoing = pending
      .filter((r) => r.fromUserId === me.id)
      .map((r) => ({
        id: r.id,
        toUserId: r.toUserId,
        toName: r.toUser.displayName || r.toUser.username || "Friend",
        toUsername: r.toUser.username || null,
      }));

    res.json({ incoming, outgoing });
  } catch (err) {
    console.error("[group/requests] error:", err);
    res.status(500).json({ error: "failed" });
  }
});

/* ─────────────────────────────── Create/Upsert ────────────────────────────── */
/** POST /api/group/request  body: { friendId } */
router.post("/request", async (req, res) => {
  try {
    const me = await prisma.user.findUnique({
      where: { firebaseUid: req.user.uid },
      select: { id: true },
    });
    if (!me) return res.status(404).json({ error: "User not found" });

    const friendId = String(req.body?.friendId || "");
    if (!friendId) return res.status(400).json({ error: "friendId required" });
    if (friendId === me.id) return res.status(400).json({ error: "cannot request self" });

    // 1) block if an active session already exists between us
    const active = await prisma.groupSwipeSession.findFirst({
      where: activeSessionWhere(me.id, friendId),
      select: { id: true },
    });
    if (active) {
      return res.status(409).json({ error: "already active session", code: "already_active" });
    }

    // 2) block if a pending request exists in either direction
    const pending = await prisma.groupRequest.findFirst({
      where: {
        status: STATUS.PENDING,
        OR: [
          { fromUserId: me.id, toUserId: friendId },
          { fromUserId: friendId, toUserId: me.id },
        ],
      },
      select: { id: true },
    });
    if (pending) {
      return res.status(409).json({ error: "already pending", code: "already_pending" });
    }

    // 3) otherwise *re-use* the A→B record via upsert (satisfy @@unique([fromUserId,toUserId]))
    const row = await prisma.groupRequest.upsert({
      where: { fromUserId_toUserId: { fromUserId: me.id, toUserId: friendId } },
      update: { status: STATUS.PENDING, updatedAt: new Date() },
      create: { fromUserId: me.id, toUserId: friendId, status: STATUS.PENDING },
      select: { id: true },
    });

    return res.json({ ok: true, requestId: row.id });
  } catch (err) {
    console.error("[group/request] error:", err);
    // Fallback message; upsert should avoid P2002 anyway
    return res.status(500).json({ error: "failed" });
  }
});

/* ─────────────────────────────── Accept ───────────────────────────────────── */
/** POST /api/group/accept  body: { requestId } */
router.post("/accept", async (req, res) => {
  try {
    const me = await prisma.user.findUnique({
      where: { firebaseUid: req.user.uid },
      select: { id: true },
    });
    if (!me) return res.status(404).json({ error: "User not found" });

    const requestId = String(req.body?.requestId || "");
    const r = await prisma.groupRequest.findUnique({ where: { id: requestId } });
    if (!r) return res.status(404).json({ error: "not found" });
    if (r.toUserId !== me.id) return res.status(403).json({ error: "not your inbox item" });

    if (r.status !== STATUS.PENDING) {
      return res.status(409).json({ error: "not pending" });
    }

    // guard: if somehow an active session already exists, don’t create another
    const already = await prisma.groupSwipeSession.findFirst({
      where: activeSessionWhere(r.fromUserId, r.toUserId),
      select: { id: true },
    });
    if (already) {
      // still mark request accepted for cleanliness
      await prisma.groupRequest.update({ where: { id: r.id }, data: { status: STATUS.ACCEPTED } });
      return res.status(409).json({ error: "already active", code: "already_active" });
    }

    await prisma.$transaction(async (tx) => {
      await tx.groupRequest.update({ where: { id: requestId }, data: { status: STATUS.ACCEPTED } });
      await tx.groupSwipeSession.create({
        data: {
          status: "active",
          startedById: r.fromUserId,
          aUserId: r.fromUserId,
          bUserId: r.toUserId,
          context: {}, // /session/:id/start will fill coords
        },
      });
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("[group/accept] error:", err);
    res.status(500).json({ error: "failed" });
  }
});

/* ─────────────────────────────── Cancel ───────────────────────────────────── */
/** POST /api/group/cancel  body: { requestId } */
router.post("/cancel", async (req, res) => {
  try {
    const me = await prisma.user.findUnique({
      where: { firebaseUid: req.user.uid },
      select: { id: true },
    });
    if (!me) return res.status(404).json({ error: "User not found" });

    const requestId = String(req.body?.requestId || "");
    const r = await prisma.groupRequest.findUnique({ where: { id: requestId } });
    if (!r) return res.status(404).json({ error: "not found" });
    if (r.fromUserId !== me.id) return res.status(403).json({ error: "not your outbox item" });
    if (r.status !== STATUS.PENDING) return res.status(409).json({ error: "not pending" });

    await prisma.groupRequest.update({ where: { id: requestId }, data: { status: STATUS.CANCELED } });
    res.json({ ok: true });
  } catch (err) {
    console.error("[group/cancel] error:", err);
    res.status(500).json({ error: "failed" });
  }
});

module.exports = router;
