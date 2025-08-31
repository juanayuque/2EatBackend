// routes/recsDiscovery.js
const express = require("express");
const prisma = require("../src/prisma");
const verifyFirebaseToken = require("../middleware/auth");
// Make sure you have a places service available here.
const places = require("../src/services/placesService"); // adjust if you attach it differently

const router = express.Router();
router.use(verifyFirebaseToken);

// km → degrees helpers
const kmToDegLat = (km) => km / 111;
const kmToDegLng = (km, atLat) => km / (111 * Math.cos((atLat * Math.PI) / 180));

// Normalize cuisine labels a bit
const clean = (s) => String(s || "").trim();

router.post("/discover-now", async (req, res) => {
  try {
    const uid = req.user.uid;
    let { lat, lng, maxNew = 20, preferredCuisines } = req.body || {};
    lat = Number(lat); lng = Number(lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: "lat/lng required" });
    }

    // Pull cuisines from DB if not provided by client
    if (!Array.isArray(preferredCuisines) || preferredCuisines.length === 0) {
      const u = await prisma.user.findUnique({
        where: { firebaseUid: uid },
        select: { preferredCuisines: true },
      });
      preferredCuisines = Array.isArray(u?.preferredCuisines) ? u.preferredCuisines : [];
    }
    preferredCuisines = preferredCuisines.map(clean).filter(Boolean);

    if (preferredCuisines.length === 0) {
      console.log("[discover-now] no preferred cuisines; skipping");
      return res.json({ mode: "bias-new-v2", cuisinesUsed: [], found: 0, created: 0, attempts: 0 });
    }

    // Queries: "<cuisine> restaurant"
    const queries = Array.from(new Set(preferredCuisines.map((c) => `${c} restaurant`)));

    // Centers to try (origin + offsets)
    const centers = [
      { lat, lng, note: "origin" },
      { lat, lng: lng + kmToDegLng(2, lat), note: "+2km east" },
      { lat, lng: lng - kmToDegLng(2, lat), note: "-2km west" },
      { lat: lat + kmToDegLat(2), lng, note: "+2km north" },
      { lat: lat - kmToDegLat(2), lng, note: "-2km south" },
      { lat, lng: lng + kmToDegLng(5, lat), note: "+5km east" },
      { lat, lng: lng - kmToDegLng(5, lat), note: "-5km west" },
    ];

    console.log("[discover-now] cuisines used:", preferredCuisines);
    console.log("[discover-now] queries:", queries);

    // Trackers
    const placeById = new Map();     // googleId -> place object
    const seenIds = new Set();       // everything we've seen from Google (avoid duplicate DB checks)
    const newIds = new Set();        // ids confirmed NOT in DB
    const perCenter = [];            // for diagnostics
    let attempts = 0;
    let zeroGrowthStreak = 0;

    // fast DB existence check
    async function notInDb(ids) {
      if (!ids.length) return ids;
      const rows = await prisma.restaurant.findMany({
        where: { id: { in: ids } }, // assumes DB uses Google place id as Restaurant.id
        select: { id: true },
      });
      const existing = new Set(rows.map((r) => r.id));
      return ids.filter((id) => !existing.has(id));
    }

    for (const c of centers) {
      if (newIds.size >= maxNew) break;

      let centerNew = 0;
      let centerFresh = 0;

      for (const q of queries) {
        if (newIds.size >= maxNew) break;

        // Text Search by cuisine query
        const chunk = await places.googlePlacesSearchText(q, {
          lat: c.lat,
          lng: c.lng,
          radiusMeters: 3000,
          maxPages: 2,
        });
        attempts++;

        // Fresh ids we haven't even seen this run
        const freshIds = [];
        for (const p of chunk || []) {
          const id = p?.id;
          if (!id) continue;
          placeById.set(id, p);
          if (!seenIds.has(id)) {
            seenIds.add(id);
            freshIds.push(id);
          }
        }

        centerFresh += freshIds.length;

        // Filter to only those not currently in DB
        const missing = await notInDb(freshIds);
        for (const id of missing) {
          if (newIds.size >= maxNew) break;
          newIds.add(id);
          centerNew++;
        }
      }

      perCenter.push({ note: c.note, fresh: centerFresh, newAdded: centerNew, totalNewSoFar: newIds.size });
      console.log(`[discover-now] ${c.note}: fresh=${centerFresh}, +new=${centerNew}, totalNew=${newIds.size}`);

      if (centerNew === 0) {
        zeroGrowthStreak++;
        if (zeroGrowthStreak >= 3) {
          console.log("[discover-now] stopping after 3 zero-growth centers");
          break;
        }
      } else {
        zeroGrowthStreak = 0;
      }
    }

    // Prepare up to maxNew new places to ingest
    const toIngestIds = Array.from(newIds).slice(0, maxNew);
    const toIngest = toIngestIds.map((id) => placeById.get(id)).filter(Boolean);

    let created = 0;
    if (toIngest.length) {
      // Persist only the NEW ones
      created = await places.upsertPlacesBatch(toIngest);
    }

    const payload = {
      mode: "bias-new-v2",
      cuisinesUsed: preferredCuisines,
      queries,
      centersTried: perCenter,
      found: toIngest.length, // truly NEW candidates we attempted to ingest
      created,                // actually inserted/updated by upsert
      attempts,
    };

    console.log("[discover-now] result:", payload);
    res.json(payload);
  } catch (err) {
    console.error("discover-now failed:", err);
    res.status(500).json({ error: "discover-now failed" });
  }
});

module.exports = router;
