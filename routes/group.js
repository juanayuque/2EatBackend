// routes/group.js
"use strict";

const express = require("express");
const prisma = require("../src/prisma");
const verifyFirebaseToken = require("../middleware/auth");

const router = express.Router();
router.use(verifyFirebaseToken);

// ─────────────────────────── Config ───────────────────────────
const SWIPE_LIMIT = 15;
const DESIRED_MIN_POOL = 10; // loosened pool target
const RADIUS_KM_DEFAULT = 5;

// ─────────────────────────── Utils ───────────────────────────
const log = (tag, obj) => {
  try {
    console.log(`[group] ${tag}`, JSON.stringify(obj, null, 2));
  } catch {
    console.log(`[group] ${tag}`, obj);
  }
};

function deg2rad(d) { return d * Math.PI / 180; }
function haversineKm(a, b) {
  const R = 6371;
  const dLat = deg2rad((b.lat || 0) - (a.lat || 0));
  const dLng = deg2rad((b.lng || 0) - (a.lng || 0));
  const s1 = Math.sin(dLat/2), s2 = Math.sin(dLng/2);
  const aa = s1*s1 + Math.cos(deg2rad(a.lat||0))*Math.cos(deg2rad(b.lat||0))*s2*s2;
  return 2 * R * Math.asin(Math.sqrt(aa));
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
function usernameOfUser(u) { return u?.username || null; }

async function getAuthedUserOr404(firebaseUid, res) {
  const user = await prisma.user.findUnique({ where: { firebaseUid } });
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return null;
  }
  return user;
}

// Ensure the two users are friends.
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

// ---------- cuisine keyword logic ----------
const norm = (s) => String(s || "").toLowerCase().replace(/[_\s-]+/g, " ").trim();
const CUISINE_KEYWORDS = {
  indian: ["indian"],
  chinese: ["chinese", "szechuan", "sichuan", "cantonese", "hunan"],
  italian: ["italian", "pizza", "pasta", "sicilian", "tuscan"],
  japanese: ["japanese", "sushi", "ramen", "izakaya"],
  thai: ["thai"],
  mexican: ["mexican", "taqueria", "taco"],
  korean: ["korean", "bbq"],
  american: ["american", "burger", "bbq", "diner"],
  vietnamese: ["vietnamese", "pho", "banh mi", "bahn mi"],
  mediterranean: ["mediterranean", "greek", "turkish", "lebanese"],
  "middle eastern": ["middle eastern", "lebanese", "turkish", "persian", "iranian"],
  spanish: ["spanish", "tapas"],
  french: ["french", "brasserie"],
  greek: ["greek"],
  turkish: ["turkish"],
  lebanese: ["lebanese"],
  persian: ["persian", "iranian"],
  "fast food": ["fast"],
  fastfood: ["fast"],
};
function expandUserCuisineKeywords(prefs) {
  const set = new Set();
  for (const p of prefs || []) {
    const key = norm(p);
    const arr = CUISINE_KEYWORDS[key] || [key];
    arr.forEach((a) => set.add(a));
  }
  return Array.from(set);
}

// ─────────────────────────── Pool builder ───────────────────────────
async function fetchUserPrefs(userId) {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true, displayName: true, username: true, email: true,
      searchDistance: true,
      budgetMax: true,
      dietaryNeeds: true,
      preferredCuisines: true,
    },
  });

  const preferredCuisines = Array.isArray(u?.preferredCuisines) ? u.preferredCuisines : [];
  const distance = (typeof u?.searchDistance === "number" ? u.searchDistance : null);
  const budgetMax = (typeof u?.budgetMax === "number" ? u.budgetMax : null);
  const dietaryNeeds = Array.isArray(u?.dietaryNeeds) ? u.dietaryNeeds : [];

  return {
    id: u?.id,
    name: labelOfUser(u),
    prefs: { distance, budgetMax, dietaryNeeds, preferredCuisines },
  };
}

