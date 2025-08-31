// routes/group.js
const express = require("express");
const prisma = require("../src/prisma");
const verifyFirebaseToken = require("../middleware/auth");

const router = express.Router();
router.use(verifyFirebaseToken);

// ─────────────────────────── Config ───────────────────────────
const SWIPE_LIMIT = 15; // 15 swipes per user to finish
const DESIRED_MIN_POOL_HINT = Number(process.env.GROUP_MIN_POOL || 12); // loosened floor

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

// count per user (explicit & robust)
async function getSessionCounts(sessionId, aUserId, bUserId) {
  const [a, b] = await Promise.all([
    prisma.groupSwipeEvent.count({ where: { sessionId, userId: aUserId } }),
    prisma.groupSwipeEvent.count({ where: { sessionId, userId: bUserId } }),
  ]);
  return { aCount: a, bCount: b, limit: SWIPE_LIMIT };
}

// merge prefs for filters/radius (conservative)
function combinedUser(u1, u2) {
  const uniq = (arr) => Array.from(new Set((arr || []).filter(Boolean)));
  const minOr = (a, b) => (a == null ? b ?? null : b == null ? a ?? null : Math.min(a, b));
  const obj = {
    id: `${u1.id}+${u2.id}`,
    firebaseUid: u1.firebaseUid,
    searchDistance: minOr(u1.searchDistance ?? 5, u2.searchDistance ?? 5),
    budgetMax: minOr(u1.budgetMax ?? null, u2.budgetMax ?? null),
    dietaryNeeds: uniq([...(u1.dietaryNeeds || []), ...(u2.dietaryNeeds || [])]),
    preferredCuisines: uniq([...(u1.preferredCuisines || []), ...(u2.preferredCuisines || [])]),
    displayName: `${u1.displayName || "You"} & ${u2.displayName || "Friend"}`,
  };
  return obj;
}
function noStore(res) {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
}

// Pretty-print helpers for logs
function briefUser(u) {
  return {
    id: u?.id,
    name: u?.displayName || u?.username || (u?.email ? u.email.split("@")[0] : "User"),
    prefs: {
      distance: u?.searchDistance ?? null,
      budgetMax: u?.budgetMax ?? null,
      dietaryNeeds: (u?.dietaryNeeds || []).slice(0, 6),
      preferredCuisines: (u?.preferredCuisines || []).slice(0, 12),
    },
  };
}
function briefLoc(x) {
  if (!x || typeof x.lat !== "number" || typeof x.lng !== "number") return null;
  return { lat: Number(x.lat.toFixed(5)), lng: Number(x.lng.toFixed(5)) };
}
function briefRestos(arr, max = 10) {
  return (arr || []).slice(0, max).map((r) => (typeof r === "string" ? r : `${r.name || r.id}(${r.id})`));
}
// ───────── add near top of routes/group.js ─────────
const DESIRED_MIN_POOL_BOTH = 20;   // 10 from A + 10 from B
const DESIRED_MIN_POOL_SINGLE = 15; // if only one side has a location

// in-memory session pool cache
const sessionPoolCache = new Map(); // sessionId -> { items:[{id,name,...,__src:'A'|'B'}], builtAt:Date, hasLocA, hasLocB }

// tiny helpers
const uniqBy = (arr, keyFn) => {
  const seen = new Set();
  const out = [];
  for (const it of arr) {
    const k = keyFn(it);
    if (!seen.has(k)) { seen.add(k); out.push(it); }
  }
  return out;
};

// Fetch N restaurants for a given user at a given lat/lng (reuse your own selector if you have one)
async function fetchForUserAt(user, lat, lng, take) {
  // This is intentionally loose—replace with your own “preferred pool” builder if you have it.
  // We bias by distance and basic prefs (budget, vegetarian), but keep it light so we don’t starve the pool.
  const maxPrice = user?.budgetMax ?? null;

  // NOTE: if you already have a places/pool builder, call it here instead and return rows with {id,name,...}
  const rows = await prisma.$queryRawUnsafe(`
    SELECT id, name, formattedAddress, priceLevel, primaryType, types, editorialSummary
    FROM "Restaurant"
    ORDER BY random()
    LIMIT ${Number(Math.max(1, take))}
  `);

  return rows.map(r => ({
    id: r.id,
    name: r.name,
    formattedAddress: r.formattedAddress,
    priceLevel: r.priceLevel,
    primaryType: r.primaryType,
    types: r.types,
    editorialSummary: r.editorialSummary,
  }));
}

