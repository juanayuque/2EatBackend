// routes/group.js

const express = require("express");
const prisma = require("../src/prisma");
const verifyFirebaseToken = require("../middleware/auth");

const { getOrBuildSessionPool, clearPool, orderPoolDeterministic, } = require("../src/group/pool");
const { haversineKm, asFloat } = require("../src/utils/geo");

const router = express.Router();
router.use(verifyFirebaseToken);

const MAX_SWIPES = Number(process.env.GROUP_MAX_SWIPES || 15);
const END_ON_SUPERSTAR = process.env.END_ON_SUPERSTAR === "1";
const BACKEND_PUBLIC_URL = process.env.BACKEND_PUBLIC_URL || "https://2eatapp.com"; // used for photo URLs

// ───────────────────────── helpers ─────────────────────────

async function authedUser(firebaseUid) {
  return prisma.user.findUnique({ where: { firebaseUid } });
}

function prefsFromUser(u) {
  if (!u) return { distance: null, budgetMax: null, dietaryNeeds: [], preferredCuisines: [] };
  return {
    distance: u.searchDistance ?? null,
    budgetMax: u.budgetMax ?? null,
    dietaryNeeds: Array.isArray(u.dietaryNeeds) ? u.dietaryNeeds : [],
    preferredCuisines: Array.isArray(u.preferredCuisines) ? u.preferredCuisines : [],
  };
}

function extractLoc(ctx, key) {
  const c = (ctx && typeof ctx === "object" && ctx) || {};
  const v = c[key];
  if (!v || typeof v !== "object") return null;
  const lat = Number(v.lat);
  const lng = Number(v.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

async function putLocationInContext({ sessionId, key, lat, lng, by }) {
  if (!sessionId || !key || typeof lat !== "number" || typeof lng !== "number") {
    throw new Error("sessionId, key, lat, lng required");
  }
  const s = await prisma.groupSwipeSession.findUnique({
    where: { id: sessionId },
    select: { context: true },
  });
  const ctx = (s?.context && typeof s.context === "object" && s.context) || {};
  ctx[key] = { lat, lng, by, at: Date.now() };
  await prisma.groupSwipeSession.update({ where: { id: sessionId }, data: { context: ctx } });
}

function userABFromSession(session) {
  // A = aUser (or startedBy as fallback), B = bUser
  const userA = session.aUser || session.startedBy || null;
  const userB = session.bUser || null;
  return { userA, userB };
}

function tagForUserId(session, uid) {
  if (session.aUserId && session.aUserId === uid) return "A";
  if (session.bUserId && session.bUserId === uid) return "B";
  if (session.startedById && session.startedById === uid && !session.aUserId) return "A";
  return null;
}

// ───────────────────────── endpoints ─────────────────────────

// routes/group.js 

router.get("/sessions", async (req, res) => {
  try {
    const me = await prisma.user.findUnique({
      where: { firebaseUid: req.user.uid },
      select: { id: true, displayName: true, username: true },
    });
    if (!me) return res.status(404).json({ error: "User not found" });

    const rows = await prisma.groupSwipeSession.findMany({
      where: {
        status: "active",
        OR: [{ startedById: me.id }, { aUserId: me.id }, { bUserId: me.id }],
      },
      orderBy: { startedAt: "desc" },
      include: {
        aUser: { select: { id: true, displayName: true, username: true } },
        bUser: { select: { id: true, displayName: true, username: true } },
        startedBy: { select: { id: true } },
        events: { select: { userId: true }, orderBy: { createdAt: "asc" } },
      },
      take: 20,
    });

    const sessions = rows.map((s) => {
      // figure out my partner
      const meIsA = s.aUser?.id === me.id;
      const meIsB = s.bUser?.id === me.id;
      const partner =
        meIsA ? s.bUser :
        meIsB ? s.aUser :
        // fallback if only startedBy set:
        s.aUser?.id && s.aUser?.id !== me.id ? s.aUser :
        s.bUser?.id && s.bUser?.id !== me.id ? s.bUser :
        null;

      // counts
      const youCount = s.events.filter((e) => e.userId === me.id).length;
      const partnerCount = partner ? s.events.filter((e) => e.userId === partner.id).length : 0;

      return {
        id: s.id,
        partner: partner && {
          id: partner.id,
          name: partner.displayName || partner.username || "Friend",
          username: partner.username || null,
        },
        youCount,
        partnerCount,
        limit: MAX_SWIPES,
      };
    })
    // only return sessions where we could resolve a partner (UI expects it)
    .filter((x) => !!x.partner);

    res.json({ sessions });
  } catch (err) {
    console.error("[group/sessions] error:", err);
    res.status(500).json({ error: "failed" });
  }
});


// routes/group.js — replace your POST /session/:id/start handler

router.post("/session/:id/start", async (req, res) => {
  try {
    const me = await authedUser(req.user.uid);
    if (!me) return res.status(404).json({ error: "User not found" });

    const sessionId = String(req.params.id || "");
    const { key: rawKey, lat, lng } = req.body || {};

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: "lat/lng required" });
    }

    const s = await prisma.groupSwipeSession.findUnique({
      where: { id: sessionId },
      select: { id: true, aUserId: true, bUserId: true, startedById: true, context: true },
    });
    if (!s) return res.status(404).json({ error: "Session not found" });

    // Figure out whether caller is A or B (fallback: startedBy is A if aUserId not set)
    let inferredKey = null;
    if (s.aUserId && s.aUserId === me.id) inferredKey = "locA";
    else if (s.bUserId && s.bUserId === me.id) inferredKey = "locB";
    else if (!s.aUserId && s.startedById === me.id) inferredKey = "locA";

    const key = ["locA", "locB"].includes(String(rawKey)) ? rawKey : inferredKey;
    if (!key) return res.status(403).json({ error: "Not a participant" });

    // Update session context
    const ctx = (s.context && typeof s.context === "object" && s.context) || {};
    ctx[key] = { lat, lng, by: me.id, at: Date.now() };
    await prisma.groupSwipeSession.update({ where: { id: s.id }, data: { context: ctx } });

    // Also persist on user so we always have a fallback
    await prisma.user.update({
      where: { id: me.id },
      data: { lastLat: lat, lastLng: lng, lastGeoAt: new Date(), lastGeoSource: "group-start" },
    });

    // Clear cached pool so the next /state rebuilds using this fresh location
    clearPool(sessionId);

    return res.json({ ok: true, key });
  } catch (err) {
    console.error("[group/start] error:", err);
    res.status(400).json({ error: err.message || "start failed" });
  }
});