function cuisineMatches(r, needles) {
  if (!needles?.length) return true; // if none, don't filter
  const summary = String(r.editorialSummary || "").toLowerCase();
  const primary = String(r.primaryType || "").toLowerCase();
  const primaryDN = String(r.primaryTypeDisplayName || "").toLowerCase();
  const types = Array.isArray(r.types) ? r.types.map((t) => String(t).toLowerCase().replace(/_/g, " ")) : [];
  for (const k of needles) {
    const kk = k.toLowerCase();
    if (summary.includes(kk)) return true;
    if (primary.includes(kk)) return true;
    if (primaryDN.includes(kk)) return true;
    if (types.some((t) => t.includes(kk))) return true;
    if (String(r.name || "").toLowerCase().includes(kk)) return true;
  }
  return false;
}

async function fetchForUserAt({ user, loc, want, radiusKm }) {
  if (!loc) return [];

  // rough bounding box first to limit rows
  const dLat = radiusKm / 111;
  const dLng = radiusKm / (111 * Math.cos(deg2rad(loc.lat || 0)));

  const where = {
    latitude: { gte: (loc.lat - dLat), lte: (loc.lat + dLat) },
    longitude: { gte: (loc.lng - dLng), lte: (loc.lng + dLng) },
  };
  if (user.prefs?.budgetMax != null) {
    where.priceLevel = { lte: user.prefs.budgetMax };
  }

  const rows = await prisma.restaurant.findMany({
    where,
    select: {
      id: true, name: true, latitude: true, longitude: true,
      formattedAddress: true, priceLevel: true,
      primaryType: true, primaryTypeDisplayName: true, types: true,
      editorialSummary: true,
    },
    take: 200,
  });

  // normalize Decimal -> number
  const rowsNorm = rows.map((r) => ({
    ...r,
    latitude: (r.latitude == null ? null : Number(r.latitude)),
    longitude: (r.longitude == null ? null : Number(r.longitude)),
  }));

  const needles = expandUserCuisineKeywords(user.prefs?.preferredCuisines || []);
  const maxDist = (user.prefs?.distance ?? radiusKm) || radiusKm;

  const filtered = rowsNorm
    .map((r) => {
      const dist = (r.latitude != null && r.longitude != null)
        ? haversineKm({ lat: r.latitude, lng: r.longitude }, loc)
        : 9999;
      return { ...r, _dist: dist };
    })
    .filter((r) => r._dist <= maxDist)
    .filter((r) => cuisineMatches(r, needles));

  filtered.sort((a, b) => a._dist - b._dist);
  const pick = filtered.slice(0, want).map((r) => ({
    id: r.id, name: r.name, from: user.tag || "?",
  }));
  return pick;
}

async function getOrBuildSessionPool({ session, wantEach, radiusKm }) {
  // context shape: { locA, locB, poolIds:[], metaById:{id:{from:"A"|"B"}}, builtAt }
  const ctx = session.context || {};
  const aUser = await fetchUserPrefs(session.aUserId);
  const bUser = await fetchUserPrefs(session.bUserId);
  aUser.tag = "A";
  bUser.tag = "B";

  const locA = ctx.locA || null;
  const locB = ctx.locB || null;

  log("pool(start)", {
    sessionId: session.id,
    want: wantEach,
    aUser,
    bUser,
    locA, locB,
  });

  if (!locA && !locB) {
    log("pool(no-locations)", { sessionId: session.id });
    return { poolIds: [], metaById: {} };
  }

  // cache hit
  if (Array.isArray(ctx.poolIds) && ctx.poolIds.length) {
    log("pool(cache-hit)", { sessionId: session.id, poolCount: ctx.poolIds.length });
    return { poolIds: ctx.poolIds, metaById: ctx.metaById || {} };
  }

  const picks = [];
  if (locA) {
    const fromA = await fetchForUserAt({ user: aUser, loc: locA, want: wantEach, radiusKm });
    log("pool(A-picked)", fromA);
    picks.push(...fromA);
  }
  if (locB) {
    const fromB = await fetchForUserAt({ user: bUser, loc: locB, want: wantEach, radiusKm });
    log("pool(B-picked)", fromB);
    picks.push(...fromB);
  }

  // dedupe by id preserving first origin
  const metaById = {};
  const poolIds = [];
  for (const p of picks) {
    if (!metaById[p.id]) {
      metaById[p.id] = { from: p.from };
      poolIds.push(p.id);
    }
  }

  log("pool(combined)", { sessionId: session.id, total: poolIds.length, ids: poolIds });

  await prisma.groupSwipeSession.update({
    where: { id: session.id },
    data: { context: { ...ctx, poolIds, metaById, builtAt: new Date().toISOString() } },
  });

  return { poolIds, metaById };
}

