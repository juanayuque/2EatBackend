const express = require("express");
const router = express.Router();
const prisma = require("../src/prisma");
const verifyFirebaseToken = require("../middleware/auth");

// Allow preflight fast-path on this router (optional; app.options('*') already handles it)
router.options("*", (_req, res) => res.sendStatus(204));

/**
 * POST /api/users/sync-profile
 * Synchronizes the authenticated user's profile into the database.
 * Uses Firebase ID token decoded by verifyFirebaseToken.
 */
router.post("/sync-profile", verifyFirebaseToken, async (req, res) => {
  try {
    // Decoded Firebase claims from middleware
    const {
      uid: firebaseUid,
      email = null,
      name: tokenName = null,
      picture: tokenPicture = null,
      email_verified: emailVerified = null,
    } = req.user || {};

    if (!firebaseUid) {
      return res.status(401).json({ error: "Invalid token: uid missing" });
    }

    // Optional client-provided overrides
    const { displayName: bodyName, photoUrl: bodyPhotoUrl } = req.body || {};

    const displayName = bodyName ?? tokenName ?? null;
    const photoUrl = bodyPhotoUrl ?? tokenPicture ?? null;

    // Upsert user by firebaseUid to keep operation idempotent
    const user = await prisma.user.upsert({
      where: { firebaseUid },
      update: {
        email,
        displayName,
        photoUrl,
        emailVerified,
        updatedAt: new Date(),
      },
      create: {
        firebaseUid,
        email,
        displayName,
        photoUrl,
        emailVerified,
      },
      // select could be used to limit response payload if the table grows
    });

    return res.status(200).json({
      message: "User profile synced successfully",
      user: {
        id: user.id,
        firebaseUid: user.firebaseUid,
        email: user.email,
        displayName: user.displayName,
        photoUrl: user.photoUrl,
        emailVerified: user.emailVerified,
      },
    });
  } catch (err) {
    console.error("User sync failed:", err);
    return res
      .status(500)
      .json({ error: "User sync failed", code: "user-sync-error" });
  }
});

/**
 * GET /api/users/me
 * Returns the authenticated user's profile from the database.
 */
router.get("/me", verifyFirebaseToken, async (req, res) => {
  try {
    const { uid: firebaseUid } = req.user || {};
    if (!firebaseUid) {
      return res.status(401).json({ error: "Invalid token: uid missing" });
    }

    const user = await prisma.user.findUnique({
      where: { firebaseUid },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    return res.json({
      user: {
        id: user.id,
        firebaseUid: user.firebaseUid,
        email: user.email,
        displayName: user.displayName,
        photoUrl: user.photoUrl,
        emailVerified: user.emailVerified,
      },
    });
  } catch (err) {
    console.error("Fetch current user failed:", err);
    return res
      .status(500)
      .json({ error: "Failed to fetch profile", code: "user-fetch-error" });
  }
});

module.exports = router;
