// routes/group.js
const express = require("express");
const prisma = require("../src/prisma");
const verifyFirebaseToken = require("../middleware/auth");

const router = express.Router();
router.use(verifyFirebaseToken);

// ─────────────────────────── Config ───────────────────────────
const SWIPE_LIMIT = 15;            // target swipes per user
const WANT_PER_USER = 10;          // aim to pool this many per user
const DEFAULT_RADIUS_KM = 5;       // initial radius
const MAX_RADIUS_KM = 15;          // max radius while expanding
const RADIUS_STEP_KM = 3;          // step while expanding
const CUISINE_RELAX_THRESHOLD = 6; // if fewer than this, relax cuisine
const POOL_CACHE = new Map();      // sessionId -> { pool, aBuiltAt, bBuiltAt }
const DECK_CACHE = new Map();      // `${sessionId}:${userId}` -> [ids...]

// ─────────────────────────── Helpers ───────────────────────────
const jlog = (label, obj) => {
  try { console.log(label, JSON.stringify(obj, null, 2)); }
  catch { console.log(label, obj); }
};

async function getAuthedUserOr404(firebaseUid, res) {
  const user = await prisma.user.findUnique({ where: { firebaseUid } });
  if (!user) { res.status(404).json({ error: "User not found" }); return null; }
  return user;
}
const labelOfUser = (u) => u?.displayName?.trim() || u?.username?.trim() || (u?.email?.split("@")[0]) || "Friend";
const usernameOfUser = (u) => u?.username || null;

async function assertAreFriendsOr400(meId, otherUserId, res) {
  const a = await prisma.friend.findFirst({ where: { userId: meId, friendId: otherUserId }, select: { id: true } });
  const b = await prisma.friend.findFirst({ where: { userId: otherUserId, friendId: meId }, select: { id: true } });
  if (!a && !b) { res.status(400).json({ error: "You can only group-match with friends" }); return false; }
  return true;
}

async function getSessionCounts(sessionId, aUserId, bUserId) {
  const rows = await prisma.groupSwipeEvent.groupBy({
    by: ["userId"],
    where: { sessionId },
    _count: { _all: true },
  });
  const byUser = new Map(rows.map((r) => [r.userId, r._count._all]));
  return { aCount: byUser.get(aUserId) || 0, bCount: byUser.get(bUserId) || 0, limit: SWIPE_LIMIT };
}

// cuisine keywords
const norm = (s) => String(s || "").toLowerCase().replace(/[_\s-]+/g, " ").trim();
const CUISINE_KEYWORDS = {
  indian: ["indian"],
  chinese: ["chinese","szechuan","sichuan","cantonese","hunan"],
  italian: ["italian","pizza","pasta","sicilian","tuscan"],
  japanese: ["japanese","sushi","ramen","izakaya"],
  thai: ["thai"],
  mexican: ["mexican","taqueria","taco"],
  korean: ["korean","bbq"],
  american: ["american","burger","bbq","diner"],
  vietnamese: ["vietnamese","pho","banh mi","bahn mi"],
  mediterranean: ["mediterranean","greek","turkish","lebanese"],
  "middle eastern": ["middle eastern","lebanese","turkish","persian","iranian"],
  spanish: ["spanish","tapas"],
  french: ["french","brasserie"],
  greek: ["greek"],
  turkish: ["turkish"],
  lebanese: ["lebanese"],
  persian: ["persian","iranian"],
  fastfood: ["fast"],
};
function expandCuisineKeywords(prefs = []) {
  const set = new Set();
  for (const p of prefs) (CUISINE_KEYWORDS[norm(p)] || [norm(p)]).forEach((w) => set.add(w));
  const words = [...set];
  return { words, tags: words.map((w) => w.replace(/\s+/g, "_")) };
}

