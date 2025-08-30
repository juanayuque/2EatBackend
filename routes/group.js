// routes/group.js
const express = require("express");
const prisma = require("../src/prisma");
const verifyFirebaseToken = require("../middleware/auth");

const router = express.Router();
router.use(verifyFirebaseToken);

// ─────────────────────────── Config ───────────────────────────
const SWIPE_LIMIT = 15; // 15 swipes per user to finish

// ─────────────────────────── Helpers ───────────────────────────
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

// Ensure the two users are friends (at least one direction row exists).
async function assertAreFriendsOr400(meId, otherUserId, res) {
  const friend = await prisma.friend.findFirst({
    where: { userId: meId, friendId: otherUserId },
    select: { id: true },
  });
  const reverse = await prisma.friend.findFirst({
    where: { userId: otherUserId, friendId: meId },
    select: { id: true },
  });
  if (!friend && !reverse) {
    res.status(400).json({ error: "You can only group-match with friends" });
    return false;
  }
  return true;
}

// Progress counters for a session
async function getSessionCounts(sessionId, aUserId, bUserId) {
  const rows = await prisma.groupSwipeEvent.groupBy({
    by: ["userId"],
    where: { sessionId },
    _count: { _all: true },
  });
  const byUser = new Map(rows.map((r) => [r.userId, r._count._all]));
  const a = byUser.get(aUserId) || 0;
  const b = byUser.get(bUserId) || 0;
  return { aCount: a, bCount: b, limit: SWIPE_LIMIT };
}

// Build a top3 + winner from the session’s events
async function rankTop3(sessionId) {
  // Score: LIKE = 1, SUPERSTAR = 3, PASS = 0. Bonus if both users liked.
  const events = await prisma.groupSwipeEvent.findMany({
    where: { sessionId },
    select: { restaurantId: true, userId: true, action: true, createdAt: true },
  });

  if (events.length === 0) return { top: [], winner: null };

  const score = new Map(); // rid -> { s, likedBy:Set, last:Date }
  for (const e of events) {
    let entry = score.get(e.restaurantId);
    if (!entry) entry = { s: 0, likedBy: new Set(), last: e.createdAt };
    if (e.action === "LIKE") entry.s += 1;
    if (e.action === "SUPERSTAR") entry.s += 3;
    if (e.action === "LIKE" || e.action === "SUPERSTAR") entry.likedBy.add(e.userId);
    if (e.createdAt > entry.last) entry.last = e.createdAt;
    score.set(e.restaurantId, entry);
  }

  // If nobody liked anything, fallback to “most recent exposures”
  let items = Array.from(score.entries()).map(([rid, v]) => ({
    restaurantId: rid,
    s: v.s + (v.likedBy.size >= 2 ? 2 : 0), // tiny boost if both liked
    likedByCount: v.likedBy.size,
    last: v.last,
  }));

  const allZero = items.every((i) => i.s === 0);
  items.sort((a, b) => {
    if (b.s !== a.s) return b.s - a.s;
    if (b.likedByCount !== a.likedByCount) return b.likedByCount - a.likedByCount;
    return b.last - a.last;
  });

  if (allZero) {
    // use recency only
    items.sort((a, b) => b.last - a.last);
  }

  const top = items.slice(0, 3).map((i) => i.restaurantId);
  const winner = top[0] || null;
  return { top, winner };
}

// Finalize a session if both users finished; idempotent
async function maybeFinalizeSession(sessionId) {
  const s = await prisma.groupSwipeSession.findUnique({
    where: { id: sessionId },
    select: { id: true, status: true, aUserId: true, bUserId: true },
  });
  if (!s) return { finalized: false };
  if (s.status !== "active") return { finalized: false };

  const { aCount, bCount } = await getSessionCounts(s.id, s.aUserId, s.bUserId);
  if (aCount < SWIPE_LIMIT || bCount < SWIPE_LIMIT) return { finalized: false };

  // already have a match?
  const existing = await prisma.groupMatch.findUnique({ where: { sessionId: s.id } });
  if (existing) {
    await prisma.groupSwipeSession.update({
      where: { id: s.id },
      data: { status: "completed", endedAt: new Date() },
    });
    return { finalized: true, matchId: existing.id };
  }

  const { top, winner } = await rankTop3(s.id);
  // We require at least 1 candidate to finalize; if not, just mark completed
  const [top1, top2, top3] = [top[0] || null, top[1] || null, top[2] || null];
  await prisma.$transaction(async (tx) => {
    await tx.groupSwipeSession.update({
      where: { id: s.id },
      data: { status: "completed", endedAt: new Date() },
    });
    await tx.groupMatch.create({
      data: {
        sessionId: s.id,
        hostUserId: s.aUserId,     // semantic: creator vs friend is flexible here
        friendUserId: s.bUserId,
        top1RestaurantId: top1 || "",
        top2RestaurantId: top2 || null,
        top3RestaurantId: top3 || null,
        superStarRestaurantId: null,
        winnerRestaurantId: winner || (top1 || ""),
      },
    });
  });

  return { finalized: true };
}