// Build (or reuse) a labeled pool for the session
async function getOrBuildSessionPool({ sessionId, aUser, bUser, locA, locB }) {
  const cache = sessionPoolCache.get(sessionId);
  if (cache) {
    console.log("[group] pool(cache-hit)", { sessionId, poolCount: cache.items.length });
    return cache;
  }

  const hasLocA = !!(locA && typeof locA.lat === "number" && typeof locA.lng === "number");
  const hasLocB = !!(locB && typeof locB.lat === "number" && typeof locB.lng === "number");

  console.log("[group] pool(start)", {
    sessionId,
    want: hasLocA && hasLocB ? DESIRED_MIN_POOL_BOTH : DESIRED_MIN_POOL_SINGLE,
    aUser: { id: aUser.id, name: aUser.displayName || aUser.username || "A", prefs: {
      distance: aUser.searchDistance ?? null,
      budgetMax: aUser.budgetMax ?? null,
      dietaryNeeds: aUser.dietaryNeeds ?? [],
      preferredCuisines: aUser.preferredCuisines ?? [],
    }},
    bUser: { id: bUser.id, name: bUser.displayName || bUser.username || "B", prefs: {
      distance: bUser.searchDistance ?? null,
      budgetMax: bUser.budgetMax ?? null,
      dietaryNeeds: bUser.dietaryNeeds ?? [],
      preferredCuisines: bUser.preferredCuisines ?? [],
    }},
    locA: hasLocA ? locA : null,
    locB: hasLocB ? locB : null,
  });

  if (!hasLocA && !hasLocB) {
    console.log("[group] pool(no-locations)", { sessionId });
    sessionPoolCache.set(sessionId, { items: [], builtAt: new Date(), hasLocA, hasLocB });
    return sessionPoolCache.get(sessionId);
  }

  const perSide = hasLocA && hasLocB ? Math.floor(DESIRED_MIN_POOL_BOTH / 2) : DESIRED_MIN_POOL_SINGLE;

  const aSide = hasLocA ? await fetchForUserAt(aUser, locA.lat, locA.lng, perSide) : [];
  const bSide = hasLocB ? await fetchForUserAt(bUser, locB.lat, locB.lng, perSide) : [];

  // label sources
  const labeledA = aSide.map(r => ({ ...r, __src: "A" }));
  const labeledB = bSide.map(r => ({ ...r, __src: "B" }));

  // dedupe by restaurant id, but keep the first source that contributed it
  const merged = uniqBy([...labeledA, ...labeledB], r => r.id);

  console.log("[group] pool(A)", {
    sessionId,
    count: labeledA.length,
    items: labeledA.slice(0, 20).map(r => ({ id: r.id, name: r.name })),
  });
  console.log("[group] pool(B)", {
    sessionId,
    count: labeledB.length,
    items: labeledB.slice(0, 20).map(r => ({ id: r.id, name: r.name })),
  });
  console.log("[group] pool(merged)", {
    sessionId,
    total: merged.length,
    fromA: labeledA.length,
    fromB: labeledB.length,
  });

  const payload = { items: merged, builtAt: new Date(), hasLocA, hasLocB };
  sessionPoolCache.set(sessionId, payload);
  return payload;
}

