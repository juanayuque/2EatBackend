// routes/group.js

const express = require("express");
const prisma = require("../src/prisma");
const verifyFirebaseToken = require("../middleware/auth");

const { getOrBuildSessionPool, clearPool } = require("../src/group/pool");
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


// Save a location for A or B (locA / locB) into session.context
router.post("/session/:id/start", async (req, res) => {
  try {
    const me = await authedUser(req.user.uid);
    if (!me) return res.status(404).json({ error: "User not found" });

    const sessionId = String(req.params.id || "");
    const { key, lat, lng } = req.body || {};
    if (!["locA", "locB"].includes(String(key))) {
      return res.status(400).json({ error: "key must be locA or locB" });
    }
    await putLocationInContext({ sessionId, key, lat, lng, by: me.id });
    // Clear any cached pool so fresh loc is used on next state call.
    clearPool(sessionId);
    return res.json({ ok: true });
  } catch (err) {
    console.error("[group/start] error:", err);
    res.status(400).json({ error: err.message || "start failed" });
  }
});

// Current state + next card for *me* (stable based on my own counter)
router.get("/session/:id/state", async (req, res) => {
  try {
    const me = await authedUser(req.user.uid);
    if (!me) return res.status(404).json({ error: "User not found" });

    const sessionId = String(req.params.id || "");
    const session = await prisma.groupSwipeSession.findUnique({
      where: { id: sessionId },
      include: {
        events: { orderBy: { createdAt: "asc" } }, // for logging / fallback only
        aUser: true,
        bUser: true,
        startedBy: true,
      },
    });
    if (!session) return res.status(404).json({ error: "Session not found" });

    // Determine A/B and use per-user counters for stability (fallback to event counts if missing)
    const myTag = tagForUserId(session, me.id); // "A" | "B" | null
    const aSw = session.aSwipes ?? 0;
    const bSw = session.bSwipes ?? 0;

    const youCount =
      myTag === "A" ? aSw : myTag === "B" ? bSw : session.events.filter((e) => e.userId === me.id).length;
    const partnerCount =
      myTag === "A" ? bSw : myTag === "B" ? aSw : session.events.length - youCount;

    // Completed? Just return counters and no next.
    if (session.status !== "active") {
      return res.json({
        status: session.status,
        youCount,
        partnerCount,
        limit: MAX_SWIPES, // per-user cap exposed to UI
        next: null,
      });
    }

    const { userA, userB } = userABFromSession(session);
    const aPrefs = prefsFromUser(userA);
    const bPrefs = prefsFromUser(userB);

    const locA = extractLoc(session.context, "locA");
    const locB = extractLoc(session.context, "locB");

    // Build (or reuse) the combined pool from DB only
    const pool = await getOrBuildSessionPool({
      sessionId,
      prisma,
      aUser: { id: userA?.id, name: userA?.displayName || userA?.username || null, prefs: aPrefs, tag: "A" },
      bUser: { id: userB?.id, name: userB?.displayName || userB?.username || null, prefs: bPrefs, tag: "B" },
      locA,
      locB,
      want: 24, // you logged plenty—bump page size to match your needs
      log: console.log,
    });

    // Your personal index through the common pool is your counter.
    const idx = youCount;
    const nextItem = idx < pool.items.length ? pool.items[idx] : null;

    let nextPayload = null;

    if (nextItem) {
      // Hydrate details (including first photo name) for the single card
      const r = await prisma.restaurant.findUnique({
        where: { id: nextItem.id },
        include: { photos: { take: 1 } },
      });

      // Decide which location to measure from for *you*
      const myLoc = myTag === "A" ? locA : myTag === "B" ? locB : null;
      let distance = null;
      if (myLoc && r?.latitude != null && r?.longitude != null) {
        distance = haversineKm(
          myLoc,
          { lat: asFloat(r.latitude), lng: asFloat(r.longitude) }
        );
      }

      const photoName = r?.photos?.[0]?.name || null;
      const photoUrl = photoName
        ? `${BACKEND_PUBLIC_URL}/api/recs/photo?name=${encodeURIComponent(photoName)}&w=1200`
        : null; // <-- uses your existing photo proxy

      nextPayload = {
        id: nextItem.id,
        name: r?.name || nextItem.name || "",
        from: nextItem.from || null, // "A" | "B"
        address: r?.formattedAddress || null,
        priceLevel: r?.priceLevel ?? null,
        primaryType: r?.primaryType || null,
        types: r?.types || [],
        editorialSummary: r?.editorialSummary || null,
        editorial_summary: r?.editorialSummary || null, // backward compat if UI expects it
        photoUrl,
        distance,
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
        restaurant: { id: nextPayload.id, name: nextPayload.name },
        from: nextPayload.from || null,
      });
    } else {
      console.log("[group] state(no-next)", {
        sessionId,
        youCount,
        partnerCount,
        limit: MAX_SWIPES,
        poolSize: pool.items.length,
      });
    }

    res.set("Cache-Control", "no-store");
    return res.json({
      status: session.status,
      youCount,
      partnerCount,
      limit: MAX_SWIPES,
      next: nextPayload, // now fully hydrated with photoUrl and details
    });
  } catch (err) {
    console.error("[group/session/state] error:", err);
    res.status(500).json({ error: "state failed" });
  }
});