function bboxFrom(lat, lng, radiusKm) {
  const dLat = radiusKm / 110.574;
  const dLng = radiusKm / (111.320 * Math.cos((lat * Math.PI) / 180) || 1);
  return { minLat: lat - dLat, maxLat: lat + dLat, minLng: lng - dLng, maxLng: lng + dLng };
}
function haversineKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180, la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Core fetch with progressive relax
async function fetchForUserAt({ user, lat, lng, want = WANT_PER_USER, radiusKm = DEFAULT_RADIUS_KM }) {
  const prefs = {
    distance: user.searchDistance ?? null,
    budgetMax: user.budgetMax ?? null,
    dietaryNeeds: Array.isArray(user.dietaryNeeds) ? user.dietaryNeeds : [],
    preferredCuisines: Array.isArray(user.preferredCuisines) ? user.preferredCuisines : [],
  };
  const cx = expandCuisineKeywords(prefs.preferredCuisines);
  const initialRadius = Math.max(1, Math.min(MAX_RADIUS_KM, prefs.distance ?? radiusKm));

  // helper to run a query with options
  const run = async ({ radius, withCuisine }) => {
    const box = bboxFrom(lat, lng, radius);
    const where = {
      latitude: { gte: box.minLat, lte: box.maxLat },
      longitude: { gte: box.minLng, lte: box.maxLng },
    };
    if (withCuisine && (cx.tags.length || cx.words.length)) {
      const OR = [];
      if (cx.tags.length) OR.push({ types: { hasSome: cx.tags } }); // Postgres text[] column
      if (cx.words.length) {
        OR.push(
          { primaryType: { in: cx.words.map((w) => w.replace(/\s+/g,"_").toUpperCase()) } },
          ...cx.words.map((w) => ({ primaryTypeDisplayName: { contains: w, mode: "insensitive" } })),
          ...cx.words.map((w) => ({ editorialSummary: { contains: w, mode: "insensitive" } }))
        );
      }
      where.OR = OR;
    }
    const rows = await prisma.restaurant.findMany({
      where,
      take: Math.max(want * 3, 30),
      select: {
        id: true, name: true, formattedAddress: true, priceLevel: true,
        primaryType: true, primaryTypeDisplayName: true, types: true,
        editorialSummary: true, allowsDogs: true, parkingOptions: true,
        latitude: true, longitude: true,
        photos: { take: 1, select: { name: true } },
      },
    });
    const withDist = rows
      .map((r) => ({
        r,
        dist: (typeof r.latitude === "number" && typeof r.longitude === "number")
          ? haversineKm({ lat, lng }, { lat: r.latitude, lng: r.longitude })
          : 9999,
      }))
      .sort((a,b) => a.dist - b.dist)
      .slice(0, want);
    return withDist.map(({ r, dist }) => ({
      id: r.id,
      name: r.name,
      address: r.formattedAddress ?? null,
      priceLevel: r.priceLevel ?? null,
      primaryType: r.primaryType ?? null,
      primaryTypeDisplayName: r.primaryTypeDisplayName ?? null,
      types: r.types ?? null,
      editorialSummary: r.editorialSummary ?? null,
      editorial_summary: r.editorialSummary ?? null,
      allowsDogs: r.allowsDogs ?? null,
      parkingOptions: r.parkingOptions ?? null,
      distance: dist,
      photoUrl: r.photos?.[0]?.name ? `/api/recs/photo?name=${encodeURIComponent(r.photos[0].name)}&w=1200` : null,
    }));
  };

  // Stage 1: initial radius + cuisine
  let picks = await run({ radius: initialRadius, withCuisine: true });
  jlog("[group] pool(stage1)", { radius: initialRadius, withCuisine: true, got: picks.length });

  // Stage 2: expand radius (still with cuisine) until want or max
  if (picks.length < want) {
    for (let r = initialRadius + RADIUS_STEP_KM; r <= MAX_RADIUS_KM && picks.length < want; r += RADIUS_STEP_KM) {
      const more = await run({ radius: r, withCuisine: true });
      jlog("[group] pool(stage2)", { radius: r, withCuisine: true, got: more.length });
      // merge by id
      const seen = new Set(picks.map((x) => x.id));
      for (const m of more) if (!seen.has(m.id)) { picks.push(m); seen.add(m.id); }
    }
  }

  // Stage 3: if still low (< threshold), relax cuisine and try again (expand if needed)
  if (picks.length < CUISINE_RELAX_THRESHOLD) {
    const relaxed1 = await run({ radius: initialRadius, withCuisine: false });
    jlog("[group] pool(stage3)", { radius: initialRadius, withCuisine: false, got: relaxed1.length });
    const seen = new Set(picks.map((x) => x.id));
    for (const m of relaxed1) if (!seen.has(m.id)) { picks.push(m); seen.add(m.id); }

    for (let r = initialRadius + RADIUS_STEP_KM; r <= MAX_RADIUS_KM && picks.length < want; r += RADIUS_STEP_KM) {
      const more = await run({ radius: r, withCuisine: false });
      jlog("[group] pool(stage3+expand)", { radius: r, withCuisine: false, got: more.length });
      for (const m of more) if (!seen.has(m.id)) { picks.push(m); seen.add(m.id); }
    }
  }

  jlog("[group] pool(user-final)", { got: picks.length, want });

  // return up to want
  return picks.slice(0, want);
}

