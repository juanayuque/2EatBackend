const admin = require('firebase-admin');

async function verifyFirebaseToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).send('Missing token');
  }

  const token = authHeader.split(' ')[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (err) {
    res.status(401).send('Unauthorized');
  }
}

module.exports = verifyFirebaseToken;
