// routes/groupmatches.js
// Group matches: listing + finalization (DB-only). Uses your /api/photo proxy.

const express = require("express");
const prisma = require("../src/prisma");
const verifyFirebaseToken = require("../middleware/auth");

const router = express.Router();
router.use(verifyFirebaseToken);

// ───────── helpers ─────────
async function authedUser(firebaseUid) {
  return prisma.user.findUnique({ where: { firebaseUid } });
}

function toPhotoUrlFromRestaurant(r) {
  const name =
    r?.primaryPhotoName ||
    r?.photoName ||
    r?.photos?.[0]?.name ||
    null;
  return name ? `/api/photo?name=${encodeURIComponent(name)}&maxWidthPx=1200` : null;
}

function shapeResto(r) {
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    address: r.formattedAddress ?? r.address ?? null,
    priceLevel: r.priceLevel ?? null,
    primaryType: r.primaryType ?? null,
    types: Array.isArray(r.types) ? r.types : null,
    editorialSummary: r.editorialSummary ?? r.editorial_summary ?? null,
    editorial_summary: r.editorial_summary ?? r.editorialSummary ?? null,
    photoUrl: toPhotoUrlFromRestaurant(r),
  };
}

// ───────── GET /api/group/matches ─────────
router.get("/matches", async (req, res) => {
  try {
    const me = await authedUser(req.user.uid);
    if (!me) return res.status(404).json({ error: "User not found" });

    const sessions = await prisma.groupSwipeSession.findMany({
      where: {
        status: "completed",
        OR: [{ aUserId: me.id }, { bUserId: me.id }, { startedById: me.id }],
      },
      orderBy: { endedAt: "desc" },
      take: 50,
      include: { match: true },
    });

    const ids = new Set();
    for (const s of sessions) {
      const m = s.match;
      if (!m) continue;
      [m.winnerRestaurantId, m.superStarRestaurantId, m.top1RestaurantId, m.top2RestaurantId, m.top3RestaurantId]
        .filter(Boolean)
        .forEach((id) => ids.add(id));
    }

    const restos = ids.size
      ? await prisma.restaurant.findMany({
          where: { id: { in: Array.from(ids) } },
          include: { photos: { take: 1 } },
        })
      : [];

    const map = new Map(restos.map((r) => [r.id, shapeResto(r)]));

    const matches = sessions
      .filter((s) => !!s.match)
      .map((s) => {
        const m = s.match;
        const winner = (m.winnerRestaurantId && map.get(m.winnerRestaurantId)) || null;
        const top1 = (m.top1RestaurantId && map.get(m.top1RestaurantId)) || winner;
        const top2 = (m.top2RestaurantId && map.get(m.top2RestaurantId)) || null;
        const top3 = (m.top3RestaurantId && map.get(m.top3RestaurantId)) || null;
        const superStar = (m.superStarRestaurantId && map.get(m.superStarRestaurantId)) || null;

        return {
          id: m.id,
          sessionId: s.id,
          createdAt: (m.createdAt || s.endedAt || s.startedAt || new Date()).toISOString?.() ?? String(m.createdAt || s.endedAt || s.startedAt || new Date()),
          userComment: m.comment ?? null, // UI expects userComment
          winner,
          top1,
          top2,
          top3,
          superStar,
          isGroup: true,
        };
      });

    res.json({ matches });
  } catch (e) {
    console.error("[group/matches] error:", e);
    res.json({ matches: [] });
  }
});

// ───────── POST /api/group/matches/finalize ─────────
// Body: { sessionId, top3: [id,id,id], winnerRestaurantId, superStarRestaurantId?, comment? }
router.post("/matches/finalize", async (req, res) => {
  try {
    const me = await authedUser(req.user.uid);
    if (!me) return res.status(404).json({ error: "User not found" });

    const { sessionId, top3 = [], winnerRestaurantId, superStarRestaurantId = null, comment = null } = req.body || {};
    if (!sessionId || !winnerRestaurantId || !Array.isArray(top3) || top3.length === 0) {
      return res.status(400).json({ error: "sessionId, winnerRestaurantId, top3 required" });
    }

    const s = await prisma.groupSwipeSession.findUnique({
      where: { id: sessionId },
      select: { id: true, status: true, startedById: true, aUserId: true, bUserId: true },
    });
    if (!s) return res.status(404).json({ error: "Session not found" });

    const isParticipant = [s.startedById, s.aUserId, s.bUserId].some((u) => u && u === me.id);
    if (!isParticipant) return res.status(403).json({ error: "Not a participant" });

    const hostUserId = s.startedById || s.aUserId || s.bUserId;
    const friendUserId =
      hostUserId === s.aUserId ? s.bUserId ?? null :
      hostUserId === s.bUserId ? s.aUserId ?? null :
      s.aUserId || s.bUserId || null;

    await prisma.$transaction(async (tx) => {
      await tx.groupMatch.upsert({
        where: { sessionId: s.id },
        create: {
          sessionId: s.id,
          hostUserId,
          friendUserId,
          top1RestaurantId: top3[0],
          top2RestaurantId: top3[1] ?? null,
          top3RestaurantId: top3[2] ?? null,
          superStarRestaurantId,
          winnerRestaurantId,
          comment,
        },
        update: {
          top1RestaurantId: top3[0],
          top2RestaurantId: top3[1] ?? null,
          top3RestaurantId: top3[2] ?? null,
          superStarRestaurantId,
          winnerRestaurantId,
          comment,
        },
      });

      await tx.groupSwipeSession.update({
        where: { id: s.id },
        data: { status: "completed", endedAt: new Date() },
      });
    });

    // Winner payload for immediate UI
    const winner = await prisma.restaurant.findUnique({
      where: { id: winnerRestaurantId },
      include: { photos: { take: 1 } },
    });

    res.json({ ok: true, winner: shapeResto(winner) });
  } catch (e) {
    console.error("[group/matches/finalize] error:", e);
    res.status(500).json({ error: "finalize failed" });
  }
});

module.exports = router;
