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

// New: safe display name coercion
function toDisplayName(v) {
  if (v === null) return null;                // explicit clear
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (!s) return null;                        // treat empty as clear
  return s.slice(0, 80);                      // keep it sane
}

const GENDERS = new Set(["MALE", "FEMALE", "NON_BINARY", "PREFER_NOT_TO_SAY"]);

/* ───────────────────────────────── routes ───────────────────────────────── */

router.get("/__ping", (_req, res) => res.json({ ok: true, via: "users.js", ts: Date.now() }));

router.use(verifyFirebaseToken);

// Minimal account snapshot
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
      budgetMax: true,
      dietaryNeeds: true,
      preferredCuisines: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  res.json({ user });
});

// Sync basic profile fields from Firebase token
// Sync basic profile fields from Firebase token without stomping user-edited displayName
router.post("/sync-profile", async (req, res) => {
  try {
    const { uid, email, name, picture, email_verified } = req.user;

    const existing = await prisma.user.findUnique({
      where: { firebaseUid: uid },
      select: { id: true, displayName: true },
    });

    if (!existing) {
      // New user: seed displayName from token if present
      const user = await prisma.user.create({
        data: {
          firebaseUid: uid,
          email: email ?? null,
          displayName: (typeof name === "string" && name.trim()) ? name.trim() : null,
          photoUrl: picture ?? null,
          emailVerified: !!email_verified,
        },
        select: { id: true, firebaseUid: true, email: true },
      });
      return res.json({ ok: true, user });
    }

    // Existing user: DO NOT overwrite displayName unless they don't have one yet
    const updateData = {
      email: email ?? null,
      photoUrl: picture ?? null,
      emailVerified: !!email_verified,
      updatedAt: new Date(),
    };
    if (!existing.displayName && typeof name === "string" && name.trim()) {
      updateData.displayName = name.trim();
    }

    const user = await prisma.user.update({
      where: { firebaseUid: uid },
      data: updateData,
      select: { id: true, firebaseUid: true, email: true },
    });

    res.json({ ok: true, user });
  } catch (err) {
    console.error("User sync failed:", err);
    res.status(500).json({ error: "User sync error" });
  }
});


// Read preferences (now also returns displayName so you can prefill)
router.get("/preferences", async (req, res) => {
  const uid = req.user.uid;
  const prefs = await prisma.user.findUnique({
    where: { firebaseUid: uid },
    select: {
      displayName: true,        
      searchDistance: true,
      budgetMax: true,
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
        displayName: null,
        searchDistance: null,
        budgetMax: null,
        dietaryNeeds: [],
        preferredCuisines: [],
        age: null,
        gender: null,
      },
  });
});

// Save preferences (+ displayName support for onboarding)
router.post("/preferences", async (req, res) => {
  try {
    const uid = req.user.uid;
    const {
      displayName,            // ← string | null
      searchDistance,         // number | "Unlimited" | null
      dietaryNeeds,           // string[]
      preferredCuisines,      // string[]
      budgetMax,              // number 0–100 | null
      age,                    // number | null
      gender,                 // "MALE" | "FEMALE" | "NON_BINARY" | "PREFER_NOT_TO_SAY" | null
    } = req.body || {};

    // Build a minimal update with only validated keys.
    const data = {
      ...(toDisplayName(displayName) !== undefined && { displayName: toDisplayName(displayName) }),

      ...(normalizeDistance(searchDistance) !== undefined && {
        searchDistance: normalizeDistance(searchDistance),
      }),

      ...(toBudgetMax(budgetMax) !== undefined && { budgetMax: toBudgetMax(budgetMax) }),

      ...(toStringArray(dietaryNeeds) && { dietaryNeeds: toStringArray(dietaryNeeds) }),
      ...(toStringArray(preferredCuisines) && { preferredCuisines: toStringArray(preferredCuisines) }),

      ...(toNullableInt(age) !== undefined && { age: toNullableInt(age) }),
      ...((typeof gender === "string" && GENDERS.has(gender)) || gender === null
        ? { gender }
        : {}),
    };

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
        displayName: true,
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

router.post("/lookup", verifyFirebaseToken, async (req, res) => {
  try {
    const ids = Array.from(
      new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(String))
    );
    if (!ids.length) return res.json({ users: {} });

    const users = await prisma.user.findMany({
      where: {
        OR: [
          { id: { in: ids } },
          { firebaseUid: { in: ids } },
          { email: { in: ids } },
        ],
      },
      // Only select fields that exist in your schema
      select: {
        id: true,
        firebaseUid: true,
        email: true,
        displayName: true,
        firstName: true,
        lastName: true,
        username: true,   // optional if present in your model
      },
    });

    const pickName = (u) =>
      (u.displayName && u.displayName.trim()) ||
      ([u.firstName, u.lastName].filter(Boolean).join(" ").trim() || null) ||
      (u.username && u.username.trim()) ||
      (u.email ? u.email.split("@")[0] : null) ||
      "Unknown User";

    // Map each requested id back to a name by matching id/firebaseUid/email
    const out = {};
    for (const reqId of ids) {
      const match =
        users.find((u) => u.id === reqId) ||
        users.find((u) => u.firebaseUid === reqId) ||
        users.find((u) => u.email === reqId);
      if (match) out[reqId] = pickName(match);
    }

    res.json({ users: out });
  } catch (err) {
    console.error("[users/lookup] error:", err);
    res.status(500).json({ error: "lookup failed" });
  }
});

module.exports = router;