// Build a top3 + winner from the session’s events
async function rankTop3(sessionId) {
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

  let items = Array.from(score.entries()).map(([rid, v]) => ({
    restaurantId: rid,
    s: v.s + (v.likedBy.size >= 2 ? 2 : 0),
    likedByCount: v.likedBy.size,
    last: v.last,
  }));

  const allZero = items.every((i) => i.s === 0);
  items.sort((a, b) => {
    if (b.s !== a.s) return b.s - a.s;
    if (b.likedByCount !== a.likedByCount) return b.likedByCount - a.likedByCount;
    return b.last - a.last;
  });
  if (allZero) items.sort((a, b) => b.last - a.last);

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

  const existing = await prisma.groupMatch.findUnique({ where: { sessionId: s.id } });
  if (existing) {
    await prisma.groupSwipeSession.update({
      where: { id: s.id },
      data: { status: "completed", endedAt: new Date() },
    });
    return { finalized: true, matchId: existing.id };
  }

  const { top, winner } = await rankTop3(s.id);
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

/** GET /api/group/requests */
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

// ─────────────────────────── Sessions ───────────────────────────

/** GET /api/group/sessions */
router.get("/sessions", async (req, res) => {
  try {
    const me = await getAuthedUserOr404(req.user.uid, res);
    if (!me) return;

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

/** POST /api/group/session/:id/start { lat, lng } — write locA/locB to context */
router.post("/session/:id/start", async (req, res) => {
  try {
    const me = await getAuthedUserOr404(req.user.uid, res);
    if (!me) return;

    const s = await prisma.groupSwipeSession.findUnique({
      where: { id: req.params.id },
      select: { id: true, aUserId: true, bUserId: true, context: true },
    });
    if (!s) return res.status(404).json({ error: "Session not found" });
    if (s.aUserId !== me.id && s.bUserId !== me.id) return res.status(403).json({ error: "Not in this session" });

    const { lat, lng } = req.body || {};
    if (typeof lat !== "number" || typeof lng !== "number") return res.json({ ok: true });

    const key = (s.aUserId === me.id) ? "locA" : "locB";
    const ctx = s.context || {};
    await prisma.groupSwipeSession.update({
      where: { id: s.id },
      data: { context: { ...ctx, [key]: { lat, lng } } },
    });
    log("start(set-loc)", { sessionId: s.id, userId: me.id, key, lat, lng });
    res.json({ ok: true });
  } catch (err) {
    console.error("[group/session/start] error:", err);
    res.status(500).json({ error: "failed to start session" });
  }
});

/** GET /api/group/session/:id/state → counts + next card */
router.get("/session/:id/state", async (req, res) => {
  try {
    const me = await getAuthedUserOr404(req.user.uid, res);
    if (!me) return;

    const s = await prisma.groupSwipeSession.findUnique({
      where: { id: req.params.id },
      select: { id: true, status: true, aUserId: true, bUserId: true, context: true },
    });
    if (!s) return res.status(404).json({ error: "Session not found" });
    if (s.aUserId !== me.id && s.bUserId !== me.id) return res.status(403).json({ error: "Not in this session" });

    // Optional: capture geo via headers
    const latHdr = req.header("X-Geo-Lat");
    const lngHdr = req.header("X-Geo-Lng");
    if (latHdr && lngHdr && !Number.isNaN(Number(latHdr)) && !Number.isNaN(Number(lngHdr))) {
      const key = (s.aUserId === me.id) ? "locA" : "locB";
      const ctx = s.context || {};
      ctx[key] = { lat: Number(latHdr), lng: Number(lngHdr) };
      await prisma.groupSwipeSession.update({
        where: { id: s.id },
        data: { context: ctx },
      });
      s.context = ctx;
      log("state(set-loc-from-headers)", { sessionId: s.id, key, lat: Number(latHdr), lng: Number(lngHdr) });
    }

    // maybe finalize first
    await maybeFinalizeSession(s.id);
    const s2 = await prisma.groupSwipeSession.findUnique({
      where: { id: s.id },
      select: { id: true, status: true, aUserId: true, bUserId: true, context: true },
    });
    if (!s2) return res.status(404).json({ error: "Session not found" });

    const { aCount, bCount, limit } = await getSessionCounts(s2.id, s2.aUserId, s2.bUserId);
    const youCount = s2.aUserId === me.id ? aCount : bCount;
    const partnerCount = s2.aUserId === me.id ? bCount : aCount;

    // build or fetch pool
    const { poolIds, metaById } = await getOrBuildSessionPool({
      session: s2,
      wantEach: DESIRED_MIN_POOL,
      radiusKm: RADIUS_KM_DEFAULT,
    });

    let next = null;
    if (s2.status === "active") {
      const idx = youCount;
      if (idx < poolIds.length) {
        const id = poolIds[idx];
        const r = await prisma.restaurant.findUnique({
          where: { id },
          select: {
            id: true, name: true, formattedAddress: true, priceLevel: true,
            primaryType: true, primaryTypeDisplayName: true, types: true,
            editorialSummary: true,
            latitude: true, longitude: true,
          },
        });
        if (r) {
          const rLat = (r.latitude == null ? null : Number(r.latitude));
          const rLng = (r.longitude == null ? null : Number(r.longitude));

          const myKey = (s2.aUserId === me.id) ? "locA" : "locB";
          const myLoc = s2.context?.[myKey] || null;
          let distance = null;
          if (myLoc && rLat != null && rLng != null) {
            distance = haversineKm(myLoc, { lat: rLat, lng: rLng });
          }
          next = {
            id: r.id,
            name: r.name,
            address: r.formattedAddress || null,
            priceLevel: r.priceLevel ?? null,
            primaryType: r.primaryType || null,
            primaryTypeDisplayName: r.primaryTypeDisplayName || null,
            types: r.types || null,
            editorialSummary: r.editorialSummary || null,
            editorial_summary: r.editorialSummary || null, // UI fallback key
            photoUrl: null, // not in schema; wire from Photos if needed
            distance,
            from: metaById?.[r.id]?.from || null,
          };
          log("nextCard", {
            sessionId: s2.id,
            userId: me.id,
            countForUser: youCount,
            idx,
            restaurant: { id: r.id, name: r.name },
            from: metaById?.[r.id]?.from || null,
          });
        }
      } else {
        log("state(no-next)", {
          sessionId: s2.id, youCount, limit, poolSize: poolIds.length,
          hasLocA: Boolean(s2.context?.locA), hasLocB: Boolean(s2.context?.locB),
        });
      }
    }

    res.json({
      status: s2.status,
      youCount,
      partnerCount,
      limit,
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

    await prisma.groupSwipeEvent.create({
      data: {
        sessionId: s.id,
        userId: me.id,
        restaurantId,
        action, // "LIKE" | "PASS" | "SUPERSTAR"
        position: countForUser + 1,
      },
    });

    log("feedback", {
      sessionId: s.id,
      userId: me.id,
      restaurantId,
      action,
      position: countForUser + 1,
    });

    await maybeFinalizeSession(s.id);
    res.json({ ok: true });
  } catch (err) {
    console.error("[group/session/feedback] error:", err);
    res.status(500).json({ error: "failed to record feedback" });
  }
});

// --- list group matches for the authed user ----------------------------
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
      },
    });
    const byId = new Map(restos.map((r) => [r.id, r]));

    const mapResto = (r) => {
      if (!r) return null;
      return {
        id: r.id,
        name: r.name,
        address: r.formattedAddress ?? null,
        priceLevel: r.priceLevel ?? null,
        primaryType: r.primaryTypeDisplayName || r.primaryType || null,
        types: r.types ?? null,
        editorialSummary: r.editorialSummary ?? null,
        editorial_summary: r.editorialSummary ?? null, // UI fallback
        photoUrl: null,
      };
    };

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