// Build (or reuse cached) 20-item pool = 10 near A + 10 near B
async function ensureSessionPool(session) {
  let ctx = session.context || {};
  const seed = ctx.seed || mkSeed(session.id);

  // Already cached?
  if (Array.isArray(ctx.poolIds) && ctx.poolIds.length >= 10) {
    console.info("[group] pool(cache-hit)", {
      sessionId: session.id,
      poolCount: ctx.poolIds.length,
    });
    return { ids: ctx.poolIds, seed, ctx };
  }

  // Load users + any stored locations
  const s = await prisma.groupSwipeSession.findUnique({
    where: { id: session.id },
    include: { aUser: true, bUser: true },
  });
  if (!s) {
    console.warn("[group] pool(session-missing)", { sessionId: session.id });
    return { ids: [], seed, ctx };
  }

  const duo = combinedUser(s.aUser, s.bUser);
  const radiusKm = radiusFromUser(duo);
  const want = Math.max(10, DESIRED_MIN_POOL_HINT);

  const locA = ctx.locA && typeof ctx.locA.lat === "number" && typeof ctx.locA.lng === "number" ? ctx.locA : null;
  const locB = ctx.locB && typeof ctx.locB.lat === "number" && typeof ctx.locB.lng === "number" ? ctx.locB : null;

  console.info("[group] pool(start)", {
    sessionId: session.id,
    want,
    radiusKm,
    aUser: briefUser(s.aUser),
    bUser: briefUser(s.bUser),
    locA: briefLoc(locA),
    locB: briefLoc(locB),
  });

  if (!locA && !locB) {
    console.warn("[group] pool(no-locations)", { sessionId: session.id });
    return { ids: [], seed, ctx };
  }

  async function pullAt(loc, tag) {
    const pool = await ensurePreferredPool({
      places,
      lat: loc.lat,
      lng: loc.lng,
      user: duo,
      desiredMin: want,
    });
    const ordered = orderPoolDeterministic(pool, session.id, seed);
    const slice = ordered.slice(0, 10);

    console.info("[group] pool(side)", {
      sessionId: session.id,
      side: tag,
      near: briefLoc(loc),
      returned: pool.length,
      taking: slice.length,
      sample: briefRestos(slice, 8),
    });

    return slice.map((r) => r.id);
  }

  let idsA = [];
  let idsB = [];
  if (locA) idsA = await pullAt(locA, "A");
  if (locB) idsB = await pullAt(locB, "B");

  const merged = Array.from(new Set([...idsA, ...idsB]));
  if (!merged.length) {
    console.warn("[group] pool(empty-merged)", { sessionId: session.id });
    return { ids: [], seed, ctx };
  }

  const det = orderPoolDeterministic(merged.map((id) => ({ id })), session.id, seed).map((x) => x.id);

  ctx = { ...ctx, seed, poolIds: det, radiusKm };
  await prisma.groupSwipeSession.update({ where: { id: session.id }, data: { context: ctx } });

  console.info("[group] pool(merged)", {
    sessionId: session.id,
    mergedCount: det.length,
    sample: det.slice(0, 10),
  });

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
  if (!r) {
    console.warn("[group] nextCard(restaurant-missing)", { sessionId: session.id, idx, id });
    return null;
  }

  const photoName = r.photos?.[0]?.name || null;
  const photoUrl = photoName
    ? `${BACKEND_PUBLIC_URL}/api/recs/photo?name=${encodeURIComponent(photoName)}&w=1200`
    : null;

  console.info("[group] nextCard", {
    sessionId: session.id,
    userId,
    countForUser,
    idx,
    restaurant: { id: r.id, name: r.name },
  });

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
  console.info("[group] rank(candidates)", {
    sessionId,
    count: candidateIds.length,
  });
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
    console.info("[group] rank(lightfm)", {
      sessionId,
      topSample: ranked.slice(0, 5),
    });
  } catch (e) {
    console.warn("[group] rank(lightfm-fallback)", {
      sessionId,
      reason: e?.message || "rank service error",
    });
    const weight = (a) => (a === "SUPERSTAR" ? 3 : a === "LIKE" ? 1 : 0);
    const m = new Map();
    for (const e of evts) m.set(e.restaurantId, (m.get(e.restaurantId) || 0) + weight(e.action));
    ranked = Array.from(candidateIds).sort((a, b) => (m.get(b) || 0) - (m.get(a) || 0));
  }

  const top = ranked.slice(0, 3);
  const winner = top[0] || null;
  console.info("[group] rank(result)", { sessionId, top, winner });
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
    console.info("[group] finalize(existing)", { sessionId: s.id, matchId: existing.id });
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

  console.info("[group] finalize(created)", { sessionId: s.id, winner: winner || top1 });
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

    console.info("[group] accept→session(created)", { requestId, by: me.id });
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
    console.info("[group] decline", { requestId, by: me.id });
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
    console.info("[group] cancel", { requestId, by: me.id });
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

    console.info("[group] start(loc-saved)", {
      sessionId: s.id,
      who: key,
      loc: briefLoc({ lat, lng }),
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("[group/session/start] error:", err);
    res.status(500).json({ error: "failed to save location" });
  }
});

