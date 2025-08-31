// routes/group.js
const express = require("express");
const prisma = require("../src/prisma");
const verifyFirebaseToken = require("../middleware/auth");

const router = express.Router();
router.use(verifyFirebaseToken);

// ─────────────────────────── Config ───────────────────────────
const SWIPE_LIMIT = 15; // 15 swipes per user to finish
const DESIRED_MIN_POOL_HINT = Number(process.env.GROUP_MIN_POOL || 12); // looser floor

// Recs / helpers reused from solo flow
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const BACKEND_PUBLIC_URL = process.env.BACKEND_PUBLIC_URL || "https://2eatapp.com";
const RECS_SERVICE_URL =
  process.env.RECS_SERVICE_URL || process.env.RECS_URL || "http://127.0.0.1:8000";

const { createPlacesService } = require("../src/services/placesService");
const { ensurePreferredPool } = require("../src/recs/pool");
const { radiusFromUser } = require("../src/recs/filters");
const { orderPoolDeterministic, mkSeed } = require("../src/recs/pagination");
const { rankIdsWithinPage, buildUserFeatures, buildItemFeatures } = require("../src/recs/rank");
const { haversineKm, asFloat } = require("../src/utils/geo");

const places = createPlacesService({ prisma, googleApiKey: GOOGLE_API_KEY });

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

// ⬅️⬅️ Missing before: restore getSessionCounts and place it BEFORE any usage
async function getSessionCounts(sessionId, aUserId, bUserId) {
  // count per user; groupBy also works, but two counts are simple and robust
  const [a, b] = await Promise.all([
    prisma.groupSwipeEvent.count({ where: { sessionId, userId: aUserId } }),
    prisma.groupSwipeEvent.count({ where: { sessionId, userId: bUserId } }),
  ]);
  return { aCount: a, bCount: b, limit: SWIPE_LIMIT };
}

// Merge prefs conservatively so both can eat/enjoy
function combinedUser(u1, u2) {
  const uniq = (arr) => Array.from(new Set((arr || []).filter(Boolean)));
  const minOr = (a, b) => (a == null ? b ?? null : b == null ? a ?? null : Math.min(a, b));
  return {
    id: `${u1.id}+${u2.id}`,
    firebaseUid: u1.firebaseUid,
    searchDistance: minOr(u1.searchDistance ?? 5, u2.searchDistance ?? 5),
    budgetMax: minOr(u1.budgetMax ?? null, u2.budgetMax ?? null),
    dietaryNeeds: uniq([...(u1.dietaryNeeds || []), ...(u2.dietaryNeeds || [])]),
    preferredCuisines: uniq([...(u1.preferredCuisines || []), ...(u2.preferredCuisines || [])]),
    displayName: `${u1.displayName || "You"} & ${u2.displayName || "Friend"}`,
  };
}
function noStore(res) {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
}

// Build (or reuse cached) 20-item pool = 10 near A + 10 near B
async function ensureSessionPool(session) {
  let ctx = session.context || {};
  const seed = ctx.seed || mkSeed(session.id);

  // Already cached?
  if (Array.isArray(ctx.poolIds) && ctx.poolIds.length >= 10) {
    return { ids: ctx.poolIds, seed, ctx };
  }

  // Load users + any stored locations
  const s = await prisma.groupSwipeSession.findUnique({
    where: { id: session.id },
    include: { aUser: true, bUser: true },
  });
  if (!s) return { ids: [], seed, ctx };

  const duo = combinedUser(s.aUser, s.bUser);
  const radiusKm = radiusFromUser(duo);
  const want = Math.max(10, DESIRED_MIN_POOL_HINT);

  const locA = ctx.locA && typeof ctx.locA.lat === "number" && typeof ctx.locA.lng === "number" ? ctx.locA : null;
  const locB = ctx.locB && typeof ctx.locB.lat === "number" && typeof ctx.locB.lng === "number" ? ctx.locB : null;

  if (!locA && !locB) return { ids: [], seed, ctx };

  async function pullAt(loc) {
    const pool = await ensurePreferredPool({
      places,
      lat: loc.lat,
      lng: loc.lng,
      user: duo,
      desiredMin: want,
    });
    // Deterministic order before slicing
    const ordered = orderPoolDeterministic(pool, session.id, seed);
    return ordered.slice(0, 10).map((r) => r.id);
  }

  let idsA = [];
  let idsB = [];
  if (locA) idsA = await pullAt(locA);
  if (locB) idsB = await pullAt(locB);

  const merged = Array.from(new Set([...idsA, ...idsB]));
  if (!merged.length) return { ids: [], seed, ctx };

  // Reorder deterministically using objects with id
  const det = orderPoolDeterministic(merged.map((id) => ({ id })), session.id, seed).map((x) => x.id);

  ctx = { ...ctx, seed, poolIds: det, radiusKm };
  await prisma.groupSwipeSession.update({ where: { id: session.id }, data: { context: ctx } });

  return { ids: det, seed, ctx };
}

