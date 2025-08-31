// routes/matches.js
const express = require("express");
const prisma = require("../src/prisma");
const verifyFirebaseToken = require("../middleware/auth");

const router = express.Router();
router.use(verifyFirebaseToken);

const BACKEND_PUBLIC_URL = (process.env.BACKEND_PUBLIC_URL || "https://2eatapp.com").replace(/\/+$/, "");

/** build photo url from first photo, if present */
function photoFor(photos) {
  const name = photos?.[0]?.name || null;
  return name ? `${BACKEND_PUBLIC_URL}/api/recs/photo?name=${encodeURIComponent(name)}&w=800` : null;
}

/** GET /api/matches
 *  Returns the user's match history, hydrated with restaurant basics & photos.
 */
router.get("/", async (req, res) => {
  try {
    const uid = req.user.uid;
    const user = await prisma.user.findUnique({ where: { firebaseUid: uid } });
    if (!user) return res.status(404).json({ error: "User not found" });

    const matches = await prisma.match.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    // collect all restaurant ids we need to hydrate
    const ids = new Set();
    for (const m of matches) {
      [m.top1RestaurantId, m.top2RestaurantId, m.top3RestaurantId, m.superStarRestaurantId, m.winnerRestaurantId]
        .filter(Boolean)
        .forEach((x) => ids.add(x));
    }

    const restos = await prisma.restaurant.findMany({
      where: { id: { in: Array.from(ids) } },
      include: { photos: { take: 1 } },
    });
    const byId = new Map(restos.map((r) => [r.id, r]));

    function pick(id) {
      if (!id) return null;
      const r = byId.get(id);
      if (!r) return null;
      return {
        id: r.id,
        name: r.name,
        address: r.formattedAddress,
        priceLevel: r.priceLevel ?? null,
        primaryType: r.primaryType,
        types: r.types,
        editorialSummary: r.editorialSummary || null,
        editorial_summary: r.editorialSummary || null,
        photoUrl: photoFor(r.photos),
        websiteUri: r.websiteUri,
        internationalPhoneNumber: r.internationalPhoneNumber,
      };
    }

    const payload = matches.map((m) => ({
      id: m.id,
      sessionId: m.sessionId,
      createdAt: m.createdAt,
      userComment: m.userComment || null,
      winner: pick(m.winnerRestaurantId) || pick(m.top1RestaurantId),
      top1: pick(m.top1RestaurantId),
      top2: pick(m.top2RestaurantId),
      top3: pick(m.top3RestaurantId),
      superStar: pick(m.superStarRestaurantId),
    }));

    res.json({ matches: payload });
  } catch (e) {
    console.error("[matches] list error:", e);
    res.status(500).json({ error: "failed_list" });
  }
});

/** PUT /api/matches/:id/comment  { comment: string }
 *  Saves/updates a single user comment on the match (per user).
 */
/** PUT /api/matches/:id/comment  { comment: string }
 *  Works for both solo Match and GroupMatch.
 *  Returns { ok: true, userComment }
 */
router.put("/:id/comment", async (req, res) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ error: "unauthorized" });

    const me = await prisma.user.findUnique({ where: { firebaseUid: uid } });
    if (!me) return res.status(404).json({ error: "User not found" });

    const { id } = req.params;
    const { comment } = req.body || {};
    if (typeof comment !== "string") {
      return res.status(400).json({ error: "comment required" });
    }
    const normalized = comment.trim() || null;

    // 1) Try SOLO match first
    const solo = await prisma.match.findUnique({ where: { id } });
    if (solo) {
      if (solo.userId !== me.id) {
        return res.status(403).json({ error: "Not your match" });
      }
      const updated = await prisma.match.update({
        where: { id },
        data: { userComment: normalized },
        select: { userComment: true },
      });
      return res.json({ ok: true, userComment: updated.userComment });
    }

    // 2) Try GROUP match
    const group = await prisma.groupMatch.findUnique({ where: { id } });
    if (group) {
      if (group.hostUserId !== me.id && group.friendUserId !== me.id) {
        return res.status(403).json({ error: "Not your group match" });
      }
      const updated = await prisma.groupMatch.update({
        where: { id },
        data: { comment: normalized },
        select: { comment: true },
      });
      // Normalize field name for the client
      return res.json({ ok: true, userComment: updated.comment ?? null });
    }

    // 3) Nothing found
    return res.status(404).json({ error: "Match not found" });
  } catch (e) {
    console.error("[matches] save comment error:", e);
    res.status(500).json({ error: "failed_save_comment" });
  }
});


module.exports = router;