// Combine & dedupe pool for session
async function getOrBuildSessionPool(session) {
  const cache = POOL_CACHE.get(session.id);
  if (cache?.pool?.length) return cache.pool;

  const [a, b] = await Promise.all([
    prisma.user.findUnique({ where: { id: session.aUserId } }),
    prisma.user.findUnique({ where: { id: session.bUserId } }),
  ]);
  const ctx = session.context || {};
  const locA = ctx?.locA || null;
  const locB = ctx?.locB || null;

  jlog("[group] pool(start)", {
    sessionId: session.id,
    want: WANT_PER_USER,
    aUser: {
      id: a?.id, name: a?.displayName || "A",
      prefs: {
        distance: a?.searchDistance ?? null,
        budgetMax: a?.budgetMax ?? null,
        dietaryNeeds: a?.dietaryNeeds || [],
        preferredCuisines: a?.preferredCuisines || [],
      },
    },
    bUser: {
      id: b?.id, name: b?.displayName || "B",
      prefs: {
        distance: b?.searchDistance ?? null,
        budgetMax: b?.budgetMax ?? null,
        dietaryNeeds: b?.dietaryNeeds || [],
        preferredCuisines: b?.preferredCuisines || [],
      },
    },
    locA, locB,
  });

  if (!locA && !locB) {
    jlog("[group] pool(no-locations)", { sessionId: session.id });
    POOL_CACHE.set(session.id, { pool: [] });
    return [];
  }

  let picksA = [], picksB = [];
  if (locA && a) {
    picksA = await fetchForUserAt({ user: a, lat: locA.lat, lng: locA.lng, want: WANT_PER_USER, radiusKm: DEFAULT_RADIUS_KM });
    jlog("[group] pool(A-picked)", picksA.map((x) => ({ id: x.id, name: x.name, from: "A" })));
  }
  if (locB && b) {
    picksB = await fetchForUserAt({ user: b, lat: locB.lat, lng: locB.lng, want: WANT_PER_USER, radiusKm: DEFAULT_RADIUS_KM });
    jlog("[group] pool(B-picked)", picksB.map((x) => ({ id: x.id, name: x.name, from: "B" })));
  }

  const combined = [];
  const seen = new Set();
  const maxLen = Math.max(picksA.length, picksB.length);
  for (let i = 0; i < maxLen; i++) {
    const aRow = picksA[i]; if (aRow && !seen.has(aRow.id)) { combined.push({ id: aRow.id, from: "A" }); seen.add(aRow.id); }
    const bRow = picksB[i]; if (bRow && !seen.has(bRow.id)) { combined.push({ id: bRow.id, from: "B" }); seen.add(bRow.id); }
  }

  jlog("[group] pool(combined)", { sessionId: session.id, total: combined.length, ids: combined.map((x) => x.id) });
  POOL_CACHE.set(session.id, { pool: combined, aBuiltAt: new Date(), bBuiltAt: new Date() });
  return combined;
}

function getOrBuildDeck(sessionId, userId, pool) {
  const key = `${sessionId}:${userId}`;
  let deck = DECK_CACHE.get(key);
  if (!deck || deck.length !== pool.length) {
    let h = 0; for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) >>> 0;
    const ids = pool.map((p) => p.id);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = (h + i * 9301 + 49297) % (i + 1);
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    deck = ids;
    DECK_CACHE.set(key, deck);
  }
  return deck;
}

