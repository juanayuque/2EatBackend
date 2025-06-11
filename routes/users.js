require('dotenv').config();

const express = require('express');
const admin = require('firebase-admin');
const router = express.Router();
const prisma = require('../src/prisma');

router.post('/sync-profile', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).send('Missing token');
  }

  const token = authHeader.split(' ')[1];

  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    const firebaseUid = decodedToken.uid;
    const email = decodedToken.email || null; // Email might not always be present

    // --- Prisma User Sync Logic ---
    const user = await prisma.user.upsert({
      where: { firebaseUid: firebaseUid },
      update: {
        email: email,
        updatedAt: new Date(), // Update timestamp on existing user
      },
      create: {
        firebaseUid: firebaseUid,
        email: email,
      },
    });
    console.log(`User synced to DB: ${user.firebaseUid}`);
    res.status(200).json({ message: 'User profile synced successfully', user: { id: user.id, firebaseUid: user.firebaseUid, email: user.email } });

  } catch (err) {
    console.error('Firebase token verification or user sync failed:', err);
    res.status(401).json({ error: 'Authentication failed or user sync error' });
  }
});

module.exports = router;
