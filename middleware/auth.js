// middleware/auth.js
const admin = require('firebase-admin');

// Optional: if you plan to read tokens from cookies sometime
// const cookieName = '__session';

async function verifyFirebaseToken(req, res, next) {
  // 1) Always allow CORS preflight
  if (req.method === 'OPTIONS') return next();

  // 2) Extract token (Authorization header is case-insensitive)
  const authHeader = req.get('authorization') || req.get('Authorization') || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  // const cookieToken = req.cookies?.[cookieName]; // if you add cookie-parser later
  const token = match ? match[1] /* : cookieToken */ : null;

  if (!token) {
    return res.status(401).json({ error: 'Missing token' });
  }

  try {
    // verifyIdToken(token, /* checkRevoked */ false)
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;
    return next();
  } catch (err) {
    // You can log err.code for more context (auth/id-token-expired, etc.)
    return res.status(401).json({ error: 'Unauthorized', code: err.code || 'invalid-token' });
  }
}

module.exports = verifyFirebaseToken;
