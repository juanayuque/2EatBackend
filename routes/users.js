// routes/users.js
require("dotenv").config();

const express = require("express");
const prisma = require("../src/prisma");
const verifyFirebaseToken = require("../middleware/auth");

const router = express.Router();

/**
 * Mirrors Firebase profile into the local users table so downstream queries
 * can avoid calling Firebase Admin repeatedly.
 */
router.post("/sync-profile", verifyFirebaseToken, async (req, res) => {
  try {
    // Token has been verified by middleware; decoded claims are on req.user
    const {
      uid,
      email = null,
      name = null,
      picture = null,
      email_verified = false,
    } = req.user || {};

    const user = await prisma.user.upsert({
      where: { firebaseUid: uid },
      update: {
        email,
        displayName: name,
        photoUrl: picture,
        emailVerified: email_verified,
        updatedAt: new Date(),
      },
      create: {
        firebaseUid: uid,
        email,
        displayName: name,
        photoUrl: picture,
        emailVerified: email_verified,
      },
      select: {
        id: true,
        firebaseUid: true,
        email: true,
        displayName: true,
        photoUrl: true,
        emailVerified: true,
      },
    });

    return res.status(200).json({ message: "Profile synced", user });
  } catch (err) {
    console.error("User sync failed:", err);
    return res.status(500).json({ error: "User sync error" });
  }
});

// small ping to confirm the router is mounted
router.get("/__ping", (_req, res) => res.json({ ok: true }));

// read current prefs
router.get("/preferences", verifyFirebaseToken, async (req, res) => {
  const uid = req.user.uid;
  const user = await prisma.user.findUnique({
    where: { firebaseUid: uid },
    select: {
      firebaseUid: true,
      budgetMax: true,
      priceLevelStars: true,
      searchDistance: true,
      dietaryNeeds: true,
      preferredCuisines: true,
    },
  });
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json(user);
});

// upsert prefs
router.post("/preferences", verifyFirebaseToken, async (req, res) => {
  const uid = req.user.uid;
  const {
    budgetMax,           // number 0..100
    priceLevelStars,     // 0..4
    searchDistance,      // number (km) or null for unlimited
    dietaryNeeds,        // string[]
    preferredCuisines,   // string[]
  } = req.body || {};

  const saved = await prisma.user.upsert({
    where: { firebaseUid: uid },
    update: {
      budgetMax,
      priceLevelStars,
      searchDistance: searchDistance ?? null,
      dietaryNeeds: Array.isArray(dietaryNeeds) ? dietaryNeeds : [],
      preferredCuisines: Array.isArray(preferredCuisines) ? preferredCuisines : [],
    },
    create: {
      firebaseUid: uid,
      email: req.user.email ?? null,
      budgetMax: budgetMax ?? 0,
      priceLevelStars: priceLevelStars ?? 0,
      searchDistance: searchDistance ?? null,
      dietaryNeeds: Array.isArray(dietaryNeeds) ? dietaryNeeds : [],
      preferredCuisines: Array.isArray(preferredCuisines) ? preferredCuisines : [],
    },
  });

  res.json({ ok: true, preferences: saved });
});

module.exports = router;
