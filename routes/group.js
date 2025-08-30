// routes/group.js
const express = require("express");
const prisma = require("../src/prisma");
const verifyFirebaseToken = require("../middleware/auth");

const router = express.Router();

// ─────────────────────────── Auth ───────────────────────────
router.use(verifyFirebaseToken);

const SWIPE_LIMIT = 15;

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
    where: { userId: otherUserId, friendId: me.id },
    select: { id: true },
  });
  if (!friend && !reverse) {
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
  return restaurants.map((r) => r.id);
}

async function fetchRestaurantBasic(id) {
  if (!id) return null;
  const r = await prisma.restaurant.findUnique({
    where: { id },
    select: {
      id: true, name: true, formattedAddress: true,
      priceLevel: true, editorialSummary: true,
    },
  });
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    address: r.formattedAddress,
    priceLevel: r.priceLevel ?? null,
    editorialSummary: r.editorialSummary ?? null,
    photoUrl: null, // populate later if you add photos
  };
}

function scoreForAction(action) {
  if (action === "SUPERSTAR") return 3;
  if (action === "LIKE") return 2;
  return 0;
}

// ─────────────────────────── Routes ───────────────────────────

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

    // NOTE: keep as-is if your original helper had a typo (fixed here)
    const friend = await prisma.friend.findFirst({ where: { userId: me.id, friendId }, select: { id: true } });
    const reverse = await prisma.friend.findFirst({ where: { userId: friendId, friendId: me.id }, select: { id: true } });
    if (!friend && !reverse) return res.status(400).json({ error: "You can only group-match with friends" });

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

/** POST /api/group/accept { requestId } → returns { ok, sessionId } */
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
          context: {}, // pool will be built on first /state
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

/** GET /api/group/sessions → active (not completed) sessions for me */
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
          partner: { id: partnerId, name: labelOfUser(partner), username: usernameOfUser(partner) },
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

/** GET /api/group/session/:id/state → progress + next card or result
 *  ALSO: when both users reach 15/15, compute/store result and mark session COMPLETED,
 *  so it disappears from /group/sessions and shows up in /group/matches.
 */
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

    let result = null;

    if (bothDone) {
      // compute/store result once and mark session completed
      const existing = await prisma.groupMatch.findUnique({ where: { sessionId: s.id } });
      if (!existing) {
        // compute scores
        const scores = new Map();
        for (const e of events) {
          scores.set(e.restaurantId, (scores.get(e.restaurantId) || 0) + scoreForAction(e.action));
        }
        const ranked = ctx.pool
          .map((rid) => ({ id: rid, score: scores.get(rid) || 0 }))
          .sort((a, b) => b.score - a.score);
        const top3Ids = ranked.slice(0, 3).map((r) => r.id);

        await prisma.$transaction(async (tx) => {
          await tx.groupMatch.create({
            data: {
              sessionId: s.id,
              hostUserId: s.aUserId,
              friendUserId: s.bUserId,
              top1RestaurantId: top3Ids[0] || ctx.pool[0],
              top2RestaurantId: top3Ids[1] || null,
              top3RestaurantId: top3Ids[2] || null,
              winnerRestaurantId: top3Ids[0] || ctx.pool[0],
            },
          });
          await tx.groupSwipeSession.update({ where: { id: s.id }, data: { status: "completed" } });
        });
      }

      // build result payload
      const gm = await prisma.groupMatch.findUnique({ where: { sessionId: s.id } });
      const topIds = [gm.winnerRestaurantId, gm.top2RestaurantId, gm.top3RestaurantId].filter(Boolean);
      const infos = await prisma.restaurant.findMany({ where: { id: { in: topIds } } });
      const byId = new Map(infos.map((r) => [r.id, r]));
      result = {
        top3: [
          { id: gm.winnerRestaurantId, name: byId.get(gm.winnerRestaurantId)?.name || "Winner", address: byId.get(gm.winnerRestaurantId)?.formattedAddress || null, rank: 1 },
          gm.top2RestaurantId ? { id: gm.top2RestaurantId, name: byId.get(gm.top2RestaurantId)?.name || "Choice 2", address: byId.get(gm.top2RestaurantId)?.formattedAddress || null, rank: 2 } : null,
          gm.top3RestaurantId ? { id: gm.top3RestaurantId, name: byId.get(gm.top3RestaurantId)?.name || "Choice 3", address: byId.get(gm.top3RestaurantId)?.formattedAddress || null, rank: 3 } : null,
        ].filter(Boolean),
      };
    }

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
    if (!sessionId || !restaurantId || !action) return res.status(400).json({ error: "sessionId, restaurantId, action required" });
    if (!["LIKE", "PASS", "SUPERSTAR"].includes(action)) return res.status(400).json({ error: "invalid action" });

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
    if (youCount >= SWIPE_LIMIT) return res.status(400).json({ error: "You have completed your swipes" });
    const expectedRestaurantId = ctx.pool[youCount];
    if (expectedRestaurantId !== restaurantId) return res.status(400).json({ error: "Unexpected restaurant for this position" });

    await prisma.groupSwipeEvent.create({
      data: { sessionId: s.id, userId: me.id, restaurantId, action, position: youCount + 1 },
    });

    res.json({ ok: true, position: youCount + 1 });
  } catch (err) {
    console.error("[group/swipe] error:", err);
    res.status(500).json({ error: "failed to record swipe" });
  }
});

/**  GET /api/group/matches → group matches for the authed user (for “Your Matches”) */
router.get("/matches", async (req, res) => {
  try {
    const me = await getAuthedUserOr404(req.user.uid, res);
    if (!me) return;

    const rows = await prisma.groupMatch.findMany({
      where: { OR: [{ hostUserId: me.id }, { friendUserId: me.id }] },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        sessionId: true,
        createdAt: true,
        winnerRestaurantId: true,
        top1RestaurantId: true,
        top2RestaurantId: true,
        top3RestaurantId: true,
        superStarRestaurantId: true,
      },
    });

    // Collect all restaurant ids
    const ids = Array.from(
      new Set(
        rows.flatMap((r) => [
          r.winnerRestaurantId,
          r.top1RestaurantId,
          r.top2RestaurantId,
          r.top3RestaurantId,
          r.superStarRestaurantId,
        ]).filter(Boolean)
      )
    );

    const restos = await prisma.restaurant.findMany({
      where: { id: { in: ids } },
      select: {
        id: true, name: true, formattedAddress: true,
        priceLevel: true, editorialSummary: true,
      },
    });
    const map = new Map(restos.map((r) => [r.id, r]));

    const toR = (id) => {
      if (!id) return null;
      const r = map.get(id);
      if (!r) return null;
      return {
        id: r.id,
        name: r.name,
        address: r.formattedAddress,
        priceLevel: r.priceLevel ?? null,
        editorialSummary: r.editorialSummary ?? null,
        photoUrl: null,
      };
    };

    const matches = rows.map((m) => ({
      id: m.id,
      sessionId: m.sessionId,
      createdAt: m.createdAt,
      userComment: null, // you can add per-user comment later
      winner: toR(m.winnerRestaurantId) || toR(m.top1RestaurantId),
      top1: toR(m.top1RestaurantId) || toR(m.winnerRestaurantId),
      top2: toR(m.top2RestaurantId),
      top3: toR(m.top3RestaurantId),
      superStar: toR(m.superStarRestaurantId),
      isGroup: true,
    }));

    res.json({ matches });
  } catch (err) {
    console.error("[group/matches] error:", err);
    res.status(500).json({ error: "failed to load group matches" });
  }
});

module.exports = router;