// ─────────────────────────── Requests ───────────────────────────

/** GET /api/group/requests → { incoming: [...], outgoing: [...] } */
router.get("/requests", async (req, res) => {
  try {
    const me = await getAuthedUserOr404(req.user.uid, res);
    if (!me) return;

    const [incomingRows, outgoingRows] = await Promise.all([
      prisma.groupRequest.findMany({
        where: { toUserId: me.id, status: "PENDING" },
        orderBy: { createdAt: "desc" },
        include: { fromUser: { select: { id: true, displayName: true, email: true, username: true } } },
      }),
      prisma.groupRequest.findMany({
        where: { fromUserId: me.id, status: "PENDING" },
        orderBy: { createdAt: "desc" },
        include: { toUser: { select: { id: true, displayName: true, email: true, username: true } } },
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
    console.error("[group/requests] error:", err);
    res.status(500).json({ error: "failed to load group requests" });
  }
});

/** POST /api/group/request { friendId } */
router.post("/request", async (req, res) => {
  try {
    const me = await getAuthedUserOr404(req.user.uid, res);
    if (!me) return;

    const friendId = req.body?.friendId;
    if (!friendId) return res.status(400).json({ error: "friendId required" });
    if (friendId === me.id) return res.status(400).json({ error: "Cannot group-match yourself" });

    const ok = await assertAreFriendsOr400(me.id, friendId, res);
    if (!ok) return;

    const pending = await prisma.groupRequest.findFirst({
      where: {
        status: "PENDING",
        OR: [
          { fromUserId: me.id, toUserId: friendId },
          { fromUserId: friendId, toUserId: me.id },
        ],
      },
      select: { id: true },
    });
    if (pending) return res.json({ ok: true, requestId: pending.id });

    let gr;
    try {
      gr = await prisma.groupRequest.create({
        data: { fromUserId: me.id, toUserId: friendId, status: "PENDING" },
        select: { id: true },
      });
    } catch (e) {
      const existing = await prisma.groupRequest.findUnique({
        where: { fromUserId_toUserId: { fromUserId: me.id, toUserId: friendId } },
        select: { id: true },
      });
      if (existing) {
        gr = await prisma.groupRequest.update({
          where: { id: existing.id },
          data: { status: "PENDING" },
          select: { id: true },
        });
      } else {
        throw e;
      }
    }

    res.json({ ok: true, requestId: gr.id });
  } catch (err) {
    console.error("[group/request] error:", err);
    res.status(500).json({ error: "failed to create group request" });
  }
});

/** POST /api/group/accept { requestId } → { ok } */
router.post("/accept", async (req, res) => {
  try {
    const me = await getAuthedUserOr404(req.user.uid, res);
    if (!me) return;

    const requestId = req.body?.requestId;
    if (!requestId) return res.status(400).json({ error: "requestId required" });

    const gr = await prisma.groupRequest.findUnique({
      where: { id: requestId },
      select: { id: true, fromUserId: true, toUserId: true, status: true },
    });
    if (!gr) return res.status(404).json({ error: "Request not found" });
    if (gr.toUserId !== me.id) return res.status(403).json({ error: "Not your request" });
    if (gr.status !== "PENDING") return res.status(400).json({ error: "Request is not pending" });

    // mark accepted + create an active session
    await prisma.$transaction(async (tx) => {
      await tx.groupRequest.update({ where: { id: gr.id }, data: { status: "ACCEPTED" } });
      await tx.groupRequest.updateMany({
        where: {
          status: "PENDING",
          OR: [
            { fromUserId: me.id, toUserId: gr.fromUserId },
            { fromUserId: gr.fromUserId, toUserId: me.id },
          ],
        },
        data: { status: "ACCEPTED" },
      });
      await tx.groupSwipeSession.create({
        data: {
          status: "active",
          startedById: me.id,
          aUserId: gr.fromUserId,
          bUserId: gr.toUserId,
          context: {},
        },
      });
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("[group/accept] error:", err);
    res.status(500).json({ error: "failed to accept group request" });
  }
});

/** POST /api/group/decline { requestId } */
router.post("/decline", async (req, res) => {
  try {
    const me = await getAuthedUserOr404(req.user.uid, res);
    if (!me) return;
  const requestId = req.body?.requestId;
    if (!requestId) return res.status(400).json({ error: "requestId required" });

    const gr = await prisma.groupRequest.findUnique({
      where: { id: requestId },
      select: { id: true, fromUserId: true, toUserId: true, status: true },
    });
    if (!gr) return res.status(404).json({ error: "Request not found" });
    if (gr.toUserId !== me.id) return res.status(403).json({ error: "Not your request" });
    if (gr.status !== "PENDING") return res.status(400).json({ error: "Request is not pending" });

    await prisma.groupRequest.update({ where: { id: gr.id }, data: { status: "DECLINED" } });
    res.json({ ok: true });
  } catch (err) {
    console.error("[group/decline] error:", err);
    res.status(500).json({ error: "failed to decline group request" });
  }
});

/** POST /api/group/cancel { requestId } — only creator can cancel */
router.post("/cancel", async (req, res) => {
  try {
    const me = await getAuthedUserOr404(req.user.uid, res);
    if (!me) return;

    const requestId = req.body?.requestId;
    if (!requestId) return res.status(400).json({ error: "requestId required" });

    const gr = await prisma.groupRequest.findUnique({
      where: { id: requestId },
      select: { id: true, fromUserId: true, status: true },
    });
    if (!gr) return res.status(404).json({ error: "Request not found" });
    if (gr.fromUserId !== me.id) return res.status(403).json({ error: "Not your outgoing request" });
    if (gr.status !== "PENDING") return res.status(400).json({ error: "Request is not pending" });

    await prisma.groupRequest.update({ where: { id: gr.id }, data: { status: "CANCELED" } });
    res.json({ ok: true });
  } catch (err) {
    console.error("[group/cancel] error:", err);
    res.status(500).json({ error: "failed to cancel group request" });
  }
});

// ─────────────────────────── Sessions (“Ready”) ───────────────────────────

/** GET /api/group/sessions → active sessions for the authed user (finalizes any finished) */
router.get("/sessions", async (req, res) => {
  try {
    const me = await getAuthedUserOr404(req.user.uid, res);
    if (!me) return;

    // Fetch active sessions where I am A or B
    const rows = await prisma.groupSwipeSession.findMany({
      where: {
        status: "active",
        OR: [{ aUserId: me.id }, { bUserId: me.id }],
      },
      orderBy: { startedAt: "desc" },
      select: {
        id: true, aUserId: true, bUserId: true,
        aUser: { select: { id: true, displayName: true, username: true, email: true } },
        bUser: { select: { id: true, displayName: true, username: true, email: true } },
      },
    });

    const sessions = [];
    for (const s of rows) {
      // eager finalize if done
      await maybeFinalizeSession(s.id);

      // re-check status
      const nowRow = await prisma.groupSwipeSession.findUnique({
        where: { id: s.id },
        select: { status: true },
      });
      if (nowRow?.status !== "active") continue;

      const partner = s.aUserId === me.id ? s.bUser : s.aUser;
      const { aCount, bCount, limit } = await getSessionCounts(s.id, s.aUserId, s.bUserId);
      const you = s.aUserId === me.id ? aCount : bCount;
      const them = s.aUserId === me.id ? bCount : aCount;

      sessions.push({
        id: s.id,
        partner: {
          id: partner.id,
          name: labelOfUser(partner),
          username: usernameOfUser(partner),
        },
        youCount: you,
        partnerCount: them,
        limit,
      });
    }

    res.json({ sessions });
  } catch (err) {
    console.error("[group/sessions] error:", err);
    res.status(500).json({ error: "failed to load sessions" });
  }
});

/** GET /api/group/session/:id/state → { status, youCount, partnerCount, limit } (also finalizes if done) */
router.get("/session/:id/state", async (req, res) => {
  try {
    const me = await getAuthedUserOr404(req.user.uid, res);
    if (!me) return;

    const s = await prisma.groupSwipeSession.findUnique({
      where: { id: req.params.id },
      select: { id: true, status: true, aUserId: true, bUserId: true },
    });
    if (!s) return res.status(404).json({ error: "Session not found" });
    if (s.aUserId !== me.id && s.bUserId !== me.id) return res.status(403).json({ error: "Not in this session" });

    // maybe finalize
    await maybeFinalizeSession(s.id);
    const after = await prisma.groupSwipeSession.findUnique({
      where: { id: s.id },
      select: { id: true, status: true, aUserId: true, bUserId: true },
    });

    const { aCount, bCount, limit } = await getSessionCounts(s.id, after.aUserId, after.bUserId);
    const you = after.aUserId === me.id ? aCount : bCount;
    const them = after.aUserId === me.id ? bCount : aCount;

    res.json({ status: after.status, youCount: you, partnerCount: them, limit });
  } catch (err) {
    console.error("[group/session/state] error:", err);
    res.status(500).json({ error: "failed to load state" });
  }
});

/** POST /api/group/session/:id/feedback { restaurantId, action } — logs a swipe and maybe finalizes */
router.post("/session/:id/feedback", async (req, res) => {
  try {
    const me = await getAuthedUserOr404(req.user.uid, res);
    if (!me) return;

    const { restaurantId, action } = req.body || {};
    if (!restaurantId || !action) return res.status(400).json({ error: "restaurantId and action required" });

    const s = await prisma.groupSwipeSession.findUnique({
      where: { id: req.params.id },
      select: { id: true, status: true, aUserId: true, bUserId: true },
    });
    if (!s) return res.status(404).json({ error: "Session not found" });
    if (s.status !== "active") return res.status(400).json({ error: "Session not active" });
    if (s.aUserId !== me.id && s.bUserId !== me.id) return res.status(403).json({ error: "Not in this session" });

    // position = count+1 for this user
    const countForUser = await prisma.groupSwipeEvent.count({
      where: { sessionId: s.id, userId: me.id },
    });

    await prisma.groupSwipeEvent.create({
      data: {
        sessionId: s.id,
        userId: me.id,
        restaurantId,
        action, // "LIKE" | "PASS" | "SUPERSTAR"
        position: countForUser + 1,
      },
    });

    // maybe finalize
    await maybeFinalizeSession(s.id);

    res.json({ ok: true });
  } catch (err) {
    console.error("[group/session/feedback] error:", err);
    res.status(500).json({ error: "failed to record feedback" });
  }
});

// --- ADD: list group matches for the authed user ----------------------------
router.get("/matches", async (req, res) => {
  try {
    const me = await getAuthedUserOr404(req.user.uid, res);
    if (!me) return;

    // Fetch group matches where I'm host or friend
    const rows = await prisma.groupMatch.findMany({
      where: {
        OR: [{ hostUserId: me.id }, { friendUserId: me.id }],
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        sessionId: true,
        createdAt: true,
        comment: true,
        winnerRestaurantId: true,
        top1RestaurantId: true,
        top2RestaurantId: true,
        top3RestaurantId: true,
        superStarRestaurantId: true,
      },
    });

    // Collect restaurant IDs we need
    const ids = new Set();
    for (const r of rows) {
      [r.winnerRestaurantId, r.top1RestaurantId, r.top2RestaurantId, r.top3RestaurantId, r.superStarRestaurantId]
        .filter(Boolean)
        .forEach((id) => ids.add(id));
    }

    // Load restaurants in one query
    const restos = await prisma.restaurant.findMany({
      where: { id: { in: Array.from(ids) } },
      select: {
        id: true,
        name: true,
        formattedAddress: true,
        priceLevel: true,
        primaryType: true,
        primaryTypeDisplayName: true,
        types: true,
        editorialSummary: true,
      },
    });
    const byId = new Map(restos.map((r) => [r.id, r]));

    // Normalize to the List screen shape
    function mapResto(r) {
      if (!r) return null;
      return {
        id: r.id,
        name: r.name,
        address: r.formattedAddress ?? null,
        priceLevel: r.priceLevel ?? null,
        primaryType: r.primaryTypeDisplayName || r.primaryType || null,
        types: r.types ?? null,
        editorialSummary: r.editorialSummary ?? null,
        editorial_summary: r.editorialSummary ?? null, // your UI checks either key
        photoUrl: null, // optional: wire to your photos table if you want
      };
    }

    const matches = rows.map((m) => {
      const winner = m.winnerRestaurantId ? byId.get(m.winnerRestaurantId) : null;
      const top1 = m.top1RestaurantId ? byId.get(m.top1RestaurantId) : null;
      const top2 = m.top2RestaurantId ? byId.get(m.top2RestaurantId) : null;
      const top3 = m.top3RestaurantId ? byId.get(m.top3RestaurantId) : null;
      const superStar = m.superStarRestaurantId ? byId.get(m.superStarRestaurantId) : null;

      return {
        id: m.id,
        sessionId: m.sessionId,
        createdAt: m.createdAt,
        userComment: m.comment ?? null,
        winner: mapResto(winner) || mapResto(top1),
        top1: mapResto(top1),
        top2: mapResto(top2),
        top3: mapResto(top3),
        superStar: mapResto(superStar),
        // optional: flag so you can tint differently client-side
        isGroup: true,
      };
    });

    res.json({ matches });
  } catch (err) {
    console.error("[group/matches] error:", err);
    res.status(500).json({ error: "failed to load group matches" });
  }
});


module.exports = router;
