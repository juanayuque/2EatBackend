// Environment variables are loaded early so that configuration is available to all modules.
require("dotenv").config();

const fs = require("fs");
const http = require("http");
const https = require("https");
const express = require("express");
const geocodeRoutes = require('./routes/geocode');
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
const admin = require("firebase-admin");
const prisma = require("./src/prisma"); // Enables clean shutdown of Prisma connections

// Route modules are kept modular for clarity and separation of concerns.
const locationRoutes = require("./routes/location"); // /api/places/photo + /api/location-info
const userRoutes = require("./routes/users");

const app = express();

/* ───────────────────────────── Security / performance ───────────────────────────── */

// Trusting the first proxy hop ensures correct client IPs when behind Cloudflare/NGINX.
app.set("trust proxy", 1);

// Common security headers, gzip compression, and request logging for observability.
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }, // <-- allow images cross-origin
}));
app.use(compression());
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

/* ───────────────────────────────────── CORS ───────────────────────────────────── */

// Production domains and typical local dev origins (Expo/Metro web uses 8081; Expo web often uses 19006).
const allowSet = new Set([
  "https://2eatapp.com",
  "https://www.2eatapp.com",
  "http://localhost:8081",  // Expo Metro (web preview)
  "http://localhost:19006", // Expo web dev
  "http://localhost:3000",  // General local dev
]);

// LAN origins are allowed for device testing over local networks.
const devLocalRegex = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const devLanRegex =
  /^https?:\/\/((10\.\d{1,3}\.\d{1,3}\.\d{1,3})|(192\.168\.\d{1,3}\.\d{1,3})|(172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}))(:\d+)?$/;

const corsOptions = {
  origin(origin, cb) {
    // Requests without an Origin (mobile apps, curl, server-to-server) are allowed.
    if (!origin) return cb(null, true);
    if (allowSet.has(origin)) return cb(null, true);
    if (devLocalRegex.test(origin) || devLanRegex.test(origin)) return cb(null, true);
    return cb(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type"],
  credentials: true,
  // Using 204 prevents some browsers from misreporting preflight errors.
  optionsSuccessStatus: 204,
};

// CORS is registered before any routes and preflights are explicitly handled on all paths.
app.use(cors(corsOptions));

/* ───────────────────────────────── Request parsing ─────────────────────────────── */

// JSON payload size is capped to reduce abuse potential and accidental large uploads.
app.use(express.json({ limit: "500kb" }));

/* ──────────────────────────────── Rate limiting ───────────────────────────────── */

// Basic per-IP throttling; preflight (OPTIONS) requests are skipped so they do not fail CORS.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120,            // 120 requests/minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === "OPTIONS",
});
app.use("/api", apiLimiter);

/* ───────────────────────────── Firebase Admin init ────────────────────────────── */

// Firebase Admin is initialized to verify ID tokens for protected API routes.
const serviceAccount = require("./serviceAccountKey.json");
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

/* ─────────────────────────────────── Routes ───────────────────────────────────── */

// Simple healthcheck for load balancers/uptime monitoring.
app.get("/", (_req, res) => res.send("2Eat API is up and running."));

// Feature routes mounted under /api for consistency.
app.use("/api", locationRoutes);
app.use("/api/users", userRoutes);
app.use('/api', geocodeRoutes);

/* ─────────────────────────────── Global errors ────────────────────────────────── */

// Converts CORS origin rejections into JSON and logs unexpected errors.
app.use((err, req, res, _next) => {
  if (err && err.message === "Not allowed by CORS") {
    return res.status(403).json({ error: "CORS blocked: origin not allowed" });
  }
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

/* ─────────────────────────────── Server startup ───────────────────────────────── */

const NODE_ENV = process.env.NODE_ENV || "development";
const HTTP_PORT = Number(process.env.PORT || 3000);

if (NODE_ENV === "production") {
  // HTTPS is served directly from Node in production using origin certificates.
  const SSL_KEY_PATH = process.env.SSL_KEY_PATH || "/etc/ssl/private/cloudflare.key";
  const SSL_CERT_PATH = process.env.SSL_CERT_PATH || "/etc/ssl/certs/cloudflare.crt";
  const options = {
    key: fs.readFileSync(SSL_KEY_PATH),
    cert: fs.readFileSync(SSL_CERT_PATH),
  };

  // Binding to :443 enables Cloudflare (Full/Strict) to connect to the origin over TLS.
  https.createServer(options, app).listen(443, () => {
    console.log("✅ Backend running on https://2eatapp.com");
  });

  // Optional HTTP listener for redirecting plaintext to HTTPS if no external proxy handles it.
  http.createServer((req, res) => {
    res.writeHead(301, { Location: "https://2eatapp.com" + req.url });
    res.end();
  }).listen(80);
} else {
  // Development uses a plain HTTP port to simplify local testing.
  app.listen(HTTP_PORT, () =>
    console.log(`🔧 Dev server on http://localhost:${HTTP_PORT}`)
  );
}

/* ────────────────────────────── Graceful shutdown ─────────────────────────────── */

// Ensures database connections are closed before process exit to avoid corruption or hanging.
function shutdown() {
  console.log("Shutting down…");
  Promise.resolve()
    .then(() => prisma?.$disconnect?.())
    .finally(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