// GET /session/:id/state
router.get("/session/:id/state", async (req, res) => {
  try {
    const me = await authedUser(req.user.uid);
    if (!me) return res.status(404).json({ error: "User not found" });

    const sessionId = String(req.params.id || "");
    const session = await prisma.groupSwipeSession.findUnique({
      where: { id: sessionId },
      include: {
        events: { orderBy: { createdAt: "asc" } },
        aUser: true,
        bUser: true,
        startedBy: true,
      },
    });
    if (!session) return res.status(404).json({ error: "Session not found" });

    const allEvents = session.events || [];
    const youCount = allEvents.filter((e) => e.userId === me.id).length;
    const partnerCount = allEvents.length - youCount;

    // if completed, short-circuit
    if (session.status !== "active") {
      return res.json({
        status: session.status,
        youCount,
        partnerCount,
        limit: MAX_SWIPES,
        next: null,
      });
    }

    const { userA, userB } = userABFromSession(session);
    const aPrefs = prefsFromUser(userA);
    const bPrefs = prefsFromUser(userB);
    const youTag = tagForUserId(session, me.id) || "A"; // "A" or "B"

    const locA = extractLoc(session.context, "locA");
    const locB = extractLoc(session.context, "locB");

    // build/reuse the shared UNION pool
    const pool = await getOrBuildSessionPool({
      sessionId,
      prisma,
      aUser: {
        id: userA?.id,
        name: userA?.displayName || userA?.username || null,
        prefs: aPrefs,
        tag: "A",
        lastLat: userA?.lastLat,
        lastLng: userA?.lastLng,
      },
      bUser: {
        id: userB?.id,
        name: userB?.displayName || userB?.username || null,
        prefs: bPrefs,
        tag: "B",
        lastLat: userB?.lastLat,
        lastLng: userB?.lastLng,
      },
      locA,
      locB,
      want: MAX_SWIPES * 2, // build a bit more than we show
      log: console.log,
    });

    // Create the per-user view (same set, different order), cap to MAX_SWIPES
    const ordered = orderPoolDeterministic(pool.items, sessionId, youTag).slice(0, MAX_SWIPES);

    const idx = youCount;
    const nextBase = idx < ordered.length ? ordered[idx] : null;

    let next = null;
    if (nextBase) {
      // hydrate minimal display (photo)
      const r = await prisma.restaurant.findUnique({
        where: { id: nextBase.id },
        include: { photos: { take: 1 } },
      });
      const photoName = r?.photos?.[0]?.name || null;
      const photoUrl = photoName
        ? `${BACKEND_PUBLIC_URL}/api/recs/photo?name=${encodeURIComponent(photoName)}&w=1200`
        : null;

      next = {
        id: r?.id || nextBase.id,
        name: r?.name || nextBase.name,
        from: nextBase.from || null,
        photoUrl,
        priceLevel: r?.priceLevel ?? nextBase.priceLevel ?? null,
        primaryType: r?.primaryType || null,
        types: r?.types || nextBase.types || [],
        editorialSummary: r?.editorialSummary || null,
        servesVegetarianFood: r?.servesVegetarianFood ?? null,
        allowsDogs: r?.allowsDogs ?? null,
        hasParking:
          r?.parkingOptions && typeof r.parkingOptions === "object"
            ? Object.values(r.parkingOptions).some(Boolean)
            : false,
      };

      console.log("[group] nextCard", {
        sessionId,
        userId: me.id,
        countForUser: youCount,
        idx,
        restaurant: { id: next.id, name: next.name },
        from: next.from || null,
      });
    } else {
      console.log("[group] state(no-next)", {
        sessionId,
        youCount,
        partnerCount,
        limit: MAX_SWIPES,
        poolSize: ordered.length,
      });
    }

    res.set("Cache-Control", "no-store");
    return res.json({
      status: session.status,
      youCount,
      partnerCount,
      limit: MAX_SWIPES,
      next,
    });
  } catch (err) {
    console.error("[group/session/state] error:", err);
    res.status(500).json({ error: "state failed" });
  }
});


