// routes/group.js
const express = require("express");
const prisma = require("../src/prisma");
const verifyFirebaseToken = require("../middleware/auth");

const router = express.Router();
router.use(verifyFirebaseToken);

// ─────────────────────────── Config ───────────────────────────
const SWIPE_LIMIT = 15; // target swipes per user
const WANT_PER_USER = 10; // try to build 10 from A + 10 from B
const DEFAULT_RADIUS_KM = 5;

// in-memory pool + per-user deck cache
const POOL_CACHE = new Map(); // sessionId -> { pool: [{id, from:'A'|'B'}], aBuiltAt, bBuiltAt }
const DECK_CACHE = new Map(); // `${sessionId}:${userId}` -> [restaurantId,...]

// ─────────────────────────── Helpers ───────────────────────────
const jlog = (label, obj) => {
  try {
    // stringify so nested arrays don’t collapse to [Array] in PM2 logs
    console.log(label, JSON.stringify(obj, null, 2));
  } catch {
    console.log(label, obj);
  }
};

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

// cuisine helpers (lightweight keyword expansion)
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
  fastfood: ["fast"],
};
function expandCuisineKeywords(prefs = []) {
  const set = new Set();
  for (const p of prefs) {
    const key = norm(p);
    const arr = CUISINE_KEYWORDS[key] || [key];
    arr.forEach((a) => set.add(a));
  }
  // store both spaced and underscored forms
  const underscored = [...set].map((k) => k.replace(/\s+/g, "_"));
  return { words: [...set], tags: underscored };
}

// rough bbox from radius (km)
function bboxFrom(lat, lng, radiusKm) {
  const dLat = radiusKm / 110.574;
  const dLng = radiusKm / (111.320 * Math.cos((lat * Math.PI) / 180) || 1);
  return {
    minLat: lat - dLat,
    maxLat: lat + dLat,
    minLng: lng - dLng,
    maxLng: lng + dLng,
  };
}

// distance (km)
function haversineKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h = sinDLat * sinDLat + Math.cos(la1) * Math.cos(la2) * sinDLng * sinDLng;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Fetch (with Prisma — no raw SQL) a small list near a given location using user prefs
async function fetchForUserAt({ user, lat, lng, want = WANT_PER_USER, radiusKm = DEFAULT_RADIUS_KM }) {
  // pull prefs
  const prefs = {
    distance: user.searchDistance ?? null,
    budgetMax: user.budgetMax ?? null,
    dietaryNeeds: Array.isArray(user.dietaryNeeds) ? user.dietaryNeeds : [],
    preferredCuisines: Array.isArray(user.preferredCuisines) ? user.preferredCuisines : [],
  };
  const cx = expandCuisineKeywords(prefs.preferredCuisines);
  const radius = Math.max(1, Math.min(25, prefs.distance ?? radiusKm));
  const box = bboxFrom(lat, lng, radius);

  // base filter by bbox
  const where = {
    latitude: { gte: box.minLat, lte: box.maxLat },
    longitude: { gte: box.minLng, lte: box.maxLng },
  };

  // cuisine filters — try matching either by array 'types' or textual primary fields
  const cuisineOr = [];
  if (cx.tags.length) {
    cuisineOr.push({ types: { hasSome: cx.tags } });
  }
  if (cx.words.length) {
    cuisineOr.push(
      { primaryType: { in: cx.words.map((w) => w.replace(/\s+/g, "_").toUpperCase()) } },
      ...cx.words.map((w) => ({
        primaryTypeDisplayName: { contains: w, mode: "insensitive" },
      }))
    );
  }
  if (cuisineOr.length) {
    where.OR = cuisineOr;
  }

  // NOTE: feel free to add price filtering based on your price mapping
  const candidates = await prisma.restaurant.findMany({
    where,
    take: Math.max(want * 3, 30), // overfetch then sort by distance
    select: {
      id: true,
      name: true,
      formattedAddress: true,
      priceLevel: true,
      primaryType: true,
      primaryTypeDisplayName: true,
      types: true,
      editorialSummary: true,
      allowsDogs: true,
      parkingOptions: true,
      latitude: true,
      longitude: true,
      photos: { take: 1, select: { name: true } },
    },
  });

  // rank by distance
  const withDist = candidates
    .map((r) => {
      const dist =
        typeof r.latitude === "number" && typeof r.longitude === "number"
          ? haversineKm({ lat, lng }, { lat: r.latitude, lng: r.longitude })
          : 9999;
      return { r, dist };
    })
    .sort((a, b) => a.dist - b.dist)
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
}

