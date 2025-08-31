// routes/me.js (or similar)
const express = require("express");
const prisma = require("../src/prisma");
const verifyFirebaseToken = require("../middleware/auth");

const router = express.Router();
router.use(verifyFirebaseToken);

function readLatLng(req) {
  const hLat = req.headers["x-geo-lat"];
  const hLng = req.headers["x-geo-lng"];
  const bLat = req.body?.lat;
  const bLng = req.body?.lng;
  const lat = Number(hLat ?? bLat);
  const lng = Number(hLng ?? bLng);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

router.post("/me/geo", async (req, res) => {
    console.log("[me/geo] hit", { ua: req.headers['user-agent'], at: new Date().toISOString() });
  try {
    const me = await prisma.user.findUnique({ where: { firebaseUid: req.user.uid } });
    if (!me) return res.status(404).json({ error: "User not found" });

    const coords = readLatLng(req);
    if (!coords) return res.status(400).json({ error: "lat/lng required" });

    // Optional: ignore updates that move <100m or within 2 minutes, etc.
    await prisma.user.update({
      where: { id: me.id },
      data: {
        lastLat: coords.lat,
        lastLng: coords.lng,
        lastGeoAt: new Date(),
        lastGeoSource: String(req.body?.source || "device"),
      },
    });

    res.json({ ok: true });
  } catch (e) {
    console.error("[me/geo] error:", e);
    res.status(500).json({ error: "failed" });
  }
});

module.exports = router;
