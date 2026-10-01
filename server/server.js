require("dotenv").config();

const path = require("path");
const express = require("express");
const session = require("express-session");
const MySQLStore = require("express-mysql-session")(session);
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const pool = require("./db");
const publicRoutes = require("./routes/public");
const inquiryRoutes = require("./routes/inquiries");
const adminRoutes = require("./routes/admin");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const isProduction = process.env.NODE_ENV === "production";
const PUBLIC_DIR = path.join(__dirname, "..", "public");

if (isProduction && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
  throw new Error("SESSION_SECRET must be set to a random string of 32+ characters in production");
}

// Behind Nginx in production: trust the first proxy so secure cookies,
// req.ip (rate limiting / inquiry logs) and req.protocol are correct.
app.set("trust proxy", Number(process.env.TRUST_PROXY ?? 1));
app.disable("x-powered-by");

// ---------------------------------------------------------------------------
// Security headers. Styles are a prebuilt Tailwind file (public/css/
// tailwind.css) plus small inline page scripts; hero photography is served
// from Unsplash's image CDN.
// ---------------------------------------------------------------------------
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        "script-src": ["'self'", "'unsafe-inline'"],
        "script-src-attr": ["'unsafe-inline'"],
        "style-src": ["'self'", "'unsafe-inline'"],
        "img-src": ["'self'", "data:", "blob:", "https://images.unsplash.com"],
        "connect-src": ["'self'"],
        "upgrade-insecure-requests": isProduction ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
  }),
);
app.use(cors({ origin: process.env.CORS_ORIGIN || false, credentials: true }));

// ---------------------------------------------------------------------------
// Rate limits (production only, so local testing isn't throttled). All return
// JSON so the frontend can show the message.
// ---------------------------------------------------------------------------
const limitHandler = (req, res) =>
  res.status(429).json({
    success: false,
    message: "Too many requests. Please wait a few minutes and try again.",
  });
const limiter = (max, windowMinutes = 15) =>
  rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    max,
    handler: limitHandler,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => !isProduction,
  });

app.use("/api", limiter(300));
app.use("/api/admin/auth/login", limiter(10));
app.post("/api/inquiries", limiter(8, 60));

app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ limit: "100kb", extended: false }));

// ---------------------------------------------------------------------------
// Admin sessions, stored in MySQL so they survive PM2 restarts.
// ---------------------------------------------------------------------------
const SESSION_COOKIE = "frontier.admin";
app.set("sessionCookieName", SESSION_COOKIE);
const sessionStore = new MySQLStore(
  {
    createDatabaseTable: true,
    clearExpired: true,
    checkExpirationInterval: 15 * 60 * 1000,
    schema: { tableName: "admin_sessions" },
  },
  pool,
);
app.use(
  "/api/admin",
  session({
    name: SESSION_COOKIE,
    secret: process.env.SESSION_SECRET || "development-only-change-this-secret",
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      path: "/api/admin",
      secure: isProduction,
      httpOnly: true,
      sameSite: "strict",
      maxAge: 8 * 60 * 60 * 1000, // 8 hours of inactivity
    },
  }),
);

// ---------------------------------------------------------------------------
// v1 pages that no longer exist (public accounts, selling, messaging) send
// visitors somewhere sensible instead of a 404.
// ---------------------------------------------------------------------------
const RETIRED_PAGES = {
  "/marketplace.html": "/#listings",
  "/login.html": "/",
  "/register.html": "/",
  "/dashboard.html": "/",
  "/messages.html": "/",
  "/profile.html": "/",
  "/seller.html": "/",
  "/admin/users.html": "/admin/",
  "/admin/reports.html": "/admin/",
  "/admin/listings.html": "/admin/livestock.html",
};
app.get(Object.keys(RETIRED_PAGES), (req, res) => res.redirect(301, RETIRED_PAGES[req.path]));

// ---------------------------------------------------------------------------
// Static files. Uploaded photos have unique names, so they can be cached
// for a long time; pages/scripts revalidate.
// ---------------------------------------------------------------------------
app.use(
  "/uploads",
  express.static(path.join(PUBLIC_DIR, "uploads"), { maxAge: "30d", immutable: true, fallthrough: false }),
);
app.use("/images", express.static(path.join(PUBLIC_DIR, "images"), { maxAge: "7d" }));
app.use(express.static(PUBLIC_DIR, { extensions: ["html"] }));

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ success: true, status: "ok" });
  } catch {
    res.status(503).json({ success: false, status: "database unavailable" });
  }
});
app.use("/api", publicRoutes);
app.use("/api/inquiries", inquiryRoutes);
app.use("/api/admin", adminRoutes);

// ---------------------------------------------------------------------------
// 404 + errors
// ---------------------------------------------------------------------------
app.use("/api", (req, res) => {
  res.status(404).json({ success: false, message: "API endpoint not found" });
});
app.use((req, res) => {
  res.status(404).sendFile(path.join(PUBLIC_DIR, "404.html"));
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.name === "MulterError") {
    const message =
      err.code === "LIMIT_FILE_SIZE"
        ? "Each photo must be 12 MB or smaller."
        : err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE"
          ? "Too many photos - a listing can have at most 10."
          : err.message;
    return res.status(400).json({ success: false, message });
  }
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ success: false, message: "Invalid request body." });
  }
  if (err.expose && err.status && err.status < 500) {
    return res.status(err.status).json({
      success: false,
      message: err.message,
      ...(err.errors ? { errors: err.errors } : {}),
    });
  }
  if (err.status === 404 || err.statusCode === 404) {
    return res.status(404).json({ success: false, message: "Not found" });
  }
  console.error("Server error:", err);
  return res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
});

if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log("\nFrontier Marketplace");
    console.log(`Running on http://localhost:${PORT}  (${process.env.NODE_ENV || "development"})\n`);
  });
  const shutdown = () => {
    console.log("\nShutting down...");
    server.close(() => {
      sessionStore.close().catch(() => {});
      pool.end().finally(() => process.exit(0));
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

module.exports = app;