// helper: derive outcome from events
function computeGroupOutcome(events = [], { superstarWins = true } = {}) {
  let lastSuper = null;
  const byId = new Map();

  events.forEach((e, idx) => {
    const id = e.restaurantId;
    const pos = Number(e.position ?? idx + 1);
    const rec = byId.get(id) || { likes: 0, posSum: 0, firstPos: null, total: 0 };
    if (e.action === "LIKE" || e.action === "SUPERSTAR") {
      rec.likes += 1;
      rec.posSum += pos;
      if (rec.firstPos == null) rec.firstPos = pos;
    }
    if (e.action === "SUPERSTAR") lastSuper = id;
    rec.total += 1;
    byId.set(id, rec);
  });

  const rows = Array.from(byId.entries()); // [id, rec]

  // sort by: likes desc → posSum asc → firstPos asc
  rows.sort((a, b) => {
    const A = a[1], B = b[1];
    if (B.likes !== A.likes) return B.likes - A.likes;
    if ((A.posSum ?? 0) !== (B.posSum ?? 0)) return A.posSum - B.posSum;
    return (A.firstPos ?? 1e9) - (B.firstPos ?? 1e9);
  });

  const orderedIds = rows.map(([id]) => id);
  const winnerId = superstarWins && lastSuper ? lastSuper : (orderedIds[0] || null);

  return {
    winnerId,
    superStarId: lastSuper || null,
    top1: orderedIds[0] || null,
    top2: orderedIds[1] || null,
    top3: orderedIds[2] || null,
  };
}

