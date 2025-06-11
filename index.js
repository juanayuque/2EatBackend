import express from 'express';
import fs from 'fs';
import https from 'https';
import cors from 'cors';
import admin from 'firebase-admin';
import locationRoutes from './routes/location.js';
import userRoutes from './routes/users.js';

const app = express();
app.use(cors());
app.use(express.json());

// Firebase Admin Init
import serviceAccount from './serviceAccountKey.json' assert { type: 'json' };
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
