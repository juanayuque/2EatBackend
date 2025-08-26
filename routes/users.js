// routes/users.js
const express = require("express");
const prisma = require("../src/prisma");
const verifyFirebaseToken = require("../middleware/auth");

const router = express.Router();

// Endpoint used to verify that mounting and reachability work over /api/users/*
router.get("/__ping", (_req, res) => res.json({ ok: true, via: "users.js", ts: Date.now() }));

// All endpoints below require a valid Firebase ID token.
// Using router-level middleware keeps route handlers focused on business logic.
router.use(verifyFirebaseToken);

// Returns current user's record (or null) without exposing unrelated fields.
router.get("/me", async (req, res) => {
  const uid = req.user.uid;
  const user = await prisma.user.findUnique({
    where: { firebaseUid: uid },
    select: {
      id: true,
      firebaseUid: true,
      email: true,
      displayName: true,
      photoUrl: true,
      emailVerified: true,
      searchDistance: true,
      budgetRange: true,
      dietaryNeeds: true,
      preferredCuisines: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  res.json({ user });
});

// Syncs minimal profile fields from the Firebase token.
// Upsert ensures the record exists and keeps basic profile info fresh.
router.post("/sync-profile", async (req, res) => {
  try {
    const { uid, email, name, picture, email_verified } = req.user;

    const user = await prisma.user.upsert({
      where: { firebaseUid: uid },
      update: {
        email: email ?? null,
        displayName: name ?? null,
        photoUrl: picture ?? null,
        emailVerified: !!email_verified,
        updatedAt: new Date(),
      },
      create: {
        firebaseUid: uid,
        email: email ?? null,
        displayName: name ?? null,
        photoUrl: picture ?? null,
        emailVerified: !!email_verified,
      },
    });

    res.json({
      ok: true,
      user: { id: user.id, firebaseUid: user.firebaseUid, email: user.email },
    });
  } catch (err) {
    console.error("User sync failed:", err);
    res.status(500).json({ error: "User sync error" });
  }
});

// Returns current preference fields for the signed-in user.
// Select keeps the payload small and focused on the preferences UI needs.
router.get("/preferences", async (req, res) => {
  const uid = req.user.uid;
  const prefs = await prisma.user.findUnique({
    where: { firebaseUid: uid },
    select: {
      searchDistance: true,
      budgetRange: true,          // BudgetLevel[]
      dietaryNeeds: true,         // string[]
      preferredCuisines: true,    // string[]
    },
  });

  res.json({
    preferences: prefs ?? {
      searchDistance: null,
      budgetRange: [],
      dietaryNeeds: [],
      preferredCuisines: [],
    },
  });
});

// Saves preferences. Accepts either a numeric budgetMax (0–100) or an enum.
// The schema stores an array of BudgetLevel — storing a single bucket keeps it simple.
router.post("/preferences", async (req, res) => {
  try {
    const uid = req.user.uid;
    const {
      searchDistance,          // number | "Unlimited"
      dietaryNeeds,            // string[]
      preferredCuisines,       // string[]
      budgetLevel,             // optional explicit enum
      budgetMax,               // optional number 0-100 (UI slider)
    } = req.body;

    let level = budgetLevel;
    if (!level && typeof budgetMax === "number") {
      if (budgetMax <= 15) level = "VERY_CHEAP";
      else if (budgetMax <= 30) level = "CHEAP";
      else if (budgetMax <= 60) level = "MODERATE";
      else if (budgetMax <= 100) level = "EXPENSIVE";
      else level = "VERY_EXPENSIVE";
    }

    // Normalizes “Unlimited” to null so queries can treat it as no cap.
    const normalizedDistance =
      searchDistance === "Unlimited" ? null : (typeof searchDistance === "number" ? searchDistance : null);

    const user = await prisma.user.upsert({
      where: { firebaseUid: uid },
      update: {
        searchDistance: normalizedDistance,
        budgetRange: level ? [level] : [],
        dietaryNeeds: Array.isArray(dietaryNeeds) ? dietaryNeeds : [],
        preferredCuisines: Array.isArray(preferredCuisines) ? preferredCuisines : [],
        updatedAt: new Date(),
      },
      create: {
        firebaseUid: uid,
        email: req.user.email ?? null,
        searchDistance: normalizedDistance,
        budgetRange: level ? [level] : [],
        dietaryNeeds: Array.isArray(dietaryNeeds) ? dietaryNeeds : [],
        preferredCuisines: Array.isArray(preferredCuisines) ? preferredCuisines : [],
      },
    });

    res.json({ ok: true, savedAt: user.updatedAt });
  } catch (err) {
    console.error("Save preferences failed:", err);
    res.status(500).json({ error: "Save preferences failed" });
  }
});

module.exports = router;