// Next card for a given user = pool[index equal to user's swipe count]
async function nextCardForUser(session, userId) {
  const { ids } = await ensureSessionPool(session);
  if (!ids.length) return null;

  const countForUser = await prisma.groupSwipeEvent.count({
    where: { sessionId: session.id, userId },
  });
  if (countForUser >= SWIPE_LIMIT) return null;

  const idx = Math.min(countForUser, ids.length - 1);
  const id = ids[idx];

  const r = await prisma.restaurant.findUnique({
    where: { id },
    include: { photos: { take: 1 } },
  });
  if (!r) return null;

  const photoName = r.photos?.[0]?.name || null;
  const photoUrl = photoName
    ? `${BACKEND_PUBLIC_URL}/api/recs/photo?name=${encodeURIComponent(photoName)}&w=1200`
    : null;

  return {
    id: r.id,
    name: r.name,
    address: r.formattedAddress,
    priceLevel: r.priceLevel ?? null,
    photoUrl,
    primaryType: r.primaryType,
    types: r.types,
    editorialSummary: r.editorialSummary || null,
  };
}

// Build Top3 + Winner with LightFM; fallback to heuristic
async function rankTop3WithRecs(sessionId) {
  const s = await prisma.groupSwipeSession.findUnique({
    where: { id: sessionId },
    include: { aUser: true, bUser: true },
  });
  if (!s) return { top: [], winner: null };

  const duo = combinedUser(s.aUser, s.bUser);

  const evts = await prisma.groupSwipeEvent.findMany({
    where: { sessionId },
    select: { restaurantId: true, userId: true, action: true },
  });
  const candidateIds = Array.from(new Set(evts.map((e) => e.restaurantId)));
  if (!candidateIds.length) return { top: [], winner: null };

  const restos = await prisma.restaurant.findMany({
    where: { id: { in: candidateIds } },
    include: { photos: { take: 1 } },
  });

  const ctx =
    (await prisma.groupSwipeSession.findUnique({
      where: { id: sessionId },
      select: { context: true },
    }))?.context || {};
  const ref =
    (ctx.locA && typeof ctx.locA.lat === "number" && ctx.locA) ||
    (ctx.locB && typeof ctx.locB.lat === "number" && ctx.locB) ||
    null;
  const refLat = ref?.lat ?? 0;
  const refLng = ref?.lng ?? 0;

  const items = buildItemFeatures(restos, refLat, refLng);
  const interactions = evts.map((e) => ({ userId: e.userId, itemId: e.restaurantId, action: e.action }));
  const userFeatures = buildUserFeatures(duo);

  let ranked = [];
  try {
    ranked = await rankIdsWithinPage({
      rankUrl: RECS_SERVICE_URL,
      userId: duo.id,
      userFeatures,
      items,
      interactions,
    });
  } catch {
    const weight = (a) => (a === "SUPERSTAR" ? 3 : a === "LIKE" ? 1 : 0);
    const m = new Map();
    for (const e of evts) m.set(e.restaurantId, (m.get(e.restaurantId) || 0) + weight(e.action));
    ranked = Array.from(candidateIds).sort((a, b) => (m.get(b) || 0) - (m.get(a) || 0));
  }

  const top = ranked.slice(0, 3);
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

  const existing = await prisma.groupMatch.findUnique({ where: { sessionId: s.id } });
  if (existing) {
    await prisma.groupSwipeSession.update({
      where: { id: s.id },
      data: { status: "completed", endedAt: new Date() },
    });
    return { finalized: true, matchId: existing.id };
  }

  const { top, winner } = await rankTop3WithRecs(s.id);
  const [top1, top2, top3] = [top[0] || null, top[1] || null, top[2] || null];

  await prisma.$transaction(async (tx) => {
    await tx.groupSwipeSession.update({
      where: { id: s.id },
      data: { status: "completed", endedAt: new Date() },
    });
    await tx.groupMatch.create({
      data: {
        sessionId: s.id,
        hostUserId: s.aUserId,
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
  noStore(res);
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
          context: {}, // per-user locations come from /session/:id/start
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
  noStore(res);
  try {
    const me = await getAuthedUserOr404(req.user.uid, res);
    if (!me) return;

    const rows = await prisma.groupSwipeSession.findMany({
      where: { status: "active", OR: [{ aUserId: me.id }, { bUserId: me.id }] },
      orderBy: { startedAt: "desc" },
      select: {
        id: true,
        aUserId: true,
        bUserId: true,
        aUser: { select: { id: true, displayName: true, username: true, email: true } },
        bUser: { select: { id: true, displayName: true, username: true, email: true } },
      },
    });

    const sessions = [];
    for (const s of rows) {
      await maybeFinalizeSession(s.id);

      const now = await prisma.groupSwipeSession.findUnique({
        where: { id: s.id },
        select: { status: true },
      });
      if (now?.status !== "active") continue;

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

/** POST /api/group/session/:id/start { lat, lng } — store caller's location in context */
router.post("/session/:id/start", async (req, res) => {
  try {
    const me = await getAuthedUserOr404(req.user.uid, res);
    if (!me) return;

    const { lat, lng } = req.body || {};
    if (typeof lat !== "number" || typeof lng !== "number") {
      return res.status(400).json({ error: "lat,lng required" });
    }

    const s = await prisma.groupSwipeSession.findUnique({
      where: { id: req.params.id },
      select: { id: true, aUserId: true, bUserId: true, context: true },
    });
    if (!s) return res.status(404).json({ error: "Session not found" });
    if (s.aUserId !== me.id && s.bUserId !== me.id) return res.status(403).json({ error: "Not in this session" });

    const ctx = s.context || {};
    const key = s.aUserId === me.id ? "locA" : "locB";
    ctx[key] = { lat, lng };
    if (!ctx.seed) ctx.seed = mkSeed(s.id);

    await prisma.groupSwipeSession.update({ where: { id: s.id }, data: { context: ctx } });
    res.json({ ok: true });
  } catch (err) {
    console.error("[group/session/start] error:", err);
    res.status(500).json({ error: "failed to save location" });
  }
});

/** GET /api/group/session/:id/state → progress + next card (and result when done) */
router.get("/session/:id/state", async (req, res) => {
  noStore(res);
  try {
    const me = await getAuthedUserOr404(req.user.uid, res);
    if (!me) return;

    const s = await prisma.groupSwipeSession.findUnique({
      where: { id: req.params.id },
      select: { id: true, status: true, aUserId: true, bUserId: true, context: true },
    });
    if (!s) return res.status(404).json({ error: "Session not found" });
    if (s.aUserId !== me.id && s.bUserId !== me.id) return res.status(403).json({ error: "Not in this session" });

    await maybeFinalizeSession(s.id);
    const after = await prisma.groupSwipeSession.findUnique({
      where: { id: s.id },
      select: { id: true, status: true, aUserId: true, bUserId: true, context: true },
    });

    const { aCount, bCount, limit } = await getSessionCounts(after.id, after.aUserId, after.bUserId);
    const you = after.aUserId === me.id ? aCount : bCount;
    const them = after.aUserId === me.id ? bCount : aCount;

    if (after.status === "completed") {
      const gm = await prisma.groupMatch.findUnique({ where: { sessionId: after.id } });
      let top3 = [];
      if (gm) {
        const ids = [gm.top1RestaurantId, gm.top2RestaurantId, gm.top3RestaurantId].filter(Boolean);
        const rows = await prisma.restaurant.findMany({
          where: { id: { in: ids } },
          select: { id: true, name: true, formattedAddress: true },
        });
        const byId = new Map(rows.map((r) => [r.id, r]));
        top3 = ids.map((id, i) => {
          const r = byId.get(id);
          return { id, name: r?.name || `Restaurant ${id.slice(0, 6)}`, address: r?.formattedAddress ?? null, rank: i + 1 };
        });
      }
      return res.json({
        status: after.status,
        limit,
        youCount: you,
        partnerCount: them,
        bothDone: true,
        result: { top3 },
      });
    }

    const next = await nextCardForUser(after, me.id);
    res.json({
      status: after.status,
      limit,
      youCount: you,
      partnerCount: them,
      bothDone: you >= limit && them >= limit,
      next,
    });
  } catch (err) {
    console.error("[group/session/state] error:", err);
    res.status(500).json({ error: "failed to load state" });
  }
});

/** POST /api/group/session/:id/feedback { restaurantId, action } */
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

    const countForUser = await prisma.groupSwipeEvent.count({
      where: { sessionId: s.id, userId: me.id },
    });

    if (countForUser >= SWIPE_LIMIT) {
      await maybeFinalizeSession(s.id);
      return res.json({ ok: true, reachedLimit: true });
    }

    await prisma.groupSwipeEvent.create({
      data: {
        sessionId: s.id,
        userId: me.id,
        restaurantId,
        action, // "LIKE" | "PASS" | "SUPERSTAR"
        position: countForUser + 1,
      },
    });

    await maybeFinalizeSession(s.id);

    res.json({ ok: true });
  } catch (err) {
    console.error("[group/session/feedback] error:", err);
    res.status(500).json({ error: "failed to record feedback" });
  }
});

/** Legacy alias — POST /api/group/swipe { sessionId, restaurantId, action } */
router.post("/swipe", async (req, res) => {
  try {
    const me = await getAuthedUserOr404(req.user.uid, res);
    if (!me) return;

    const { sessionId, restaurantId, action } = req.body || {};
    if (!sessionId || !restaurantId || !action) {
      return res.status(400).json({ error: "sessionId, restaurantId, action required" });
    }

    const s = await prisma.groupSwipeSession.findUnique({
      where: { id: sessionId },
      select: { id: true, status: true, aUserId: true, bUserId: true },
    });
    if (!s) return res.status(404).json({ error: "Session not found" });
    if (s.status !== "active") return res.status(400).json({ error: "Session not active" });
    if (s.aUserId !== me.id && s.bUserId !== me.id) return res.status(403).json({ error: "Not in this session" });

    const countForUser = await prisma.groupSwipeEvent.count({
      where: { sessionId: s.id, userId: me.id },
    });
    if (countForUser >= SWIPE_LIMIT) {
      await maybeFinalizeSession(s.id);
      return res.json({ ok: true, reachedLimit: true });
    }

    await prisma.groupSwipeEvent.create({
      data: {
        sessionId: s.id,
        userId: me.id,
        restaurantId,
        action,
        position: countForUser + 1,
      },
    });

    await maybeFinalizeSession(s.id);

    res.json({ ok: true });
  } catch (err) {
    console.error("[group/swipe alias] error:", err);
    res.status(500).json({ error: "failed to record feedback" });
  }
});

// --- list group matches for the authed user (Your Matches — group tint) ---
router.get("/matches", async (req, res) => {
  noStore(res);
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
        comment: true,
        winnerRestaurantId: true,
        top1RestaurantId: true,
        top2RestaurantId: true,
        top3RestaurantId: true,
        superStarRestaurantId: true,
      },
    });

    const ids = new Set();
    for (const r of rows) {
      [r.winnerRestaurantId, r.top1RestaurantId, r.top2RestaurantId, r.top3RestaurantId, r.superStarRestaurantId]
        .filter(Boolean)
        .forEach((id) => ids.add(id));
    }

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
        photos: { take: 1 },
      },
    });
    const byId = new Map(
      restos.map((r) => [
        r.id,
        {
          id: r.id,
          name: r.name,
          address: r.formattedAddress ?? null,
          priceLevel: r.priceLevel ?? null,
          primaryType: r.primaryTypeDisplayName || r.primaryType || null,
          types: r.types ?? null,
          editorialSummary: r.editorialSummary ?? null,
          editorial_summary: r.editorialSummary ?? null,
          photoUrl: r.photos?.[0]?.name
            ? `${BACKEND_PUBLIC_URL}/api/recs/photo?name=${encodeURIComponent(r.photos[0].name)}&w=1200`
            : null,
        },
      ])
    );

    const matches = rows.map((m) => ({
      id: m.id,
      sessionId: m.sessionId,
      createdAt: m.createdAt,
      userComment: m.comment ?? null,
      winner: byId.get(m.winnerRestaurantId) || byId.get(m.top1RestaurantId) || null,
      top1: byId.get(m.top1RestaurantId) || null,
      top2: byId.get(m.top2RestaurantId) || null,
      top3: byId.get(m.top3RestaurantId) || null,
      superStar: byId.get(m.superStarRestaurantId) || null,
      isGroup: true,
    }));

    res.json({ matches });
  } catch (err) {
    console.error("[group/matches] error:", err);
    res.status(500).json({ error: "failed to load group matches" });
  }
});

module.exports = router;