// Build or fetch a cached combined pool [{id, from:'A'|'B'}]
async function getOrBuildSessionPool(session, me) {
  const cache = POOL_CACHE.get(session.id);
  if (cache?.pool?.length) return cache.pool;

  // load users + context (locs)
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
      id: a?.id,
      name: a?.displayName || "A",
      prefs: {
        distance: a?.searchDistance ?? null,
        budgetMax: a?.budgetMax ?? null,
        dietaryNeeds: a?.dietaryNeeds || [],
        preferredCuisines: a?.preferredCuisines || [],
      },
    },
    bUser: {
      id: b?.id,
      name: b?.displayName || "B",
      prefs: {
        distance: b?.searchDistance ?? null,
        budgetMax: b?.budgetMax ?? null,
        dietaryNeeds: b?.dietaryNeeds || [],
        preferredCuisines: b?.preferredCuisines || [],
      },
    },
    locA,
    locB,
  });

  if (!locA && !locB) {
    jlog("[group] pool(no-locations)", { sessionId: session.id });
    POOL_CACHE.set(session.id, { pool: [] });
    return [];
  }

  let picksA = [];
  let picksB = [];
  if (locA && a) {
    picksA = await fetchForUserAt({
      user: a,
      lat: locA.lat,
      lng: locA.lng,
      want: WANT_PER_USER,
      radiusKm: DEFAULT_RADIUS_KM,
    });
    jlog("[group] pool(A-picked)", picksA.map((x) => ({ id: x.id, name: x.name, from: "A" })));
  }
  if (locB && b) {
    picksB = await fetchForUserAt({
      user: b,
      lat: locB.lat,
      lng: locB.lng,
      want: WANT_PER_USER,
      radiusKm: DEFAULT_RADIUS_KM,
    });
    jlog("[group] pool(B-picked)", picksB.map((x) => ({ id: x.id, name: x.name, from: "B" })));
  }

  // combine + dedupe, preserve A/B interleave
  const combined = [];
  const seen = new Set();
  const maxLen = Math.max(picksA.length, picksB.length);
  for (let i = 0; i < maxLen; i++) {
    const aRow = picksA[i];
    if (aRow && !seen.has(aRow.id)) {
      combined.push({ id: aRow.id, from: "A" });
      seen.add(aRow.id);
    }
    const bRow = picksB[i];
    if (bRow && !seen.has(bRow.id)) {
      combined.push({ id: bRow.id, from: "B" });
      seen.add(bRow.id);
    }
  }

  jlog("[group] pool(combined)", {
    sessionId: session.id,
    total: combined.length,
    ids: combined.map((x) => x.id),
  });

  POOL_CACHE.set(session.id, { pool: combined, aBuiltAt: new Date(), bBuiltAt: new Date() });
  return combined;
}

