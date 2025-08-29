// routes/friends.js
const express = require("express");
const prisma = require("../src/prisma");
const verifyFirebaseToken = require("../middleware/auth");

const router = express.Router();

// Apply auth to everything here
router.use(verifyFirebaseToken);

/** Helpers */
async function getAuthedUserOr404(firebaseUid, res) {
  const user = await prisma.user.findUnique({ where: { firebaseUid } });
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return null;
  }
  return user;
}

function labelOfUser(u) {
  const dn = u?.displayName?.trim();
  if (dn) return dn;
  const un = u?.username?.trim();
  if (un) return un;
  const email = u?.email || "";
  if (email.includes("@")) return email.split("@")[0];
  return "Friend";
}

function usernameOfUser(u) {
  return u?.username || null;
}

/**
 * Case-insensitive search by @username or email.
 * - "@foo"  -> username "foo" (insensitive)
 * - "foo"   -> username "foo" (insensitive)
 * - "a@b.c" -> email (insensitive)
 */
async function findTargetUserByQuery(query) {
  const q = String(query || "").trim();
  if (!q) return null;

  // email
  if (q.includes("@")) {
    return prisma.user.findFirst({
      where: { email: { equals: q.toLowerCase(), mode: "insensitive" } },
      select: { id: true, displayName: true, email: true, username: true },
    });
  }

  // username (with or without leading "@")
  const un = q.startsWith("@") ? q.slice(1) : q;
  const norm = un.trim();
  if (!norm) return null;

  return prisma.user.findFirst({
    where: { username: { equals: norm, mode: "insensitive" } },
    select: { id: true, displayName: true, email: true, username: true },
  });
}

/** GET /api/friends/incoming → { requests: { id, fromUserId, fromName, fromUsername }[] } */
router.get("/incoming", async (req, res) => {
  try {
    const me = await getAuthedUserOr404(req.user.uid, res);
    if (!me) return;

    const rows = await prisma.friendRequest.findMany({
      where: { toUserId: me.id, status: "PENDING" },
      orderBy: { createdAt: "desc" },
      include: {
        fromUser: { select: { id: true, displayName: true, email: true, username: true } },
      },
    });

    const requests = rows.map((r) => ({
      id: r.id,
      fromUserId: r.fromUserId,
      fromName: labelOfUser(r.fromUser),
      fromUsername: usernameOfUser(r.fromUser),
    }));

    res.json({ requests });
  } catch (err) {
    console.error("[friends/incoming] error:", err);
    res.status(500).json({ error: "failed to load requests" });
  }
});

/** NEW: GET /api/friends/outgoing → { requests: { id, toUserId, toName, toUsername }[] } */
router.get("/outgoing", async (req, res) => {
  try {
    const me = await getAuthedUserOr404(req.user.uid, res);
    if (!me) return;

    const rows = await prisma.friendRequest.findMany({
      where: { fromUserId: me.id, status: "PENDING" },
      orderBy: { createdAt: "desc" },
      include: {
        toUser: { select: { id: true, displayName: true, email: true, username: true } },
      },
    });

    const requests = rows.map((r) => ({
      id: r.id,
      toUserId: r.toUserId,
      toName: labelOfUser(r.toUser),
      toUsername: usernameOfUser(r.toUser),
    }));

    res.json({ requests });
  } catch (err) {
    console.error("[friends/outgoing] error:", err);
    res.status(500).json({ error: "failed to load requests" });
  }
});

/** NEW: GET /api/friends/requests → { incoming: [...], outgoing: [...] } */
router.get("/requests", async (req, res) => {
  try {
    const me = await getAuthedUserOr404(req.user.uid, res);
    if (!me) return;

    const [incomingRows, outgoingRows] = await Promise.all([
      prisma.friendRequest.findMany({
        where: { toUserId: me.id, status: "PENDING" },
        orderBy: { createdAt: "desc" },
        include: {
          fromUser: { select: { id: true, displayName: true, email: true, username: true } },
        },
      }),
      prisma.friendRequest.findMany({
        where: { fromUserId: me.id, status: "PENDING" },
        orderBy: { createdAt: "desc" },
        include: {
          toUser: { select: { id: true, displayName: true, email: true, username: true } },
        },
      }),
    ]);

    const incoming = incomingRows.map((r) => ({
      id: r.id,
      fromUserId: r.fromUserId,
      fromName: labelOfUser(r.fromUser),
      fromUsername: usernameOfUser(r.fromUser),
    }));

    const outgoing = outgoingRows.map((r) => ({
      id: r.id,
      toUserId: r.toUserId,
      toName: labelOfUser(r.toUser),
      toUsername: usernameOfUser(r.toUser),
    }));

    res.json({ incoming, outgoing });
  } catch (err) {
    console.error("[friends/requests] error:", err);
    res.status(500).json({ error: "failed to load requests" });
  }
});

