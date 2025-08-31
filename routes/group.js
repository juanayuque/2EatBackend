// routes/group.js
const express = require("express");
const router = express.Router();

const prisma = require("../src/prisma");
const verifyFirebaseToken = require("../middleware/auth");

// solo helpers we already have
const { ensurePreferredPool } = require("../src/recs/pool");
const { orderPoolDeterministic, mkSeed } = require("../src/recs/pagination");
const { haversineKm, asFloat } = require("../src/utils/geo");

// group service helpers (two-arg signature: (prisma, { ... }))
const {
  storeLocationForUser,
  getSessionCounts,
  maybeFinalizeSession,
} = require("../src/group/service");

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const BACKEND_PUBLIC_URL = process.env.BACKEND_PUBLIC_URL || "https://2eatapp.com";
const MAX_SWIPES = Number(process.env.GROUP_MAX_SWIPES || 15);
const END_ON_SUPERSTAR = process.env.END_ON_SUPERSTAR === "1";

// ──────────────────────────────────────────────────────────────
// auth for everything under /api/group
router.use(verifyFirebaseToken);

// small helpers
async function authedUser(firebaseUid) {
  return prisma.user.findUnique({ where: { firebaseUid } });
}

function combinedUser(uA, uB) {
  const uniq = (arr) => Array.from(new Set((arr || []).filter(Boolean)));
  const minOr = (a, b) => (a == null ? b ?? null : b == null ? a ?? null : Math.min(a, b));
  return {
    id: `${uA.id}+${uB.id}`,
    searchDistance: minOr(uA.searchDistance ?? 5, uB.searchDistance ?? 5),
    budgetMax: minOr(uA.budgetMax ?? null, uB.budgetMax ?? null),
    dietaryNeeds: uniq([...(uA.dietaryNeeds || []), ...(uB.dietaryNeeds || [])]),
    preferredCuisines: uniq([...(uA.preferredCuisines || []), ...(uB.preferredCuisines || [])]),
  };
}

function photoUrlFromRow(r) {
  const name = r?.photos?.[0]?.name || null;
  return name ? `${BACKEND_PUBLIC_URL}/api/recs/photo?name=${encodeURIComponent(name)}&w=1200` : null;
}

// Build the “A@locA + B@locB” pool (10 each), union, deterministic order
async function buildGroupPool({ session, wantPerUser = 10 }) {
  const { context = {}, aUser, bUser } = session;
  const locA = context.locA || null;
  const locB = context.locB || null;

  console.log(
    "[group] pool(start)",
    JSON.stringify(
      {
        sessionId: session.id,
        want: wantPerUser,
        aUser: {
          id: aUser?.id,
          name: aUser?.displayName || null,
          prefs: {
            distance: aUser?.searchDistance ?? null,
            budgetMax: aUser?.budgetMax ?? null,
            dietaryNeeds: aUser?.dietaryNeeds || [],
            preferredCuisines: aUser?.preferredCuisines || [],
          },
          tag: "A",
        },
        bUser: {
          id: bUser?.id,
          name: bUser?.displayName || null,
          prefs: {
            distance: bUser?.searchDistance ?? null,
            budgetMax: bUser?.budgetMax ?? null,
            dietaryNeeds: bUser?.dietaryNeeds || [],
            preferredCuisines: bUser?.preferredCuisines || [],
          },
          tag: "B",
        },
        locA,
        locB,
      },
      null,
      2
    )
  );

  if (!locA && !locB) {
    console.log("[group] pool(no-locations)", { sessionId: session.id });
    return [];
  }

  const picks = [];

  if (locA && aUser) {
    const listA = await ensurePreferredPool({
      places: { prisma, googleApiKey: GOOGLE_API_KEY },
      lat: locA.lat,
      lng: locA.lng,
      user: aUser,
      desiredMin: wantPerUser,
    });
    const tagA = listA.slice(0, wantPerUser).map((r) => ({ ...r, __from: "A" }));
    if (tagA.length) {
      console.log(
        "[group] pool(A-picked)",
        JSON.stringify(
          tagA.map((x) => ({ id: x.id, name: x.name, from: "A" })),
          null,
          2
        )
      );
    }
    picks.push(...tagA);
  }

  if (locB && bUser) {
    const listB = await ensurePreferredPool({
      places: { prisma, googleApiKey: GOOGLE_API_KEY },
      lat: locB.lat,
      lng: locB.lng,
      user: bUser,
      desiredMin: wantPerUser,
    });
    const tagB = listB.slice(0, wantPerUser).map((r) => ({ ...r, __from: "B" }));
    if (tagB.length) {
      console.log(
        "[group] pool(B-picked)",
        JSON.stringify(
          tagB.map((x) => ({ id: x.id, name: x.name, from: "B" })),
          null,
          2
        )
      );
    }
    picks.push(...tagB);
  }

  // de-dupe by id keeping the first origin
  const uni = [];
  const seen = new Set();
  for (const r of picks) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    uni.push(r);
  }

  // deterministic order
  const ordered = orderPoolDeterministic(uni, session.id, mkSeed(session.id));
  console.log(
    "[group] pool(combined)",
    JSON.stringify(
      {
        sessionId: session.id,
        total: ordered.length,
        ids: ordered.map((x) => x.id),
      },
      null,
      2
    )
  );
  return ordered;
}

