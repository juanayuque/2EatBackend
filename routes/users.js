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

/**
 * Returns the current preference snapshot for the authenticated user.
 * Defaults are provided when no row exists yet to keep the UI stable.
 */
router.get("/preferences", verifyFirebaseToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { firebaseUid: req.user.uid },
      select: {
        preferredCuisines: true,
        dietaryNeeds: true,
        maxBudget: true,
        preferredPriceLevel: true,
        searchDistance: true,
        budgetRange: true, // kept for backward compatibility if needed elsewhere
      },
    });

    if (!user) {
      return res.json({
        cuisines: [],
        diet: [],
        budgetMax: 25,
        priceLevel: 2,
        distanceKm: 5,
        budgetRange: [],
      });
    }

    return res.json({
      cuisines: user.preferredCuisines ?? [],
      diet: user.dietaryNeeds ?? [],
      budgetMax: user.maxBudget ?? 25,
      priceLevel:
        typeof user.preferredPriceLevel === "number"
          ? user.preferredPriceLevel
          : 2,
      distanceKm:
        typeof user.searchDistance === "number" ? user.searchDistance : null, // null = Unlimited
      budgetRange: user.budgetRange ?? [],
    });
  } catch (err) {
    console.error("Fetch preferences failed:", err);
    return res.status(500).json({ error: "Failed to load preferences" });
  }
});

/**
 * Saves preference updates. Values are sanitized to expected ranges and
 * a derived price level is kept in sync with max budget for easier querying.
 */
router.post("/preferences", verifyFirebaseToken, async (req, res) => {
  try {
    const {
      cuisines = [],
      diet = [],
      budgetMax,
      priceLevel,
      distanceKm, // number or null (Unlimited)
    } = req.body || {};

    const toStringArray = (v) =>
      Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : [];

    const preferredCuisines = toStringArray(cuisines);
    const dietaryNeeds = toStringArray(diet);

    // Clamp numeric inputs to expected ranges
    const nb =
      typeof budgetMax === "number"
        ? Math.max(0, Math.min(100, Math.round(budgetMax)))
        : null;

    // If priceLevel not provided, derive from maxBudget using UI bands
    const pl =
      typeof priceLevel === "number"
        ? Math.max(0, Math.min(4, Math.round(priceLevel)))
        : nb === null
        ? null
        : nb <= 0
        ? 0
        : nb <= 15
        ? 1
        : nb <= 30
        ? 2
        : nb <= 60
        ? 3
        : 4;

    // Null means “Unlimited” in the UI
    const sd =
      distanceKm === null
        ? null
        : typeof distanceKm === "number"
        ? Math.max(0, Math.min(1000, Math.round(distanceKm)))
        : null;

    const updated = await prisma.user.upsert({
      where: { firebaseUid: req.user.uid },
      update: {
        preferredCuisines,
        dietaryNeeds,
        maxBudget: nb,
        preferredPriceLevel: pl,
        searchDistance: sd,
        updatedAt: new Date(),
      },
      create: {
        firebaseUid: req.user.uid,
        preferredCuisines,
        dietaryNeeds,
        maxBudget: nb,
        preferredPriceLevel: pl,
        searchDistance: sd,
      },
      select: {
        preferredCuisines: true,
        dietaryNeeds: true,
        maxBudget: true,
        preferredPriceLevel: true,
        searchDistance: true,
      },
    });

    return res.status(200).json({
      message: "Preferences saved",
      preferences: {
        cuisines: updated.preferredCuisines ?? [],
        diet: updated.dietaryNeeds ?? [],
        budgetMax: updated.maxBudget ?? 0,
        priceLevel:
          typeof updated.preferredPriceLevel === "number"
            ? updated.preferredPriceLevel
            : 0,
        distanceKm:
          typeof updated.searchDistance === "number"
            ? updated.searchDistance
            : null,
      },
    });
  } catch (err) {
    console.error("Save preferences failed:", err);
    return res.status(500).json({ error: "Failed to save preferences" });
  }
});

module.exports = router;
