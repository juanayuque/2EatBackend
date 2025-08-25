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
const prisma = require("./src/prisma"); // if you want graceful shutdown

const locationRoutes = require("./routes/location"); // includes /places/photo + /location-info
const userRoutes = require("./routes/users");

const app = express();

/* ---------- Security / perf ---------- */
app.set("trust proxy", 1); // behind Cloudflare/NGINX
app.use(helmet());
app.use(compression());
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// Tighten CORS to your apps/domains
const allowlist = [
  "https://2eatapp.com",
  "https://www.2eatapp.com",
  "http://localhost:19006", // Expo web dev
  "http://localhost:3000",
];
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || allowlist.includes(origin)) return cb(null, true);
      cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);

// JSON limits to avoid abuse
app.use(express.json({ limit: "500kb" }));

// Basic rate limit (tune per needs)
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 min
  max: 120, // 120 req/min per IP
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api", apiLimiter);

/* ---------- Firebase Admin ---------- */
const serviceAccount = require("./serviceAccountKey.json");
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

/* ---------- Routes ---------- */
app.get("/", (_req, res) => res.send("2Eat API is up and running."));
app.use("/api", locationRoutes);      // /api/places/photo, /api/location-info
app.use("/api/users", userRoutes);

/* ---------- Error handler ---------- */
app.use((err, req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

/* ---------- Start server ---------- */
const NODE_ENV = process.env.NODE_ENV || "development";
const HTTP_PORT = Number(process.env.PORT || 3000);

if (NODE_ENV === "production") {
  const SSL_KEY_PATH = process.env.SSL_KEY_PATH || "/etc/ssl/private/cloudflare.key";
  const SSL_CERT_PATH = process.env.SSL_CERT_PATH || "/etc/ssl/certs/cloudflare.crt";
  const options = {
    key: fs.readFileSync(SSL_KEY_PATH),
    cert: fs.readFileSync(SSL_CERT_PATH),
  };
  https.createServer(options, app).listen(443, () => {
    console.log("✅ Backend running on https://2eatapp.com");
  });
  // (Optional) also listen on 80 to redirect to 443 if not handled by proxy
  http.createServer((req, res) => {
    res.writeHead(301, { Location: "https://2eatapp.com" + req.url });
    res.end();
  }).listen(80);
} else {
  app.listen(HTTP_PORT, () =>
    console.log(`🔧 Dev server on http://localhost:${HTTP_PORT}`)
  );
}

/* ---------- Graceful shutdown ---------- */
function shutdown() {
  console.log("Shutting down…");
  Promise.resolve()
    .then(() => prisma?.$disconnect?.())
    .finally(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