router.post("/session/:sessionId/feedback", async (req, res) => {
  try {
    const me = await authedUser(req.user.uid);
    if (!me) return res.status(404).json({ error: "User not found" });

    const { sessionId } = req.params;
    let { restaurantId, action } = req.body || {};
    action = String(action || "").toUpperCase();

    if (!sessionId || !restaurantId || !["LIKE", "PASS", "SUPERSTAR"].includes(action)) {
      return res.status(400).json({ error: "sessionId, restaurantId, action required" });
    }

    const s = await prisma.groupSwipeSession.findUnique({
      where: { id: sessionId },
      include: { events: { orderBy: { createdAt: "asc" } } },
    });
    if (!s) return res.status(400).json({ error: "Invalid session" });
    if (s.status !== "active") return res.status(410).json({ ok: false, sessionCompleted: true });

    // Idempotency
    const last = s.events[s.events.length - 1];
    if (last && last.restaurantId === restaurantId && last.action === action) {
      return res.json({
        ok: true,
        duplicate: true,
        shouldRerank: false,
        shouldSuggestMatch: false,
        sessionCompleted: s.status !== "active",
      });
    }
    if (s.events.some((e) => e.restaurantId === restaurantId && e.action === action)) {
      return res.json({
        ok: true,
        duplicate: true,
        shouldRerank: false,
        shouldSuggestMatch: false,
        sessionCompleted: s.status !== "active",
      });
    }

    const isA = s.aUserId && me.id === s.aUserId;
    const isB = s.bUserId && me.id === s.bUserId;

    let sessionCompleted = false;
    let aSwipes = 0, bSwipes = 0;

    await prisma.$transaction(async (tx) => {
      // record event
      const position = (s.events?.length || 0) + 1;
      await tx.groupSwipeEvent.create({
        data: { sessionId, userId: me.id, restaurantId, action, position },
      });

      // bump counters
      const inc =
        isA ? { aSwipes: { increment: 1 } } :
        isB ? { bSwipes: { increment: 1 } } : {};
      if (Object.keys(inc).length) {
        await tx.groupSwipeSession.update({ where: { id: sessionId }, data: inc });
      }

      // fresh session + events
      const fresh = await tx.groupSwipeSession.findUnique({
        where: { id: sessionId },
        include: { events: { orderBy: { position: "asc" } } },
      });

      aSwipes = fresh?.aSwipes ?? 0;
      bSwipes = fresh?.bSwipes ?? 0;

      const reachedCap = aSwipes >= MAX_SWIPES && bSwipes >= MAX_SWIPES;
      const endNow = reachedCap || (END_ON_SUPERSTAR && action === "SUPERSTAR");

      if (endNow) {
        // compute outcome & persist GroupMatch
        const { winnerId, superStarId, top1, top2, top3 } = computeGroupOutcome(
          fresh?.events || [],
          { superstarWins: END_ON_SUPERSTAR }
        );

        // figure host/friend for your schema
        const hostUserId = fresh?.startedById || fresh?.aUserId || fresh?.bUserId || null;
        let friendUserId = null;
        if (hostUserId === fresh?.aUserId) friendUserId = fresh?.bUserId || null;
        else if (hostUserId === fresh?.bUserId) friendUserId = fresh?.aUserId || null;
        else friendUserId = fresh?.aUserId || fresh?.bUserId || null;

        await tx.groupMatch.upsert({
          where: { sessionId },
          create: {
            sessionId,
            hostUserId,
            friendUserId,
            top1RestaurantId: top1,
            top2RestaurantId: top2,
            top3RestaurantId: top3,
            superStarRestaurantId: superStarId,
            winnerRestaurantId: winnerId,
            comment: null,
          },
          update: {
            top1RestaurantId: top1,
            top2RestaurantId: top2,
            top3RestaurantId: top3,
            superStarRestaurantId: superStarId,
            winnerRestaurantId: winnerId,
          },
        });

        await tx.groupSwipeSession.update({
          where: { id: sessionId },
          data: { status: "completed", endedAt: new Date() },
        });

        sessionCompleted = true;
      }
    });

    // optional: clear any cached pool now that we’re done
    try { clearPool(sessionId); } catch {}

    const combinedNext = (aSwipes ?? 0) + (bSwipes ?? 0);
    const shouldRerank = combinedNext % 5 === 0;
    // we already finalize on complete, so only suggest match while in-progress
    const shouldSuggestMatch = false;

    return res.json({ ok: true, shouldRerank, shouldSuggestMatch, sessionCompleted });
  } catch (err) {
    console.error("[group/feedback] error:", err);
    res.status(500).json({ error: "feedback failed" });
  }
});


module.exports = router;