// Record feedback and bump the correct per-user counter
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

    // Idempotency: if last event matches exactly, no-op
    const last = s.events[s.events.length - 1];
    if (last && last.restaurantId === restaurantId && last.action === action) {
      return res.json({
        ok: true,
        duplicate: true,
        shouldRerank: false,
        shouldSuggestMatch: false,
        sessionCompleted: false,
      });
    }
    // Optional: if same restaurant+action exists anywhere, skip
    if (s.events.some((e) => e.restaurantId === restaurantId && e.action === action)) {
      return res.json({
        ok: true,
        duplicate: true,
        shouldRerank: false,
        shouldSuggestMatch: false,
        sessionCompleted: false,
      });
    }

    // Who is swiping? (A or B)
    const isA = s.aUserId && me.id === s.aUserId;
    const isB = s.bUserId && me.id === s.bUserId;

    const position = s.events.length + 1;
    let sessionCompleted = false;
    let aSwipes, bSwipes;

    await prisma.$transaction(async (tx) => {
      await tx.groupSwipeEvent.create({
        data: { sessionId, userId: me.id, restaurantId, action, position },
      });

      // Increment the right side
      const inc = isA
        ? { aSwipes: { increment: 1 } }
        : isB
          ? { bSwipes: { increment: 1 } }
          : {}; // if neither, don't bump counters (shouldn't happen for host/guest)

      if (Object.keys(inc).length) {
        await tx.groupSwipeSession.update({ where: { id: sessionId }, data: inc });
      }

      // Read fresh counters
      const fresh = await tx.groupSwipeSession.findUnique({
        where: { id: sessionId },
        select: { aSwipes: true, bSwipes: true },
      });
      aSwipes = fresh?.aSwipes ?? 0;
      bSwipes = fresh?.bSwipes ?? 0;

      // Completion logic:
      // end when BOTH users hit the per-user cap, or on SUPERSTAR if configured
      const reachedCap = aSwipes >= MAX_SWIPES && bSwipes >= MAX_SWIPES;
      const endNow = reachedCap || (END_ON_SUPERSTAR && action === "SUPERSTAR");

      if (endNow) {
        await tx.groupSwipeSession.update({
          where: { id: sessionId },
          data: { status: "completed", endedAt: new Date() },
        });
        sessionCompleted = true;
      }
    });

    const combinedNext = (aSwipes ?? 0) + (bSwipes ?? 0);
    const shouldRerank = combinedNext % 5 === 0;
    const shouldSuggestMatch = sessionCompleted || aSwipes >= MAX_SWIPES || bSwipes >= MAX_SWIPES;

    return res.json({ ok: true, shouldRerank, shouldSuggestMatch, sessionCompleted });
  } catch (err) {
    console.error("[group/feedback] error:", err);
    res.status(500).json({ error: "feedback failed" });
  }
});

module.exports = router;
