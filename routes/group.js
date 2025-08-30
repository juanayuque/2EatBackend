// routes/group.js
const express = require("express");
const prisma = require("../src/prisma");
const verifyFirebaseToken = require("../middleware/auth");

const router = express.Router();
router.use(verifyFirebaseToken);

const SWIPE_LIMIT = 15;

// ───────── Helpers ─────────
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

async function assertAreFriendsOr400(meId, otherUserId, res) {
  const a = await prisma.friend.findFirst({ where: { userId: meId, friendId: otherUserId }, select: { id: true } });
  const b = await prisma.friend.findFirst({ where: { userId: otherUserId, friendId: meId }, select: { id: true } });
  if (!a && !b) {
    res.status(400).json({ error: "You can only group-match with friends" });
    return false;
  }
  return true;
}

async function getUserBasic(id) {
  return prisma.user.findUnique({
    where: { id },
    select: { id: true, displayName: true, username: true, email: true, preferredCuisines: true },
  });
}

/** Build a 15-item pool from both users' cuisine prefs. */
async function buildPool(aId, bId) {
  const [ua, ub] = await Promise.all([getUserBasic(aId), getUserBasic(bId)]);
  const cuisines = Array.from(new Set([...(ua?.preferredCuisines || []), ...(ub?.preferredCuisines || [])]));
  // Simple selector: any restaurant whose types overlap cuisines (fallback: any)
  let restaurants = [];
  if (cuisines.length) {
    restaurants = await prisma.restaurant.findMany({
      where: { types: { hasSome: cuisines } },
      take: SWIPE_LIMIT,
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
  }
  if (restaurants.length < SWIPE_LIMIT) {
    const filler = await prisma.restaurant.findMany({
      take: SWIPE_LIMIT - restaurants.length,
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    restaurants = [...restaurants, ...filler];
  }
  // return ids only; details fetched per-state call
  return restaurants.map((r) => r.id);
}

async function fetchRestaurantBasic(id) {
  if (!id) return null;
  const r = await prisma.restaurant.findUnique({
    where: { id },
    select: { id: true, name: true, formattedAddress: true },
  });
  if (!r) return null;
  return { id: r.id, name: r.name, address: r.formattedAddress };
}

function scoreForAction(action) {
  if (action === "SUPERSTAR") return 3;
  if (action === "LIKE") return 2;
  return 0; // PASS
}

// ───────── Routes ─────────

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

    // Existing PENDING either direction?
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

    // Create (or revive) directed request
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

/** POST /api/group/accept { requestId } → { ok, sessionId } */
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

    let sessionId = null;

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

      const newSession = await tx.groupSwipeSession.create({
        data: {
          status: "active",
          startedById: me.id,
          aUserId: gr.fromUserId,
          bUserId: gr.toUserId,
          context: {}, // pool created lazily on first /state
        },
        select: { id: true },
      });
      sessionId = newSession.id;
    });

    res.json({ ok: true, sessionId });
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

/** GET /api/group/sessions → active sessions for me (for “Ready” column) */
router.get("/sessions", async (req, res) => {
  try {
    const me = await getAuthedUserOr404(req.user.uid, res);
    if (!me) return;

    const rows = await prisma.groupSwipeSession.findMany({
      where: {
        status: "active",
        OR: [{ aUserId: me.id }, { bUserId: me.id }],
      },
      orderBy: { startedAt: "desc" },
      select: { id: true, aUserId: true, bUserId: true },
    });

    const sessions = await Promise.all(
      rows.map(async (row) => {
        const partnerId = row.aUserId === me.id ? row.bUserId : row.aUserId;

        const [partner, youCount, partnerCount] = await Promise.all([
          getUserBasic(partnerId),
          prisma.groupSwipeEvent.count({ where: { sessionId: row.id, userId: me.id } }),
          prisma.groupSwipeEvent.count({ where: { sessionId: row.id, userId: partnerId } }),
        ]);

        return {
          id: row.id,
          partner: {
            id: partnerId,
            name: labelOfUser(partner),
            username: usernameOfUser(partner),
          },
          youCount,
          partnerCount,
          limit: SWIPE_LIMIT,
        };
      })
    );

    res.json({ sessions });
  } catch (err) {
    console.error("[group/sessions] error:", err);
    res.status(500).json({ error: "failed to load sessions" });
  }
});

/** GET /api/group/session/:id/state → progress + next card or result */
router.get("/session/:id/state", async (req, res) => {
  try {
    const me = await getAuthedUserOr404(req.user.uid, res);
    if (!me) return;
    const id = String(req.params.id);

    const s = await prisma.groupSwipeSession.findUnique({
      where: { id },
      select: { id: true, status: true, aUserId: true, bUserId: true, context: true },
    });
    if (!s) return res.status(404).json({ error: "Session not found" });
    if (s.aUserId !== me.id && s.bUserId !== me.id) return res.status(403).json({ error: "Not your session" });

    // ensure pool exists
    let ctx = s.context || {};
    if (!Array.isArray(ctx.pool) || ctx.pool.length < SWIPE_LIMIT) {
      ctx.pool = await buildPool(s.aUserId, s.bUserId);
      await prisma.groupSwipeSession.update({ where: { id: s.id }, data: { context: ctx } });
    }

    const events = await prisma.groupSwipeEvent.findMany({
      where: { sessionId: s.id },
      orderBy: { createdAt: "asc" },
      select: { userId: true, restaurantId: true, action: true },
    });

    const youId = me.id;
    const partnerId = s.aUserId === me.id ? s.bUserId : s.aUserId;

    const youCount = events.filter((e) => e.userId === youId).length;
    const partnerCount = events.filter((e) => e.userId === partnerId).length;

    const bothDone = youCount >= SWIPE_LIMIT && partnerCount >= SWIPE_LIMIT;

    // compute result if both done (and cache into GroupMatch once)
    let result = null;
    if (bothDone) {
      const existing = await prisma.groupMatch.findUnique({ where: { sessionId: s.id } });
      if (existing) {
        // fetch top3 names
        const topIds = [existing.winnerRestaurantId, existing.top2RestaurantId, existing.top3RestaurantId].filter(Boolean);
        const infos = await prisma.restaurant.findMany({
          where: { id: { in: topIds } },
          select: { id: true, name: true, formattedAddress: true },
        });
        const map = new Map(infos.map((r) => [r.id, r]));
        const top3 = [
          { id: existing.winnerRestaurantId, name: map.get(existing.winnerRestaurantId)?.name || "Winner", address: map.get(existing.winnerRestaurantId)?.formattedAddress || null, rank: 1 },
        ];
        if (existing.top2RestaurantId) top3.push({ id: existing.top2RestaurantId, name: map.get(existing.top2RestaurantId)?.name || "Choice 2", address: map.get(existing.top2RestaurantId)?.formattedAddress || null, rank: 2 });
        if (existing.top3RestaurantId) top3.push({ id: existing.top3RestaurantId, name: map.get(existing.top3RestaurantId)?.name || "Choice 3", address: map.get(existing.top3RestaurantId)?.formattedAddress || null, rank: 3 });
        result = { top3 };
      } else {
        // compute simple scores
        const scores = new Map(); // id -> score
        for (const e of events) {
          const prev = scores.get(e.restaurantId) || 0;
          scores.set(e.restaurantId, prev + scoreForAction(e.action));
        }
        const ranked = ctx.pool
          .map((id) => ({ id, score: scores.get(id) || 0 }))
          .sort((a, b) => b.score - a.score);

        const top3Ids = ranked.slice(0, 3).map((r) => r.id);
        // fetch names
        const infos = await prisma.restaurant.findMany({
          where: { id: { in: top3Ids } },
          select: { id: true, name: true, formattedAddress: true },
        });
        const map = new Map(infos.map((r) => [r.id, r]));
        const top3 = top3Ids.map((id, i) => ({ id, name: map.get(id)?.name || `Choice ${i + 1}`, address: map.get(id)?.formattedAddress || null, rank: i + 1 }));

        await prisma.groupMatch.create({
          data: {
            sessionId: s.id,
            hostUserId: s.aUserId,
            friendUserId: s.bUserId,
            top1RestaurantId: top3[0]?.id || ctx.pool[0],
            top2RestaurantId: top3[1]?.id || null,
            top3RestaurantId: top3[2]?.id || null,
            winnerRestaurantId: top3[0]?.id || ctx.pool[0],
          },
        });

        result = { top3 };
      }
    }

    // next card for me
    const nextId = !bothDone && youCount < SWIPE_LIMIT ? ctx.pool[youCount] : null;
    const next = await fetchRestaurantBasic(nextId);

    res.json({
      limit: SWIPE_LIMIT,
      youCount,
      partnerCount,
      bothDone,
      next: next || null,
      result,
    });
  } catch (err) {
    console.error("[group/session/state] error:", err);
    res.status(500).json({ error: "failed to load session state" });
  }
});

/** POST /api/group/swipe { sessionId, restaurantId, action } */
router.post("/swipe", async (req, res) => {
  try {
    const me = await getAuthedUserOr404(req.user.uid, res);
    if (!me) return;

    const { sessionId, restaurantId, action } = req.body || {};
    if (!sessionId || !restaurantId || !action) {
      return res.status(400).json({ error: "sessionId, restaurantId, action required" });
    }
    if (!["LIKE", "PASS", "SUPERSTAR"].includes(action)) {
      return res.status(400).json({ error: "invalid action" });
    }

    const s = await prisma.groupSwipeSession.findUnique({
      where: { id: sessionId },
      select: { id: true, status: true, aUserId: true, bUserId: true, context: true },
    });
    if (!s) return res.status(404).json({ error: "Session not found" });
    if (s.status !== "active") return res.status(400).json({ error: "Session not active" });
    if (s.aUserId !== me.id && s.bUserId !== me.id) return res.status(403).json({ error: "Not your session" });

    let ctx = s.context || {};
    if (!Array.isArray(ctx.pool) || ctx.pool.length < SWIPE_LIMIT) {
      ctx.pool = await buildPool(s.aUserId, s.bUserId);
      await prisma.groupSwipeSession.update({ where: { id: s.id }, data: { context: ctx } });
    }

    const youCount = await prisma.groupSwipeEvent.count({ where: { sessionId: s.id, userId: me.id } });
    if (youCount >= SWIPE_LIMIT) {
      return res.status(400).json({ error: "You have completed your swipes" });
    }

    const expectedRestaurantId = ctx.pool[youCount];
    if (expectedRestaurantId !== restaurantId) {
      // Prevent out-of-order or pool mismatch
      return res.status(400).json({ error: "Unexpected restaurant for this position" });
    }

    await prisma.groupSwipeEvent.create({
      data: {
        sessionId: s.id,
        userId: me.id,
        restaurantId,
        action,
        position: youCount + 1,
      },
    });

    res.json({ ok: true, position: youCount + 1 });
  } catch (err) {
    console.error("[group/swipe] error:", err);
    res.status(500).json({ error: "failed to record swipe" });
  }
});

module.exports = router;
