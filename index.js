const express = require('express');
const fs = require('fs');
const https = require('https');
const cors = require('cors');
const admin = require('firebase-admin');
const locationRoutes = require('./routes/location.js');
const userRoutes = require('./routes/users.js');

const app = express();
app.use(cors());
app.use(express.json());

// Firebase Admin Init
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

// Route modules
app.use('/api', locationRoutes);
app.use('/api/users', userRoutes);

// Root route 
app.get('/', (req, res) => {
  res.send('2Eat API is up and running.');
});

// HTTPS Server
const options = {
  key: fs.readFileSync('/etc/ssl/private/cloudflare.key'),
  cert: fs.readFileSync('/etc/ssl/certs/cloudflare.crt')
};

https.createServer(options, app).listen(443, () => {
  console.log('Backend running on https://2eatapp.com');
});
