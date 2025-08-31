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

// GET /api/group/requests?box=inbox|outbox|all  (default: inbox)
router.get("/requests", async (req, res) => {
  try {
    const me = await authedUser(req.user.uid);
    if (!me) return res.status(404).json({ error: "User not found" });

    const box = String(req.query.box || "inbox").toLowerCase();
    const where =
      box === "outbox"
        ? { fromUserId: me.id }
        : box === "all"
          ? { OR: [{ fromUserId: me.id }, { toUserId: me.id }] }
          : { toUserId: me.id };

    const rows = await prisma.groupRequest.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        fromUser: { select: { id: true, displayName: true, username: true, photoUrl: true } },
        toUser:   { select: { id: true, displayName: true, username: true, photoUrl: true } },
      },
      take: 50,
    });

    res.json({
      requests: rows.map(r => ({
        id: r.id,
        status: r.status,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        from: liteUser(r.fromUser),
        to: liteUser(r.toUser),
      })),
    });
  } catch (err) {
    console.error("[groupRequests/list] error:", err);
    res.status(500).json({ error: "failed" });
  }
});

// POST /api/group/requests  { toUserId }
router.post("/requests", async (req, res) => {
  try {
    const me = await authedUser(req.user.uid);
    if (!me) return res.status(404).json({ error: "User not found" });

    const toUserId = String(req.body?.toUserId || "");
    if (!toUserId) return res.status(400).json({ error: "toUserId required" });
    if (toUserId === me.id) return res.status(400).json({ error: "cannot invite yourself" });

    // Upsert-ish: if a pending exists either direction, reuse it
    const existing = await prisma.groupRequest.findFirst({
      where: {
        OR: [
          { fromUserId: me.id, toUserId },
          { fromUserId: toUserId, toUserId: me.id },
        ],
        status: STATUS.PENDING,
      },
    });

    const reqRow =
      existing ||
      (await prisma.groupRequest.create({
        data: { fromUserId: me.id, toUserId, status: STATUS.PENDING },
      }));

    res.json({ ok: true, requestId: reqRow.id, status: reqRow.status });
  } catch (err) {
    // handle unique constraint politely
    if (err?.code === "P2002") {
      return res.status(409).json({ error: "request already exists" });
    }
    console.error("[groupRequests/create] error:", err);
    res.status(500).json({ error: "failed" });
  }
});

// POST /api/group/requests/:id/accept
router.post("/requests/:id/accept", async (req, res) => {
  try {
    const me = await authedUser(req.user.uid);
    if (!me) return res.status(404).json({ error: "User not found" });

    const id = String(req.params.id || "");
    const r = await prisma.groupRequest.findUnique({ where: { id } });
    if (!r) return res.status(404).json({ error: "not found" });
    if (r.toUserId !== me.id) return res.status(403).json({ error: "not your inbox item" });
    if (r.status !== STATUS.PENDING) return res.status(409).json({ error: "not pending" });

    await prisma.$transaction(async (tx) => {
      // mark accepted
      await tx.groupRequest.update({ where: { id }, data: { status: STATUS.ACCEPTED } });
      // ensure 2-way Friend rows
      await tx.friend.upsert({
        where: { userId_friendId: { userId: r.fromUserId, friendId: r.toUserId } },
        create: { userId: r.fromUserId, friendId: r.toUserId },
        update: {},
      });
      await tx.friend.upsert({
        where: { userId_friendId: { userId: r.toUserId, friendId: r.fromUserId } },
        create: { userId: r.toUserId, friendId: r.fromUserId },
        update: {},
      });
      // optionally: close any opposite pending
      await tx.groupRequest.updateMany({
        where: {
          OR: [
            { fromUserId: r.toUserId, toUserId: r.fromUserId },
            { fromUserId: r.fromUserId, toUserId: r.toUserId },
          ],
          status: STATUS.PENDING,
          NOT: { id },
        },
        data: { status: STATUS.CANCELED },
      });
    });

    res.json({ ok: true, status: STATUS.ACCEPTED });
  } catch (err) {
    console.error("[groupRequests/accept] error:", err);
    res.status(500).json({ error: "failed" });
  }
});

// POST /api/group/requests/:id/decline
router.post("/requests/:id/decline", async (req, res) => {
  try {
    const me = await authedUser(req.user.uid);
    if (!me) return res.status(404).json({ error: "User not found" });

    const id = String(req.params.id || "");
    const r = await prisma.groupRequest.findUnique({ where: { id } });
    if (!r) return res.status(404).json({ error: "not found" });
    if (r.toUserId !== me.id) return res.status(403).json({ error: "not your inbox item" });
    if (r.status !== STATUS.PENDING) return res.status(409).json({ error: "not pending" });

    await prisma.groupRequest.update({ where: { id }, data: { status: STATUS.DECLINED } });
    res.json({ ok: true, status: STATUS.DECLINED });
  } catch (err) {
    console.error("[groupRequests/decline] error:", err);
    res.status(500).json({ error: "failed" });
  }
});

// POST /api/group/requests/:id/cancel  (sender can cancel)
router.post("/requests/:id/cancel", async (req, res) => {
  try {
    const me = await authedUser(req.user.uid);
    if (!me) return res.status(404).json({ error: "User not found" });

    const id = String(req.params.id || "");
    const r = await prisma.groupRequest.findUnique({ where: { id } });
    if (!r) return res.status(404).json({ error: "not found" });
    if (r.fromUserId !== me.id) return res.status(403).json({ error: "not your outbox item" });
    if (r.status !== STATUS.PENDING) return res.status(409).json({ error: "not pending" });

    await prisma.groupRequest.update({ where: { id }, data: { status: STATUS.CANCELED } });
    res.json({ ok: true, status: STATUS.CANCELED });
  } catch (err) {
    console.error("[groupRequests/cancel] error:", err);
    res.status(500).json({ error: "failed" });
  }
});

module.exports = router;