async function computeNextForUser(session, userId) {
  const pool = await getOrBuildSessionPool(session);
  const deck = getOrBuildDeck(session.id, userId, pool);
  const countForUser = await prisma.groupSwipeEvent.count({ where: { sessionId: session.id, userId } });
  const idx = countForUser;
  if (idx >= deck.length) {
    jlog("[group] state(no-next)", { sessionId: session.id, youCount: countForUser, limit: SWIPE_LIMIT, poolSize: deck.length });
    return { next: null, idx, poolSize: deck.length, countForUser };
  }
  const id = deck[idx];
  const meta = (await getOrBuildSessionPool(session)).find((p) => p.id === id) || { from: null };
  const r = await prisma.restaurant.findUnique({
    where: { id },
    select: {
      id: true, name: true, formattedAddress: true, priceLevel: true,
      primaryType: true, primaryTypeDisplayName: true, types: true,
      editorialSummary: true, allowsDogs: true, parkingOptions: true,
      photos: { take: 1, select: { name: true } },
    },
  });
  const card = r ? {
    id: r.id, name: r.name, address: r.formattedAddress ?? null, priceLevel: r.priceLevel ?? null,
    primaryType: r.primaryType ?? null, primaryTypeDisplayName: r.primaryTypeDisplayName ?? null,
    types: r.types ?? null, editorialSummary: r.editorialSummary ?? null, editorial_summary: r.editorialSummary ?? null,
    allowsDogs: r.allowsDogs ?? null, parkingOptions: r.parkingOptions ?? null,
    photoUrl: r.photos?.[0]?.name ? `/api/recs/photo?name=${encodeURIComponent(r.photos[0].name)}&w=1200` : null,
  } : null;

  jlog("[group] nextCard", {
    sessionId: session.id,
    userId,
    countForUser,
    idx,
    restaurant: card ? { id: card.id, name: card.name } : null,
    from: meta.from || null,
  });

  return { next: card, idx, poolSize: deck.length, countForUser };
}

// Ranking
async function rankTop3(sessionId) {
  const events = await prisma.groupSwipeEvent.findMany({
    where: { sessionId },
    select: { restaurantId: true, userId: true, action: true, createdAt: true },
  });
  if (!events.length) return { top: [], winner: null };
  const score = new Map();
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
    restaurantId: rid, s: v.s + (v.likedBy.size >= 2 ? 2 : 0), likedByCount: v.likedBy.size, last: v.last,
  }));
  const allZero = items.every((i) => i.s === 0);
  items.sort((a,b) => (b.s - a.s) || (b.likedByCount - a.likedByCount) || (b.last - a.last));
  if (allZero) items.sort((a,b) => b.last - a.last);
  const top = items.slice(0, 3).map((i) => i.restaurantId);
  return { top, winner: top[0] || null };
}

