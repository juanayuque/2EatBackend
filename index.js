// Loads environment variables early so configuration is available everywhere.
require("dotenv").config();

const fs = require("fs");
const http = require("http");
const https = require("https");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
const admin = require("firebase-admin");
const prisma = require("./src/prisma");

const app = express();

/* ───────────────────────────── Security / performance ───────────────────────────── */

// Trust the first proxy hop so real client IPs appear when behind Cloudflare/NGINX.
app.set("trust proxy", 1);

// Security headers + gzip + request logging. Cross-origin resource policy is relaxed
// so the photo proxy can be consumed by the web app without being blocked by the browser.
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);
app.use(compression());
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

/* ───────────────────────────────────── CORS ───────────────────────────────────── */

// Allow known production domains and common local dev origins (Expo/Metro).
const allowSet = new Set([
  "https://2eatapp.com",
  "https://www.2eatapp.com",
  "http://localhost:8081",  // Expo Metro (web preview)
  "http://localhost:19006", // Expo web dev
  "http://localhost:3000",  // General local dev
]);

// Allow typical LAN addresses for device testing (10.x, 192.168.x, 172.16–31.x).
const devLocalRegex = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const devLanRegex =
  /^https?:\/\/((10\.\d{1,3}\.\d{1,3}\.\d{1,3})|(192\.168\.\d{1,3}\.\d{1,3})|(172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}))(:\d+)?$/;

const corsOptions = {
  origin(origin, cb) {
    // Requests without an Origin (mobile apps, curl, server-to-server) should pass.
    if (!origin) return cb(null, true);
    if (allowSet.has(origin)) return cb(null, true);
    if (devLocalRegex.test(origin) || devLanRegex.test(origin)) return cb(null, true);
    return cb(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type", "X-Geo-Lat", "X-Geo-Lng", "Accept", "X-Requested-With"],
  credentials: true,
  optionsSuccessStatus: 204, // 204 avoids some browser preflight quirks.
};

// Register CORS before any routes so preflight covers everything.
app.use(cors(corsOptions));

/* ───────────────────────────────── Request parsing ─────────────────────────────── */

// Limit JSON payload size to reduce abuse and accidental large uploads.
app.use(express.json({ limit: "500kb" }));

/* ──────────────────────────────── Rate limiting ───────────────────────────────── */

// Throttle per-IP. OPTIONS is skipped so preflight does not get rate-limited.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120,            // 120 requests/minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === "OPTIONS",
});
app.use("/api", apiLimiter);

/* ───────────────────────────── Firebase Admin init ────────────────────────────── */

// Firebase Admin is used to verify ID tokens on protected endpoints.
const serviceAccount = require("./serviceAccountKey.json");
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

/* ───────────────────────────── Routes ───────────────────────────── */

// Health check
app.get("/", (_req, res) => res.send("2Eat API is up and running."));

// Add a simple ping inside the /api/users namespace to verify mount works.
app.get("/api/users/__ping", (_req, res) => res.json({ ok: true, via: "index", ts: Date.now() }));

// Load and mount users router ONCE
const usersRouter = require("./routes/users");
app.use("/api/users", (req, _res, next) => {
  console.log("users-router hit:", req.method, req.url);
  next();
}, usersRouter);

// Other feature routers
const locationRoutes = require("./routes/location");
const geocodeRoutes = require("./routes/geocode");
const friendsRouter = require("./routes/friends");
const meRouter = require("./routes/me");
let recsRoutes = require("./routes/recs");

// Basic mounts
app.use("/api", locationRoutes);
app.use("/api", geocodeRoutes);
app.use("/api/matches", require("./routes/matches"));
app.use("/api/friends", friendsRouter);
app.use("/api/group", require("./routes/groupmatches"));
app.use("/api/group", require("./routes/group"));
app.use("/api/group", require("./routes/grouprequests"));
app.use("/api/me", meRouter);



// Mount recs (guard in case of wrong export)
if (typeof recsRoutes === "function" || (recsRoutes && typeof recsRoutes.use === "function")) {
  app.use("/api/recs", recsRoutes);
  console.log("Mounted recs at /api/recs");
} else {
  console.error("NOT mounting recs: expected a router function, got", typeof recsRoutes);
}

/* ─────────────────────────────── Global errors ────────────────────────────────── */

// Convert CORS rejections into JSON and log unexpected errors with a 500 fallback.
app.use((err, req, res, _next) => {
  if (err && err.message === "Not allowed by CORS") {
    return res.status(403).json({ error: "CORS blocked: origin not allowed" });
  }
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

/* ─────────────────────────────── Server startup ───────────────────────────────── */

// Use underscored locals to avoid re-declaration if similar names exist above.
const _NODE_ENV = process.env.NODE_ENV || "development";
const _HTTP_PORT = Number(process.env.PORT || 3000);

const _FORCE_DEV_HTTP = !!process.env.FORCE_DEV_HTTP; // set "1" to force HTTP in prod
const _SSL_KEY_PATH = process.env.SSL_KEY_PATH || "/etc/ssl/private/cloudflare.key";
const _SSL_CERT_PATH = process.env.SSL_CERT_PATH || "/etc/ssl/certs/cloudflare.crt";

console.log("BOOT ENV", {
  NODE_ENV: _NODE_ENV,
  FORCE_DEV_HTTP: process.env.FORCE_DEV_HTTP,
  SSL_KEY_PATH: _SSL_KEY_PATH,
  SSL_CERT_PATH: _SSL_CERT_PATH,
});

if (_NODE_ENV === "production" && !_FORCE_DEV_HTTP) {
  try {
    const key = fs.readFileSync(_SSL_KEY_PATH);
    const cert = fs.readFileSync(_SSL_CERT_PATH);

    https.createServer({ key, cert }, app).listen(443, () => {
      console.log("✅ Backend running on https://2eatapp.com (port 443)");
    });

    // Optional: redirect plaintext to HTTPS if no external proxy handles it.
    http.createServer((req, res) => {
      res.writeHead(301, { Location: "https://2eatapp.com" + req.url });
      res.end();
    }).listen(80, () => {
      console.log("↪️  Redirecting http://:80 to https://:443");
    });
  } catch (err) {
    console.error("❌ Failed to start HTTPS server:", err);
    process.exit(1); // fail loud so PM2 shows the real issue
  }
} else {
  app.listen(_HTTP_PORT, () => {
    console.log(`🔧 Dev server on http://localhost:${_HTTP_PORT}`);
  });
}

/* ────────────────────────────── Graceful shutdown ─────────────────────────────── */

// Ensures open DB connections are closed before exit to avoid hangs or corruption.
function shutdown() {
  console.log("Shutting down…");
  Promise.resolve()
    .then(() => prisma?.$disconnect?.())
    .finally(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
