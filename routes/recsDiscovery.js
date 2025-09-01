// routes/recsDiscovery.js
const express = require("express");
const prisma = require("../src/prisma");
const verifyFirebaseToken = require("../middleware/auth");
const { createPlacesService } = require("../src/services/placesService");

const places = createPlacesService({
  prisma,
  googleApiKey: process.env.GOOGLE_API_KEY || process.env.PLACES_API_KEY,
});

const router = express.Router();
router.use(verifyFirebaseToken);

// km → degrees helpers
const kmToDegLat = (km) => km / 111;
const kmToDegLng = (km, atLat) => km / (111 * Math.cos((atLat * Math.PI) / 180));

// Normalize cuisine labels
const clean = (s) => String(s || "").trim();

router.post("/discover-now", async (req, res) => {
  try {
    const uid = req.user.uid;
    let { lat, lng, maxNew = 20, preferredCuisines } = req.body || {};
    lat = Number(lat);
    lng = Number(lng);
    maxNew = Math.max(0, Math.min(50, Number(maxNew) || 20)); // simple guard

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

    // Queries: use cuisine terms as-is; rely on location bias for relevance
    const queries = Array.from(new Set(preferredCuisines));

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
    const placeById = new Map(); // googleId -> place object (from search)
    const seenIds = new Set();   // everything seen this run (avoid repeat DB checks)
    const newIds = new Set();    // ids confirmed NOT in DB
    const perCenter = [];        // diagnostics
    let attempts = 0;
    let zeroGrowthStreak = 0;

    // Fast DB existence check
    async function notInDb(ids) {
      if (!ids.length) return ids;
      const rows = await prisma.restaurant.findMany({
        where: { googlePlaceId: { in: ids.map(String) } },
        select: { googlePlaceId: true },
      });
      const existing = new Set(rows.map((r) => String(r.googlePlaceId)));
      return ids.filter((id) => !existing.has(String(id)));
    }

    for (const c of centers) {
      if (newIds.size >= maxNew) break;

      let centerNew = 0;
      let centerFresh = 0;

      for (const q of queries) {
        if (newIds.size >= maxNew) break;

        // Primary: Text Search on cuisine term with location bias
        let chunk = await places.googlePlacesSearchText(q, {
          lat: c.lat,
          lng: c.lng,
          radiusMeters: 3000,
          maxPages: 2,
        });
        attempts++;

        // Fallback: nearby generic restaurants if nothing came back
        if (!chunk || chunk.length === 0) {
          chunk = await places.googlePlacesSearchNearby(c.lat, c.lng, {
            radiusMeters: 3000,
            maxPages: 1,
            rankPreference: "POPULARITY",
            includedTypes: ["restaurant"],
          });
          attempts++;
        }

        // Fresh ids not yet seen in this run
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

      // Stop early if multiple centers yield no growth
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

    // Enrich each with Details if needed (missing photos/address/etc)
    const toIngest = [];
    for (const id of toIngestIds) {
      const base = placeById.get(id);
      if (!base) continue;

      const needsDetails =
        !base?.photos?.length ||
        !base?.formattedAddress ||
        !base?.primaryType ||
        !base?.editorialSummary;

      if (needsDetails) {
        try {
          // fetch full details (includes photos[].name with our field mask)
          const full = await places.fetchPlaceDetailsV1(id);
          toIngest.push({ ...base, ...full });
        } catch (e) {
          console.warn("[discover-now] details failed for", id, e?.message || e);
          toIngest.push(base); // still ingest minimal record
        }
      } else {
        toIngest.push(base);
      }
    }

    // Upsert into DB (photos included via Photo.connectOrCreate in service)
    let created = 0;
    if (toIngest.length) {
      const result = await places.upsertPlacesBatch(toIngest);
      created = typeof result === "number" ? result : (result?.created ?? 0);
      if (result?.createdIds?.length) {
        console.log("[discover-now] createdIds (first 5):", result.createdIds.slice(0, 5));
      }
    }

    const payload = {
      mode: "bias-new-v2",
      cuisinesUsed: preferredCuisines,
      queries,
      centersTried: perCenter,
      found: toIngest.length, // candidates attempted to ingest
      created,                // actually inserted/updated
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