async function maybeFinalizeSession(sessionId) {
  const s = await prisma.groupSwipeSession.findUnique({
    where: { id: sessionId },
    select: { id: true, status: true, aUserId: true, bUserId: true },
  });
  if (!s || s.status !== "active") return { finalized: false };
  const { aCount, bCount } = await getSessionCounts(s.id, s.aUserId, s.bUserId);
  if (aCount < SWIPE_LIMIT || bCount < SWIPE_LIMIT) return { finalized: false };
  const existing = await prisma.groupMatch.findUnique({ where: { sessionId: s.id } });
  if (existing) {
    await prisma.groupSwipeSession.update({ where: { id: s.id }, data: { status: "completed", endedAt: new Date() } });
    return { finalized: true, matchId: existing.id };
  }
  const { top, winner } = await rankTop3(s.id);
  const [top1, top2, top3] = [top[0] || null, top[1] || null, top[2] || null];
  await prisma.$transaction(async (tx) => {
    await tx.groupSwipeSession.update({ where: { id: s.id }, data: { status: "completed", endedAt: new Date() } });
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

router.get("/requests", async (req, res) => {
  try {
    const me = await getAuthedUserOr404(req.user.uid, res); if (!me) return;
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
    res.json({
      incoming: incomingRows.map((r) => ({
        id: r.id, fromUserId: r.fromUserId, fromName: labelOfUser(r.fromUser), fromUsername: usernameOfUser(r.fromUser),
      })),
      outgoing: outgoingRows.map((r) => ({
        id: r.id, toUserId: r.toUserId, toName: labelOfUser(r.toUser), toUsername: usernameOfUser(r.toUser),
      })),
    });
  } catch (err) { console.error("[group/requests] error:", err); res.status(500).json({ error: "failed to load group requests" }); }
});

router.post("/request", async (req, res) => {
  try {
    const me = await getAuthedUserOr404(req.user.uid, res); if (!me) return;
    const friendId = req.body?.friendId;
    if (!friendId) return res.status(400).json({ error: "friendId required" });
    if (friendId === me.id) return res.status(400).json({ error: "Cannot group-match yourself" });
    const ok = await assertAreFriendsOr400(me.id, friendId, res); if (!ok) return;

    const pending = await prisma.groupRequest.findFirst({
      where: { status: "PENDING", OR: [{ fromUserId: me.id, toUserId: friendId }, { fromUserId: friendId, toUserId: me.id }] },
      select: { id: true },
    });
    if (pending) return res.json({ ok: true, requestId: pending.id });

    let gr;
    try {
      gr = await prisma.groupRequest.create({ data: { fromUserId: me.id, toUserId: friendId, status: "PENDING" }, select: { id: true } });
    } catch (e) {
      const existing = await prisma.groupRequest.findUnique({
        where: { fromUserId_toUserId: { fromUserId: me.id, toUserId: friendId } }, select: { id: true },
      });
      gr = existing
        ? await prisma.groupRequest.update({ where: { id: existing.id }, data: { status: "PENDING" }, select: { id: true } })
        : (() => { throw e })();
    }
    res.json({ ok: true, requestId: gr.id });
  } catch (err) { console.error("[group/request] error:", err); res.status(500).json({ error: "failed to create group request" }); }
});

router.post("/accept", async (req, res) => {
  try {
    const me = await getAuthedUserOr404(req.user.uid, res); if (!me) return;
    const requestId = req.body?.requestId;
    if (!requestId) return res.status(400).json({ error: "requestId required" });

    const gr = await prisma.groupRequest.findUnique({
      where: { id: requestId }, select: { id: true, fromUserId: true, toUserId: true, status: true },
    });
    if (!gr) return res.status(404).json({ error: "Request not found" });
    if (gr.toUserId !== me.id) return res.status(403).json({ error: "Not your request" });
    if (gr.status !== "PENDING") return res.status(400).json({ error: "Request is not pending" });

    await prisma.$transaction(async (tx) => {
      await tx.groupRequest.update({ where: { id: gr.id }, data: { status: "ACCEPTED" } });
      await tx.groupRequest.updateMany({
        where: { status: "PENDING", OR: [{ fromUserId: me.id, toUserId: gr.fromUserId }, { fromUserId: gr.fromUserId, toUserId: me.id }] },
        data: { status: "ACCEPTED" },
      });
      await tx.groupSwipeSession.create({
        data: { status: "active", startedById: me.id, aUserId: gr.fromUserId, bUserId: gr.toUserId, context: {} },
      });
    });
    res.json({ ok: true });
  } catch (err) { console.error("[group/accept] error:", err); res.status(500).json({ error: "failed to accept group request" }); }
});

router.post("/decline", async (req, res) => {
  try {
    const me = await getAuthedUserOr404(req.user.uid, res); if (!me) return;
    const requestId = req.body?.requestId;
    if (!requestId) return res.status(400).json({ error: "requestId required" });

    const gr = await prisma.groupRequest.findUnique({
      where: { id: requestId }, select: { id: true, fromUserId: true, toUserId: true, status: true },
    });
    if (!gr) return res.status(404).json({ error: "Request not found" });
    if (gr.toUserId !== me.id) return res.status(403).json({ error: "Not your request" });
    if (gr.status !== "PENDING") return res.status(400).json({ error: "Request is not pending" });

    await prisma.groupRequest.update({ where: { id: gr.id }, data: { status: "DECLINED" } });
    res.json({ ok: true });
  } catch (err) { console.error("[group/decline] error:", err); res.status(500).json({ error: "failed to decline group request" }); }
});

router.post("/cancel", async (req, res) => {
  try {
    const me = await getAuthedUserOr404(req.user.uid, res); if (!me) return;
    const requestId = req.body?.requestId;
    if (!requestId) return res.status(400).json({ error: "requestId required" });

    const gr = await prisma.groupRequest.findUnique({
      where: { id: requestId }, select: { id: true, fromUserId: true, status: true },
    });
    if (!gr) return res.status(404).json({ error: "Request not found" });
    if (gr.fromUserId !== me.id) return res.status(403).json({ error: "Not your outgoing request" });
    if (gr.status !== "PENDING") return res.status(400).json({ error: "Request is not pending" });

    await prisma.groupRequest.update({ where: { id: gr.id }, data: { status: "CANCELED" } });
    res.json({ ok: true });
  } catch (err) { console.error("[group/cancel] error:", err); res.status(500).json({ error: "failed to cancel group request" }); }
});

// ─────────────────────── Sessions & State ───────────────────────

// NEW: start – client can push lat/lng on join
router.post("/session/:id/start", async (req, res) => {
  try {
    const me = await getAuthedUserOr404(req.user.uid, res); if (!me) return;
    const s = await prisma.groupSwipeSession.findUnique({
      where: { id: req.params.id },
      select: { id: true, aUserId: true, bUserId: true, context: true },
    });
    if (!s) return res.status(404).json({ error: "Session not found" });
    if (s.aUserId !== me.id && s.bUserId !== me.id) return res.status(403).json({ error: "Not in this session" });

    const { lat, lng } = req.body || {};
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: "lat/lng required" });

    const key = s.aUserId === me.id ? "locA" : "locB";
    const ctx = s.context || {};
    await prisma.groupSwipeSession.update({
      where: { id: s.id },
      data: { context: { ...(ctx || {}), [key]: { lat, lng } } },
    });
    POOL_CACHE.delete(s.id);
    DECK_CACHE.delete(`${s.id}:${s.aUserId}`);
    DECK_CACHE.delete(`${s.id}:${s.bUserId}`);
    jlog("[group] start(set-loc)", { sessionId: s.id, userId: me.id, key, lat, lng });
    res.json({ ok: true });
  } catch (err) { console.error("[group/session/start] error:", err); res.status(500).json({ error: "failed to start session" }); }
});

// GET state (also accepts headers X-Geo-Lat/X-Geo-Lng to capture location)
router.get("/session/:id/state", async (req, res) => {
  try {
    const me = await getAuthedUserOr404(req.user.uid, res); if (!me) return;
    const s = await prisma.groupSwipeSession.findUnique({
      where: { id: req.params.id },
      select: { id: true, status: true, aUserId: true, bUserId: true, context: true },
    });
    if (!s) return res.status(404).json({ error: "Session not found" });
    if (s.aUserId !== me.id && s.bUserId !== me.id) return res.status(403).json({ error: "Not in this session" });

    const latH = req.header("X-Geo-Lat");
    const lngH = req.header("X-Geo-Lng");
    if (latH && lngH) {
      const lat = Number(latH), lng = Number(lngH);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        const key = s.aUserId === me.id ? "locA" : "locB";
        const ctx = s.context || {};
        const prev = ctx[key];
        if (!prev || prev.lat !== lat || prev.lng !== lng) {
          await prisma.groupSwipeSession.update({
            where: { id: s.id },
            data: { context: { ...(ctx || {}), [key]: { lat, lng } } },
          });
          POOL_CACHE.delete(s.id);
          DECK_CACHE.delete(`${s.id}:${s.aUserId}`);
          DECK_CACHE.delete(`${s.id}:${s.bUserId}`);
        }
      }
    }

    await maybeFinalizeSession(s.id);
    const fresh = await prisma.groupSwipeSession.findUnique({
      where: { id: s.id },
      select: { id: true, status: true, aUserId: true, bUserId: true, context: true },
    });
    const { aCount, bCount, limit } = await getSessionCounts(fresh.id, fresh.aUserId, fresh.bUserId);
    const you = fresh.aUserId === me.id ? aCount : bCount;
    const them = fresh.aUserId === me.id ? bCount : aCount;

    const { next } = await computeNextForUser(fresh, me.id);
    res.json({ status: fresh.status, youCount: you, partnerCount: them, limit, next });
  } catch (err) { console.error("[group/session/state] error:", err); res.status(500).json({ error: "failed to load state" }); }
});

