const express = require('express');
const admin = require('firebase-admin');
const router = express.Router();

router.post('/sync-profile', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return res.status(401).send('Missing token');

  const token = authHeader.split(' ')[1];
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    // You can now use `decoded.uid`, `req.body.email`, etc.
    console.log(`Syncing user: ${decoded.uid}`);

    // Save user to DB if needed
    res.status(200).json({ message: 'User synced' });
  } catch (error) {
    res.status(401).json({ error: 'Backend verification failed' });
  }
});

export default router;