/** GET /api/friends/list → { friends: { id, name, username? }[] } */
router.get("/list", async (req, res) => {
  try {
    const me = await getAuthedUserOr404(req.user.uid, res);
    if (!me) return;

    const rows = await prisma.friend.findMany({
      where: { userId: me.id },
      orderBy: { createdAt: "desc" },
      include: {
        friend: { select: { id: true, displayName: true, email: true, username: true } },
      },
    });

    const friends = rows.map((row) => ({
      id: row.friend.id,
      name: labelOfUser(row.friend),
      username: usernameOfUser(row.friend),
    }));

    res.json({ friends });
  } catch (err) {
    console.error("[friends/list] error:", err);
    res.status(500).json({ error: "failed to load friends" });
  }
});

/** POST /api/friends/request { query } */
router.post("/request", async (req, res) => {
  try {
    const me = await getAuthedUserOr404(req.user.uid, res);
    if (!me) return;

    const query = req.body?.query;
    if (!query || !String(query).trim()) {
      return res.status(400).json({ error: "query required" });
    }

    const target = await findTargetUserByQuery(query);
    if (!target) return res.status(404).json({ error: "User not found" });
    if (target.id === me.id) return res.status(400).json({ error: "Cannot add yourself" });

    // Already friends?
    const existingFriend = await prisma.friend.findFirst({
      where: { userId: me.id, friendId: target.id },
      select: { id: true },
    });
    if (existingFriend) return res.status(200).json({ ok: true, alreadyFriends: true });

    // Pending either direction?
    const pending = await prisma.friendRequest.findFirst({
      where: {
        status: "PENDING",
        OR: [
          { fromUserId: me.id, toUserId: target.id },
          { fromUserId: target.id, toUserId: me.id },
        ],
      },
      select: { id: true },
    });
    if (pending) return res.status(200).json({ ok: true, pendingRequestId: pending.id });

    // Create (or revive) request for this direction
    let fr;
    try {
      fr = await prisma.friendRequest.create({
        data: { fromUserId: me.id, toUserId: target.id, status: "PENDING" },
        select: { id: true },
      });
    } catch (e) {
      // If unique constraint hit (pair exists but not pending), flip it back to pending
      const existing = await prisma.friendRequest.findUnique({
        where: { fromUserId_toUserId: { fromUserId: me.id, toUserId: target.id } },
        select: { id: true, status: true },
      });
      if (existing) {
        fr = await prisma.friendRequest.update({
          where: { id: existing.id },
          data: { status: "PENDING" },
          select: { id: true },
        });
      } else {
        throw e;
      }
    }

    res.json({ ok: true, requestId: fr.id });
  } catch (err) {
    console.error("[friends/request] error:", err);
    res.status(500).json({ error: "failed to send request" });
  }
});

/** POST /api/friends/accept { requestId } */
router.post("/accept", async (req, res) => {
  try {
    const me = await getAuthedUserOr404(req.user.uid, res);
    if (!me) return;

    const requestId = req.body?.requestId;
    if (!requestId) return res.status(400).json({ error: "requestId required" });

    const fr = await prisma.friendRequest.findUnique({
      where: { id: requestId },
      select: { id: true, fromUserId: true, toUserId: true, status: true },
    });
    if (!fr) return res.status(404).json({ error: "Request not found" });
    if (fr.toUserId !== me.id) return res.status(403).json({ error: "Not your request" });
    if (fr.status !== "PENDING") return res.status(400).json({ error: "Request is not pending" });

    await prisma.$transaction(async (tx) => {
      // Friendship both directions (idempotent via upsert + unique)
      await tx.friend.upsert({
        where: { userId_friendId: { userId: me.id, friendId: fr.fromUserId } },
        update: {},
        create: { userId: me.id, friendId: fr.fromUserId },
      });
      await tx.friend.upsert({
        where: { userId_friendId: { userId: fr.fromUserId, friendId: me.id } },
        update: {},
        create: { userId: fr.fromUserId, friendId: me.id },
      });

      await tx.friendRequest.update({
        where: { id: fr.id },
        data: { status: "ACCEPTED" },
      });

      // Close any opposite PENDING between same pair
      await tx.friendRequest.updateMany({
        where: {
          status: "PENDING",
          OR: [
            { fromUserId: me.id, toUserId: fr.fromUserId },
            { fromUserId: fr.fromUserId, toUserId: me.id },
          ],
        },
        data: { status: "ACCEPTED" },
      });
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("[friends/accept] error:", err);
    res.status(500).json({ error: "failed to accept" });
  }
});

/** POST /api/friends/decline { requestId } */
router.post("/decline", async (req, res) => {
  try {
    const me = await getAuthedUserOr404(req.user.uid, res);
    if (!me) return;

    const requestId = req.body?.requestId;
    if (!requestId) return res.status(400).json({ error: "requestId required" });

    const fr = await prisma.friendRequest.findUnique({
      where: { id: requestId },
      select: { id: true, fromUserId: true, toUserId: true, status: true },
    });
    if (!fr) return res.status(404).json({ error: "Request not found" });
    if (fr.toUserId !== me.id) return res.status(403).json({ error: "Not your request" });
    if (fr.status !== "PENDING") return res.status(400).json({ error: "Request is not pending" });

    await prisma.friendRequest.update({
      where: { id: fr.id },
      data: { status: "DECLINED" },
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("[friends/decline] error:", err);
    res.status(500).json({ error: "failed to decline" });
  }
});

module.exports = router;