router.post("/session/:id/feedback", async (req, res) => {
  try {
    const me = await getAuthedUserOr404(req.user.uid, res); if (!me) return;
    const { restaurantId, action } = req.body || {};
    if (!restaurantId || !action) return res.status(400).json({ error: "restaurantId and action required" });

    const s = await prisma.groupSwipeSession.findUnique({
      where: { id: req.params.id },
      select: { id: true, status: true, aUserId: true, bUserId: true, context: true },
    });
    if (!s) return res.status(404).json({ error: "Session not found" });
    if (s.status !== "active") return res.status(400).json({ error: "Session not active" });
    if (s.aUserId !== me.id && s.bUserId !== me.id) return res.status(403).json({ error: "Not in this session" });

    // don’t allow swiping beyond deck
    const pool = await getOrBuildSessionPool(s);
    const countForUser = await prisma.groupSwipeEvent.count({ where: { sessionId: s.id, userId: me.id } });
    if (countForUser >= pool.length) return res.status(400).json({ error: "no_more_items" });

    const position = countForUser + 1;
    jlog("[group] feedback", { sessionId: s.id, userId: me.id, restaurantId, action, position });

    await prisma.groupSwipeEvent.create({
      data: { sessionId: s.id, userId: me.id, restaurantId, action, position },
    });

    await maybeFinalizeSession(s.id);
    res.json({ ok: true });
  } catch (err) { console.error("[group/session/feedback] error:", err); res.status(500).json({ error: "failed to record feedback" }); }
});

