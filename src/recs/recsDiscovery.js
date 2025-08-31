// routes/recsDiscovery.js
const express = require("express");
const verifyFirebaseToken = require("../middleware/auth");
const prisma = require("../src/prisma");
const { discoverCuisinesIncremental } = require("../src/recs/discovery");

// ⚠️ Your Places service (adjust path as needed)
const places = require("../src/recs/places");

const router = express.Router();
router.use(verifyFirebaseToken);

// simple in-memory throttle
const locks = new Map();
const TTL_MS = 3 * 60 * 1000;

function makeTileKey(lat, lng, km = 2) {
  const step = km / 111.32;
  const qLat = Math.round(lat / step) * step;
  const qLng = Math.round(lng / step) * step;
  return `${qLat.toFixed(4)},${qLng.toFixed(4)}`;
}

router.post("/discover-now", async (req, res) => {
  try {
    const me = await prisma.user.findUnique({
      where: { firebaseUid: req.user.uid },
      select: {
        id: true,
        preferredCuisines: true,
        lastLat: true,
        lastLng: true,
      },
    });
    if (!me) return res.status(404).json({ error: "User not found" });

    const lat = Number(req.body?.lat ?? me.lastLat);
    const lng = Number(req.body?.lng ?? me.lastLng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: "lat/lng required or missing fallback" });
    }

    // cuisines-only bias
    const cuisines = Array.isArray(me.preferredCuisines) ? me.preferredCuisines : [];

    // throttle: user + coarse tile
    const tileKey = makeTileKey(lat, lng, 2);
    const lockKey = `${me.id}:${tileKey}`;
    const force = req.body?.force === true;

    const now = Date.now();
    const lock = locks.get(lockKey);
    if (!force && lock && lock.expiresAt > now) {
      return res.status(202).json({ ok: true, throttled: true, until: lock.expiresAt });
    }
    locks.set(lockKey, { expiresAt: now + TTL_MS });

    // Run immediately (await here so client can see counts; or fire-and-forget with setImmediate)
    const out = await discoverCuisinesIncremental(places, lat, lng, cuisines, {
      radiusMeters: 3500,
      maxPages: 2,
      targetNew: 20,
      log: console.log,
    });

    return res.status(202).json({ ok: true, tileKey, ...out });
  } catch (err) {
    console.error("[discover-now] error:", err);
    return res.status(500).json({ error: "discover failed" });
  }
});

module.exports = router;