// ──────────────────────────────────────────────────────────────
// List active group sessions for the current user
router.get("/sessions", async (req, res) => {
  try {
    const me = await authedUser(req.user.uid);
    if (!me) return res.status(404).json({ error: "User not found" });

    const sessions = await prisma.groupSwipeSession.findMany({
      where: {
        status: "active",
        OR: [{ aUserId: me.id }, { bUserId: me.id }],
      },
      orderBy: { startedAt: "desc" },
      include: {
        aUser: true,
        bUser: true,
      },
    });

    const rows = [];
    for (const s of sessions) {
      const partner =
        s.aUserId === me.id
          ? { id: s.bUser?.id, name: s.bUser?.displayName || s.bUser?.username || "Friend" }
          : { id: s.aUser?.id, name: s.aUser?.displayName || s.aUser?.username || "Friend" };

      const { youCount, partnerCount, limit } = await getSessionCounts(prisma, {
        sessionId: s.id,
        limit: MAX_SWIPES,
        meId: me.id,
      });

      rows.push({
        id: s.id,
        partner,
        youCount,
        partnerCount,
        limit,
      });
    }

    res.json({ sessions: rows });
  } catch (err) {
    console.error("[group/sessions] error:", err);
    res.status(500).json({ error: "sessions failed" });
  }
});

// Set user location for a session (locA or locB)
router.post("/session/:sessionId/start", async (req, res) => {
  try {
    const me = await authedUser(req.user.uid);
    if (!me) return res.status(404).json({ error: "User not found" });

    const sessionId = req.params.sessionId || req.body?.sessionId;
    const { key, lat, lng } = req.body || {};
    if (!sessionId || !key || typeof lat !== "number" || typeof lng !== "number") {
      return res.status(400).json({ error: "sessionId, key, lat, lng required" });
    }

    console.log(
      "[group] start(set-loc)",
      JSON.stringify({ sessionId, userId: me.id, key, lat, lng }, null, 2)
    );

    await storeLocationForUser(prisma, { sessionId, key, lat, lng });
    res.json({ ok: true });
  } catch (err) {
    console.error("[group/start] error:", err);
    res.status(500).json({ error: "start failed" });
  }
});

// Live state (and serve the next card inline to avoid dupes)
router.get("/session/:sessionId/state", async (req, res) => {
  try {
    const me = await authedUser(req.user.uid);
    if (!me) return res.status(404).json({ error: "User not found" });

    const sessionId = req.params.sessionId;

    const session = await prisma.groupSwipeSession.findUnique({
      where: { id: sessionId },
      include: {
        aUser: true,
        bUser: true,
        events: true,
      },
    });
    if (!session) return res.status(404).json({ error: "Session not found" });

    // finalize if both reached limit
    await maybeFinalizeSession(prisma, { sessionId, limit: MAX_SWIPES });

    const { youCount, partnerCount, limit } = await getSessionCounts(prisma, {
      sessionId,
      limit: MAX_SWIPES,
      meId: me.id,
    });

    // Always provide next card for *this* user based on their own count
    const pool = await buildGroupPool({ session, wantPerUser: 10 });
    const idx = youCount; // 0-based progression for this user
    let next = null;

    if (idx < pool.length) {
      const pick = pool[idx];
      const r = await prisma.restaurant.findUnique({
        where: { id: pick.id },
        include: { photos: { take: 1 } },
      });

      if (r) {
        const ctx = session.context || {};
        const useLat =
          (session.aUserId === me.id ? ctx?.locA?.lat : ctx?.locB?.lat) ??
          ctx?.locA?.lat ??
          ctx?.locB?.lat;
        const useLng =
          (session.aUserId === me.id ? ctx?.locA?.lng : ctx?.locB?.lng) ??
          ctx?.locA?.lng ??
          ctx?.locB?.lng;

        const distance =
          typeof useLat === "number" && typeof useLng === "number"
            ? haversineKm(
                { lat: useLat, lng: useLng },
                { lat: asFloat(r.latitude), lng: asFloat(r.longitude) }
              )
            : null;

        next = {
          id: r.id,
          name: r.name,
          address: r.formattedAddress,
          priceLevel: r.priceLevel ?? null,
          distance,
          photoUrl: photoUrlFromRow(r),
          primaryType: r.primaryType,
          primaryTypeDisplayName: r.primaryTypeDisplayName || null,
          types: r.types,
          editorialSummary: r.editorialSummary || null,
          editorial_summary: r.editorialSummary || null,
          allowsDogs: r.allowsDogs ?? null,
          parkingOptions: r.parkingOptions || null,
          from: pick.__from || null, // "A" or "B"
        };

        console.log(
          "[group] nextCard",
          JSON.stringify(
            {
              sessionId,
              userId: me.id,
              countForUser: youCount,
              idx,
              restaurant: { id: r.id, name: r.name },
              from: pick.__from || null,
            },
            null,
            2
          )
        );
      }
    }

    const hasLocA = !!session.context?.locA;
    const hasLocB = !!session.context?.locB;

    if (!next) {
      console.log(
        "[group] state(no-next)",
        JSON.stringify(
          {
            sessionId,
            youCount,
            partnerCount,
            limit,
            poolSize: pool.length,
            hasLocA,
            hasLocB,
          },
          null,
          2
        )
      );
    }

    res.set("Cache-Control", "no-store");
    res.json({
      status: session.status,
      youCount,
      partnerCount,
      limit,
      hasLocA,
      hasLocB,
      next: next || null,
    });
  } catch (err) {
    console.error("[group/session/state] error:", err);
    res.status(500).json({ error: "state failed" });
  }
});

