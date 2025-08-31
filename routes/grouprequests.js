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

// 

router.get("/requests", async (req, res) => {
  try {
    const me = await prisma.user.findUnique({
      where: { firebaseUid: req.user.uid },
      select: { id: true },
    });
    if (!me) return res.status(404).json({ error: "User not found" });

    const pending = await prisma.groupRequest.findMany({
      where: { status: "PENDING", OR: [{ toUserId: me.id }, { fromUserId: me.id }] },
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


// POST /api/group/request
router.post("/request", async (req, res) => {
  try {
    const me = await prisma.user.findUnique({ where: { firebaseUid: req.user.uid }, select: { id: true } });
    if (!me) return res.status(404).json({ error: "User not found" });
    const friendId = String(req.body?.friendId || "");
    if (!friendId) return res.status(400).json({ error: "friendId required" });
    const r = await prisma.groupRequest.create({
      data: { fromUserId: me.id, toUserId: friendId, status: "PENDING" },
    });
    res.json({ ok: true, requestId: r.id });
  } catch (err) {
    if (err?.code === "P2002") return res.status(409).json({ error: "already requested" });
    console.error("[group/request] error:", err);
    res.status(500).json({ error: "failed" });
  }
});

// POST /api/group/accept
router.post("/accept", async (req, res) => {
  try {
    const me = await prisma.user.findUnique({ where: { firebaseUid: req.user.uid }, select: { id: true } });
    if (!me) return res.status(404).json({ error: "User not found" });
    const requestId = String(req.body?.requestId || "");
    const r = await prisma.groupRequest.findUnique({ where: { id: requestId } });
    if (!r) return res.status(404).json({ error: "not found" });
    if (r.toUserId !== me.id) return res.status(403).json({ error: "not your inbox item" });
    if (r.status !== "PENDING") return res.status(409).json({ error: "not pending" });

    await prisma.$transaction(async (tx) => {
      await tx.groupRequest.update({ where: { id: requestId }, data: { status: "ACCEPTED" } });
      // create an active session between inviter(invite from) and me
      await tx.groupSwipeSession.create({
        data: {
          status: "active",
          startedById: r.fromUserId,
          aUserId: r.fromUserId,
          bUserId: r.toUserId,
          context: {}, // locations will be filled by /session/:id/start
        },
      });
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("[group/accept] error:", err);
    res.status(500).json({ error: "failed" });
  }
});

// POST /api/group/cancel
router.post("/cancel", async (req, res) => {
  try {
    const me = await prisma.user.findUnique({ where: { firebaseUid: req.user.uid }, select: { id: true } });
    if (!me) return res.status(404).json({ error: "User not found" });
    const requestId = String(req.body?.requestId || "");
    const r = await prisma.groupRequest.findUnique({ where: { id: requestId } });
    if (!r) return res.status(404).json({ error: "not found" });
    if (r.fromUserId !== me.id) return res.status(403).json({ error: "not your outbox item" });
    if (r.status !== "PENDING") return res.status(409).json({ error: "not pending" });
    await prisma.groupRequest.update({ where: { id: requestId }, data: { status: "CANCELED" } });
    res.json({ ok: true });
  } catch (err) {
    console.error("[group/cancel] error:", err);
    res.status(500).json({ error: "failed" });
  }
});


module.exports = router;