// ─────────────────────── Matches list ───────────────────────

router.get("/matches", async (req, res) => {
  try {
    const me = await getAuthedUserOr404(req.user.uid, res); if (!me) return;
    const rows = await prisma.groupMatch.findMany({
      where: { OR: [{ hostUserId: me.id }, { friendUserId: me.id }] },
      orderBy: { createdAt: "desc" },
      select: {
        id: true, sessionId: true, createdAt: true, comment: true,
        winnerRestaurantId: true, top1RestaurantId: true, top2RestaurantId: true,
        top3RestaurantId: true, superStarRestaurantId: true,
      },
    });

    const ids = new Set();
    for (const r of rows) [r.winnerRestaurantId, r.top1RestaurantId, r.top2RestaurantId, r.top3RestaurantId, r.superStarRestaurantId]
      .filter(Boolean).forEach((id) => ids.add(id));

    const restos = await prisma.restaurant.findMany({
      where: { id: { in: Array.from(ids) } },
      select: {
        id: true, name: true, formattedAddress: true, priceLevel: true, primaryType: true,
        primaryTypeDisplayName: true, types: true, editorialSummary: true,
      },
    });
    const byId = new Map(restos.map((r) => [r.id, r]));

    const mapResto = (r) => r && ({
      id: r.id, name: r.name, address: r.formattedAddress ?? null,
      priceLevel: r.priceLevel ?? null,
      primaryType: r.primaryTypeDisplayName || r.primaryType || null,
      types: r.types ?? null,
      editorialSummary: r.editorialSummary ?? null,
      editorial_summary: r.editorialSummary ?? null,
      photoUrl: null,
    });

    res.json({
      matches: rows.map((m) => ({
        id: m.id, sessionId: m.sessionId, createdAt: m.createdAt, userComment: m.comment ?? null,
        winner: mapResto(byId.get(m.winnerRestaurantId)) || mapResto(byId.get(m.top1RestaurantId)),
        top1: mapResto(byId.get(m.top1RestaurantId)),
        top2: mapResto(byId.get(m.top2RestaurantId)),
        top3: mapResto(byId.get(m.top3RestaurantId)),
        superStar: mapResto(byId.get(m.superStarRestaurantId)),
        isGroup: true,
      })),
    });
  } catch (err) { console.error("[group/matches] error:", err); res.status(500).json({ error: "failed to load group matches" }); }
});

module.exports = router;