// Record feedback (LIKE | PASS | SUPERSTAR) for current user
router.post("/session/:sessionId/feedback", async (req, res) => {
  try {
    const me = await authedUser(req.user.uid);
    if (!me) return res.status(404).json({ error: "User not found" });

    const sessionId = req.params.sessionId || req.body?.sessionId;
    let { restaurantId, action } = req.body || {};
    action = String(action || "").toUpperCase();

    if (!sessionId || !restaurantId || !["LIKE", "PASS", "SUPERSTAR"].includes(action)) {
      return res.status(400).json({ error: "sessionId, restaurantId, action required" });
    }

    const s = await prisma.groupSwipeSession.findUnique({
      where: { id: sessionId },
      include: { events: { orderBy: { createdAt: "asc" } } },
    });
    if (!s) return res.status(404).json({ error: "Session not found" });
    if (s.status !== "active") return res.status(410).json({ ok: false, sessionCompleted: true });

    // Only allow A or B to act on their session
    if (s.aUserId !== me.id && s.bUserId !== me.id) {
      return res.status(403).json({ error: "Not a participant" });
    }

    // Idempotency: if last event equals this one, no-op
    const last = s.events[s.events.length - 1];
    if (last && last.userId === me.id && last.restaurantId === restaurantId && last.action === action) {
      return res.json({
        ok: true,
        duplicate: true,
        shouldRerank: false,
        shouldSuggestMatch: false,
        sessionCompleted: false,
      });
    }

    // Optional stronger idempotency
    const already = s.events.find(
      (e) => e.userId === me.id && e.restaurantId === restaurantId && e.action === action
    );
    if (already) {
      return res.json({
        ok: true,
        duplicate: true,
        shouldRerank: false,
        shouldSuggestMatch: false,
        sessionCompleted: false,
      });
    }

    const position = s.events.length + 1;
    let sessionCompleted = false;

    console.log(
      "[group] feedback",
      JSON.stringify({ sessionId, userId: me.id, restaurantId, action, position }, null, 2)
    );

    await prisma.$transaction(async (tx) => {
      await tx.groupSwipeEvent.create({
        data: { sessionId, userId: me.id, restaurantId, action, position },
      });

      const updated = await tx.groupSwipeSession.update({
        where: { id: sessionId },
        data: { totalSwipes: { increment: 1 } },
        select: { totalSwipes: true },
      });

      const reached = (updated.totalSwipes ?? position) >= MAX_SWIPES;
      const endNow = reached || (END_ON_SUPERSTAR && action === "SUPERSTAR");
      if (endNow) {
        await tx.groupSwipeSession.update({
          where: { id: sessionId },
          data: { status: "completed", endedAt: new Date() },
        });
        sessionCompleted = true;
      }
    });

    // Optionally finalize if both have finished
    await maybeFinalizeSession(prisma, { sessionId, limit: MAX_SWIPES });

    const nextCount = (s.totalSwipes ?? s.events.length) + 1;
    const shouldRerank = nextCount % 5 === 0;
    const shouldSuggestMatch = sessionCompleted || nextCount >= MAX_SWIPES;

    res.json({ ok: true, shouldRerank, shouldSuggestMatch, sessionCompleted });
  } catch (err) {
    console.error("[group/feedback] error:", err);
    res.status(500).json({ error: "feedback failed" });
  }
});

// Minimal group matches list (so /api/group/matches doesn't 404 for the UI comments fetch)
router.get("/matches", async (req, res) => {
  try {
    const me = await authedUser(req.user.uid);
    if (!me) return res.status(404).json({ error: "User not found" });

    const ms = await prisma.groupMatch.findMany({
      where: { OR: [{ hostUserId: me.id }, { friendUserId: me.id }] },
      orderBy: { createdAt: "desc" },
      take: 20,
    });

    res.json({
      matches: ms.map((m) => ({
        id: m.id,
        sessionId: m.sessionId,
        top1: { id: m.top1RestaurantId },
        top2: m.top2RestaurantId ? { id: m.top2RestaurantId } : null,
        top3: m.top3RestaurantId ? { id: m.top3RestaurantId } : null,
        winner: { id: m.winnerRestaurantId },
        comment: m.comment || null,
        createdAt: m.createdAt,
      })),
    });
  } catch (err) {
    console.error("[group/matches] error:", err);
    res.status(500).json({ error: "matches failed" });
  }
});

module.exports = router;

