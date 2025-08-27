// Environment first
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

app.set("trust proxy", 1);

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);
app.use(compression());
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

/* ───────────────────────────────────── CORS ───────────────────────────────────── */

const allowSet = new Set([
  "https://2eatapp.com",
  "https://www.2eatapp.com",
  "http://localhost:8081",
  "http://localhost:19006",
  "http://localhost:3000",
]);

const devLocalRegex = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const devLanRegex =
  /^https?:\/\/((10\.\d{1,3}\.\d{1,3}\.\d{1,3})|(192\.168\.\d{1,3}\.\d{1,3})|(172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}))(:\d+)?$/;

const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (allowSet.has(origin)) return cb(null, true);
    if (devLocalRegex.test(origin) || devLanRegex.test(origin)) return cb(null, true);
    return cb(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type"],
  credentials: true,
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));

/* ─────────────────────────────── Parsing / limits ─────────────────────────────── */

app.use(express.json({ limit: "500kb" }));

/* ──────────────────────────────── Rate limiting ───────────────────────────────── */

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === "OPTIONS",
});
app.use("/api", apiLimiter);

/* ───────────────────────────── Firebase Admin ───────────────────────────── */

const serviceAccount = require("./serviceAccountKey.json");
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

/* ───────────────────────────── Health / pings ───────────────────────────── */

app.get("/", (_req, res) => res.send("2Eat API is up and running."));
app.get("/api/users/__ping", (_req, res) =>
  res.json({ ok: true, via: "index", ts: Date.now() })
);

/* ───────────────────────────── Routers (safe mount) ───────────────────────────── */

function safeMount(path, router, label) {
  if (typeof router === "function") {
    app.use(path, router);
    console.log(`Mounted ${label} at ${path}`);
  } else {
    console.error(`NOT mounting ${label}: expected a router function, got ${typeof router}`);
    app.use(path, (_req, res) =>
      res.status(500).json({ error: `${label} router missing` })
    );
  }
}

const usersRouter = require("./routes/users");
const locationRoutes = require("./routes/location");
const geocodeRoutes = require("./routes/geocode");
const recsRoutes = require("./routes/recs");

safeMount("/api/users", usersRouter, "users");
safeMount("/api", locationRoutes, "location");
safeMount("/api", geocodeRoutes, "geocode");
safeMount("/api/recs", recsRoutes, "recs");

/* ─────────────────────────────── Global errors ────────────────────────────────── */

app.use((err, _req, res, _next) => {
  if (err && err.message === "Not allowed by CORS") {
    return res.status(403).json({ error: "CORS blocked: origin not allowed" });
  }
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

/* ─────────────────────────────── Server startup ───────────────────────────────── */

const NODE_ENV = process.env.NODE_ENV || "development";
const HTTP_PORT = Number(process.env.PORT || 3000);
const USE_LOCAL_TLS = process.env.USE_LOCAL_TLS === "1";

if (NODE_ENV === "production" && USE_LOCAL_TLS) {
  const keyPath  = process.env.SSL_KEY_PATH;
  const certPath = process.env.SSL_CERT_PATH;
  const options = {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  };
  https.createServer(options, app).listen(443, () => {
    console.log("✅ Backend running on https://2eatapp.com");
  });
  http.createServer((req, res) => {
    res.writeHead(301, { Location: "https://2eatapp.com" + req.url });
    res.end();
  }).listen(80);
} else {
  app.listen(HTTP_PORT, () => console.log(`🔧 Dev server on http://localhost:${HTTP_PORT}`));
}


/* ────────────────────────────── Safe shutdown ─────────────────────────────── */

function shutdown() {
  console.log("Shutting down…");
  Promise.resolve()
    .then(() => prisma?.$disconnect?.())
    .finally(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