/** GET /api/group/session/:id/state → progress + next card (and result when done) */
router.get("/session/:id/state", async (req, res) => {
  try {
    const me = await getAuthedUserOr404(req.user.uid, res);
    if (!me) return;

    const s = await prisma.groupSwipeSession.findUnique({
      where: { id: req.params.id },
      select: {
        id: true, status: true,
        aUserId: true, bUserId: true,
        aUser: { select: { id: true, displayName: true, username: true, email: true, searchDistance: true, budgetMax: true, dietaryNeeds: true, preferredCuisines: true } },
        bUser: { select: { id: true, displayName: true, username: true, email: true, searchDistance: true, budgetMax: true, dietaryNeeds: true, preferredCuisines: true } },
        context: true,
      },
    });
    if (!s) return res.status(404).json({ error: "Session not found" });
    if (s.aUserId !== me.id && s.bUserId !== me.id) return res.status(403).json({ error: "Not in this session" });

    // maybe finalize if both are done
    await maybeFinalizeSession(s.id);
    const after = await prisma.groupSwipeSession.findUnique({
      where: { id: s.id },
      select: { id: true, status: true, aUserId: true, bUserId: true, context: true },
    });

    const { aCount, bCount, limit } = await getSessionCounts(s.id, after.aUserId, after.bUserId);
    const you = after.aUserId === me.id ? aCount : bCount;
    const them = after.aUserId === me.id ? bCount : aCount;

    // Build or reuse the pool (labels with __src: 'A' | 'B')
    const locA = s.context?.locA || s.context?.a || s.context?.A || null;
    const locB = s.context?.locB || s.context?.b || s.context?.B || null;

    const pool = await getOrBuildSessionPool({
      sessionId: s.id,
      aUser: s.aUser,
      bUser: s.bUser,
      locA, locB,
    });

    // Restaurants the current user has already swiped in this session (skip duplicates)
    const yourSwipes = await prisma.groupSwipeEvent.findMany({
      where: { sessionId: s.id, userId: me.id },
      select: { restaurantId: true },
    });
    const seen = new Set(yourSwipes.map(e => e.restaurantId));

    // Pick the first pool item you haven't swiped yet (no clamping to the end!)
    const nextItem = pool.items.find(r => !seen.has(r.id)) || null;

    if (!nextItem || you >= SWIPE_LIMIT) {
      console.log("[group] state(no-next)", {
        sessionId: s.id,
        youCount: you,
        partnerCount: them,
        limit,
        hasLocA: !!locA,
        hasLocB: !!locB,
      });
      return res.json({
        status: after.status,
        youCount: you,
        partnerCount: them,
        limit,
        next: null,
      });
    }

    console.log("[group] nextCard", {
      sessionId: s.id,
      userId: me.id,
      countForUser: you,
      tried: pool.items.length,
      picked: { id: nextItem.id, name: nextItem.name, source: nextItem.__src },
    });

    // hydrate full card (photo, etc.)
    const full = await prisma.restaurant.findUnique({
      where: { id: nextItem.id },
      include: { photos: { take: 1 } },
    });

    const photoName = full?.photos?.[0]?.name || null;
    const photoUrl = photoName
      ? `${process.env.BACKEND_PUBLIC_URL || "https://2eatapp.com"}/api/recs/photo?name=${encodeURIComponent(photoName)}&w=1200`
      : null;

    const card = {
      id: full.id,
      name: full.name,
      address: full.formattedAddress,
      priceLevel: full.priceLevel ?? null,
      primaryType: full.primaryType,
      types: full.types,
      editorialSummary: full.editorialSummary || null,
      editorial_summary: full.editorialSummary || null,
      photoUrl,
      allowsDogs: full.allowsDogs ?? null,
      parkingOptions: full.parkingOptions ?? null,
    };

    return res.json({
      status: after.status,
      youCount: you,
      partnerCount: them,
      limit,
      next: card,
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
      console.info("[group] feedback(limit-reached)", { sessionId: s.id, userId: me.id });
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

    console.info("[group] feedback", {
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
      console.info("[group] swipe-alias(limit-reached)", { sessionId: s.id, userId: me.id });
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

    console.info("[group] swipe-alias", {
      sessionId: s.id,
      userId: me.id,
      restaurantId,
      action,
      position: countForUser + 1,
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
