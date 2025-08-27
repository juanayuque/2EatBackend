// routes/users.js
require('dotenv').config();
const express = require("express");
const prisma = require("../src/prisma");
const verifyFirebaseToken = require("../middleware/auth");

const router = express.Router();

/* ───────────────────────────── helpers / coercion ───────────────────────────── */

// Trims an incoming array of strings; ignores non-strings and empties.
function toStringArray(v, max = 30) {
  if (!Array.isArray(v)) return undefined;
  return v
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter(Boolean)
    .slice(0, max);
}

// Accepts integers only; returns undefined if invalid and null if explicitly null.
function toNullableInt(v) {
  if (v === null) return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : undefined;
}

// Accepts 0–100; clamps within range; returns undefined if not a number.
function toBudgetMax(v) {
  if (v === null) return null; // explicit reset
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  const clamped = Math.max(0, Math.min(100, Math.round(n)));
  return clamped;
}

// Normalizes “Unlimited” to null so queries can treat it as no cap.
function normalizeDistance(v) {
  if (v === null) return null;
  if (v === "Unlimited") return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : undefined;
}

/* ───────────────────────────────── routes ───────────────────────────────── */

// Simple reachability probe under /api/users/*
router.get("/__ping", (_req, res) =>
  res.json({ ok: true, via: "users.js", ts: Date.now() })
);

// Everything below requires a valid Firebase ID token.
router.use(verifyFirebaseToken);

// Minimal account snapshot for the client header/profile settings page.
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
      // preferences subset
      searchDistance: true,
      budgetMax: true,           // ← numeric column (0–100)
      dietaryNeeds: true,
      preferredCuisines: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  res.json({ user });
});

// Syncs basic profile fields from the Firebase token so the DB stays current.
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
      select: { id: true, firebaseUid: true, email: true },
    });

    res.json({ ok: true, user });
  } catch (err) {
    console.error("User sync failed:", err);
    res.status(500).json({ error: "User sync error" });
  }
});

// Reads preference fields used by the Preferences screen.
router.get("/preferences", async (req, res) => {
  const uid = req.user.uid;

  const prefs = await prisma.user.findUnique({
    where: { firebaseUid: uid },
    select: {
      searchDistance: true,
      budgetMax: true,           // ← numeric (0–100); null if unset
      dietaryNeeds: true,
      preferredCuisines: true,
      age: true,
      gender: true,
      updatedAt: true,
    },
  });

  res.json({
    preferences:
      prefs ?? {
        searchDistance: null,
        budgetMax: null,
        dietaryNeeds: [],
        preferredCuisines: [],
        age: null,
        gender: null,
      },
  });
});

// Saves preferences. Accepts numeric budgetMax; no enum mapping is performed.
router.post("/preferences", async (req, res) => {
  try {
    const uid = req.user.uid;
    const {
      searchDistance,        // number | "Unlimited" | null
      dietaryNeeds,          // string[]
      preferredCuisines,     // string[]
      budgetMax,             // number 0–100 | null
      age,                   // number | null
      gender,                // "MALE" | "FEMALE" | "NON_BINARY" | "PREFER_NOT_TO_SAY" | null
    } = req.body || {};

    // Build a minimal update object with only validated keys.
    const data = {
      // distances: null means unlimited; undefined means “leave unchanged”
      ...(normalizeDistance(searchDistance) !== undefined && {
        searchDistance: normalizeDistance(searchDistance),
      }),

      // budget: clamp to 0–100; null clears it
      ...(toBudgetMax(budgetMax) !== undefined && { budgetMax: toBudgetMax(budgetMax) }),

      // arrays
      ...(toStringArray(dietaryNeeds) && { dietaryNeeds: toStringArray(dietaryNeeds) }),
      ...(toStringArray(preferredCuisines) && {
        preferredCuisines: toStringArray(preferredCuisines),
      }),

      // simple scalars
      ...(toNullableInt(age) !== undefined && { age: toNullableInt(age) }),
      ...(typeof gender === "string" || gender === null ? { gender } : {}),
    };

    // Remove any properties that remain undefined (keeps partial updates clean).
    Object.keys(data).forEach((k) => data[k] === undefined && delete data[k]);

    const saved = await prisma.user.upsert({
      where: { firebaseUid: uid },
      update: { ...data, updatedAt: new Date() },
      create: {
        firebaseUid: uid,
        email: req.user.email ?? null,
        ...data,
      },
      select: {
        searchDistance: true,
        budgetMax: true,
        dietaryNeeds: true,
        preferredCuisines: true,
        age: true,
        gender: true,
        updatedAt: true,
      },
    });

    res.json({ ok: true, preferences: saved });
  } catch (err) {
    console.error("Save preferences failed:", err);
    res.status(500).json({ error: "Save preferences failed" });
  }
});

module.exports = router;