// Build a deterministic per-user deck order from pool
function getOrBuildDeck(sessionId, userId, pool) {
  const key = `${sessionId}:${userId}`;
  let deck = DECK_CACHE.get(key);
  if (!deck || deck.length !== pool.length) {
    // simple deterministic shuffle by userId hash
    let h = 0;
    for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) >>> 0;
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

// Next card for (session, user) from deck position = countForUser
async function computeNextForUser(session, userId) {
  const pool = await getOrBuildSessionPool(session);
  const deck = getOrBuildDeck(session.id, userId, pool);
  const countForUser = await prisma.groupSwipeEvent.count({ where: { sessionId: session.id, userId } });
  const idx = countForUser; // strictly advance; no clamping (prevents dupes)
  if (idx >= deck.length) {
    jlog("[group] state(no-next)", {
      sessionId: session.id,
      youCount: countForUser,
      limit: SWIPE_LIMIT,
      poolSize: deck.length,
    });
    return { next: null, idx, poolSize: deck.length, countForUser };
  }

  const id = deck[idx];
  const meta = (await getOrBuildSessionPool(session)).find((p) => p.id === id) || { from: null };
  const r = await prisma.restaurant.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      formattedAddress: true,
      priceLevel: true,
      primaryType: true,
      primaryTypeDisplayName: true,
      types: true,
      editorialSummary: true,
      allowsDogs: true,
      parkingOptions: true,
      latitude: true,
      longitude: true,
      photos: { take: 1, select: { name: true } },
    },
  });

  const card = r
    ? {
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
        photoUrl: r.photos?.[0]?.name ? `/api/recs/photo?name=${encodeURIComponent(r.photos[0].name)}&w=1200` : null,
      }
    : null;

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
          context: {}, // locations will be filled by /state calls from each user
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

/**
 * GET /api/group/session/:id/state
 * Optional headers to capture location:
 *   X-Geo-Lat, X-Geo-Lng   (numbers)
 * Returns: { status, youCount, partnerCount, limit, next }
 */
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

    // capture location if provided via headers
    const latH = req.header("X-Geo-Lat");
    const lngH = req.header("X-Geo-Lng");
    if (latH && lngH) {
      const lat = Number(latH);
      const lng = Number(lngH);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        const isA = s.aUserId === me.id;
        const key = isA ? "locA" : "locB";
        const ctx = s.context || {};
        const prev = ctx[key];
        const changed = !prev || prev.lat !== lat || prev.lng !== lng;
        if (changed) {
          await prisma.groupSwipeSession.update({
            where: { id: s.id },
            data: { context: { ...(ctx || {}), [key]: { lat, lng } } },
          });
          // invalidate pool cache so it can rebuild with both coords
          POOL_CACHE.delete(s.id);
          DECK_CACHE.delete(`${s.id}:${s.aUserId}`);
          DECK_CACHE.delete(`${s.id}:${s.bUserId}`);
        }
      }
    }

    // maybe finalize if both finished
    await maybeFinalizeSession(s.id);
    const fresh = await prisma.groupSwipeSession.findUnique({
      where: { id: s.id },
      select: { id: true, status: true, aUserId: true, bUserId: true, context: true },
    });

    const { aCount, bCount, limit } = await getSessionCounts(fresh.id, fresh.aUserId, fresh.bUserId);
    const you = fresh.aUserId === me.id ? aCount : bCount;
    const them = fresh.aUserId === me.id ? bCount : aCount;

    // compute next card for this user
    const { next } = await computeNextForUser(fresh, me.id);

    res.json({ status: fresh.status, youCount: you, partnerCount: them, limit, next });
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
      select: { id: true, status: true, aUserId: true, bUserId: true, context: true },
    });
    if (!s) return res.status(404).json({ error: "Session not found" });
    if (s.status !== "active") return res.status(400).json({ error: "Session not active" });
    if (s.aUserId !== me.id && s.bUserId !== me.id) return res.status(403).json({ error: "Not in this session" });

    // guard: if user already exhausted their deck, reject (prevents dupes)
    const pool = await getOrBuildSessionPool(s, me);
    const countForUser = await prisma.groupSwipeEvent.count({ where: { sessionId: s.id, userId: me.id } });
    if (countForUser >= pool.length) {
      return res.status(400).json({ error: "no_more_items" });
    }

    const position = countForUser + 1;

    jlog("[group] feedback", {
      sessionId: s.id,
      userId: me.id,
      restaurantId,
      action,
      position,
    });

    await prisma.groupSwipeEvent.create({
      data: {
        sessionId: s.id,
        userId: me.id,
        restaurantId,
        action, // "LIKE" | "PASS" | "SUPERSTAR"
        position,
      },
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
        editorial_summary: r.editorialSummary ?? null,
        photoUrl: null,
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
