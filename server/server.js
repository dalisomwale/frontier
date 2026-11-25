require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const path = require("path");
const express = require("express");
const session = require("express-session");
const MySQLStore = require("express-mysql-session")(session);
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const pool = require("./db");
const { emailConfig } = require("./services/mailer");
const publicRoutes = require("./routes/public");
const inquiryRoutes = require("./routes/inquiries");
const orderRoutes = require("./routes/orders");
const adminRoutes = require("./routes/admin");
const sellerRoutes = require("./routes/seller");

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

// Map tiles for the transport maps (delivery point, tracking). OpenStreetMap
// by default; MAP_TILE_URL can point at another tile service.
const MAP_TILES = process.env.MAP_TILE_URL || "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const MAP_ATTRIBUTION = process.env.MAP_TILE_ATTRIBUTION || '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';
const MAP_TILE_ORIGIN = (() => {
  try {
    const u = new URL(MAP_TILES.replace(/\{[a-z]\}/gi, "0"));
    return MAP_TILES.includes("{s}.") ? `${u.protocol}//*.${u.host.split(".").slice(1).join(".")}` : u.origin;
  } catch {
    return "https://tile.openstreetmap.org";
  }
})();

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
        "img-src": ["'self'", "data:", "blob:", "https://images.unsplash.com", MAP_TILE_ORIGIN],
        "connect-src": ["'self'"],
        // Lipila's secure card form can be shown inside the checkout page.
        "frame-src": ["'self'", "https:", ...(isProduction ? [] : ["http://127.0.0.1:*"])],
        "upgrade-insecure-requests": isProduction ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    // Other sites get only our origin, never the page address (which can hold
    // order and delivery links). OpenStreetMap's tile servers need the origin:
    // without it they serve an "Access blocked" image instead of the map.
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
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

// GPS positions from a provider's phone have their own, higher limit.
const isLocation = (req) => /^\/api\/transport\/bookings\/\d+\/location$/.test(req.originalUrl.split("?")[0]);
app.use("/api", rateLimit({ windowMs: 15 * 60 * 1000, max: 300, handler: limitHandler, standardHeaders: true, legacyHeaders: false, skip: (req) => !isProduction || isLocation(req) }));
app.use("/api/transport/bookings", rateLimit({ windowMs: 15 * 60 * 1000, max: 600, handler: limitHandler, standardHeaders: true, legacyHeaders: false, skip: (req) => !isProduction || !isLocation(req) }));
app.use("/api/transport/auth/login", limiter(10));
app.use("/api/transport/auth/register", limiter(5, 60));
app.use("/api/transport/auth/forgot", limiter(5, 60));
app.use("/api/transport/auth/reset", limiter(10, 60));
app.use("/api/checkout/transport-quote", limiter(60));
app.use("/api/checkout/geocode", limiter(60));
app.use("/api/admin/auth/login", limiter(10));
app.use("/api/seller/auth/login", limiter(10));
app.use("/api/seller/auth/register", limiter(5, 60));
app.use("/api/seller/auth/forgot", limiter(5, 60));
app.use("/api/seller/auth/reset", limiter(10, 60));
app.use("/api/buyer/auth/login", limiter(10));
app.use("/api/buyer/auth/register", limiter(5, 60));
app.use("/api/buyer/auth/forgot", limiter(5, 60));
app.use("/api/buyer/auth/reset", limiter(10, 60));
app.use("/api/buyer/auth/resend", limiter(3, 60));
app.use("/api/newsletter/subscribe", limiter(10, 60));
app.use("/api/newsletter/resubscribe", limiter(10, 60));
app.post("/api/inquiries", limiter(8, 60));
app.post("/api/orders", limiter(8, 60));

app.use(express.json({
  limit: "100kb",
  // Payment webhooks are signed over the exact bytes sent.
  verify: (req, res, buf) => { if (req.originalUrl.startsWith("/api/payments/")) req.rawBody = buf; },
}));
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

// Seller sessions: a separate cookie, scoped to the seller API. They need
// their own store, as express-session sets the store's cookie options.
const SELLER_COOKIE = "frontier.seller";
const sellerSessionStore = new MySQLStore(
  {
    createDatabaseTable: true,
    clearExpired: true,
    checkExpirationInterval: 15 * 60 * 1000,
    schema: { tableName: "seller_sessions" },
  },
  pool,
);
app.set("sellerCookieName", SELLER_COOKIE);
app.use(
  "/api/seller",
  session({
    name: SELLER_COOKIE,
    secret: process.env.SESSION_SECRET || "development-only-change-this-secret",
    store: sellerSessionStore,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      path: "/api/seller",
      secure: isProduction,
      httpOnly: true,
      sameSite: "strict",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  }),
);

// Buyer sessions: their own cookie, sent to the buyer API and to checkout
// (which needs to know who is ordering).
const BUYER_COOKIE = "frontier.buyer";
const buyerSessionStore = new MySQLStore(
  {
    createDatabaseTable: true,
    clearExpired: true,
    checkExpirationInterval: 15 * 60 * 1000,
    schema: { tableName: "buyer_sessions" },
  },
  pool,
);
app.set("buyerCookieName", BUYER_COOKIE);
app.use(
  ["/api/buyer", "/api/checkout"],
  session({
    name: BUYER_COOKIE,
    secret: process.env.SESSION_SECRET || "development-only-change-this-secret",
    store: buyerSessionStore,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      path: "/api",
      secure: isProduction,
      httpOnly: true,
      sameSite: "strict",
      maxAge: 30 * 24 * 60 * 60 * 1000,
    },
  }),
);

// Transport provider sessions: their own cookie, scoped to the transport API.
const TRANSPORT_COOKIE = "frontier.transport";
const transportSessionStore = new MySQLStore(
  {
    createDatabaseTable: true,
    clearExpired: true,
    checkExpirationInterval: 15 * 60 * 1000,
    schema: { tableName: "transport_provider_sessions" },
  },
  pool,
);
app.set("transportCookieName", TRANSPORT_COOKIE);
app.use(
  "/api/transport",
  session({
    name: TRANSPORT_COOKIE,
    secret: process.env.SESSION_SECRET || "development-only-change-this-secret",
    store: transportSessionStore,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      path: "/api/transport",
      secure: isProduction,
      httpOnly: true,
      sameSite: "strict",
      maxAge: 30 * 24 * 60 * 60 * 1000,
    },
  }),
);

// ---------------------------------------------------------------------------
// v1 pages that no longer exist (public accounts, selling, messaging) send
// visitors somewhere sensible instead of a 404.
// ---------------------------------------------------------------------------
const RETIRED_PAGES = {
  "/marketplace": "/#listings",
  "/login": "/seller/login",
  "/register": "/seller/register",
  "/dashboard": "/seller/",
  "/messages": "/",
  "/profile": "/",
  "/admin/users": "/admin/",
  "/admin/reports": "/admin/",
  "/admin/listings": "/admin/livestock",
  "/photo-credits": "/",
};
// Old addresses with ".html" too.
Object.keys(RETIRED_PAGES).forEach((k) => { RETIRED_PAGES[`${k}.html`] = RETIRED_PAGES[k]; });
RETIRED_PAGES["/seller.html"] = "/";
app.get(Object.keys(RETIRED_PAGES), (req, res) => res.redirect(301, RETIRED_PAGES[req.path]));

// Pages are addressed without ".html" (/checkout, /admin/orders, /account/).
// Old links (bookmarks, emails already sent) are sent to the clean address,
// keeping the query string. express.static below finds the .html file.
app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  const p = req.path;
  if (p.startsWith("/api/") || p.startsWith("/uploads/") || p.startsWith("/vendor/")) return next();
  let clean = null;
  if (p.endsWith(".html")) clean = p.slice(0, -5);
  else if (p.endsWith("/index")) clean = p;
  if (clean === null) return next();
  if (clean.endsWith("/index")) clean = clean.slice(0, -5);
  const q = req.originalUrl.indexOf("?");
  return res.redirect(301, clean + (q >= 0 ? req.originalUrl.slice(q) : ""));
});

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
// Place search for the transport maps (delivery, pickup and operating
// points), through the routing service's geocoder. Rate limited.
// mode=suggest: address suggestions while typing (near lat/lng when given).
app.get("/api/geocode", limiter(400), async (req, res, next) => {
  try {
    const q = String(req.query.q || "").trim().slice(0, 120);
    if (q.length < 3) return res.json({ success: true, data: [] });
    const routing = require("./services/routing");
    if (req.query.mode === "suggest") {
      const focus = { lat: Number(req.query.lat), lng: Number(req.query.lng) };
      return res.json({ success: true, data: await routing.suggest(q, req.query.lat ? focus : null) });
    }
    res.json({ success: true, data: await routing.geocode(q) });
  } catch (error) {
    // Place search is a convenience: when the geocoder fails, the pin is placed by hand.
    console.error(`Place search failed: ${error.message}`);
    res.json({ success: true, data: [] });
  }
});
// What is at a point: the road and area under the map pin.
app.get("/api/geocode/reverse", limiter(400), async (req, res) => {
  const point = { lat: Number(req.query.lat), lng: Number(req.query.lng) };
  if (!(point.lat >= -18.5 && point.lat <= -7.8 && point.lng >= 21.5 && point.lng <= 34.2)) return res.json({ success: true, data: null });
  res.json({ success: true, data: await require("./services/routing").reverse(point) });
});
app.get("/api/map-config", (req, res) => {
  res.set("Cache-Control", "public, max-age=3600");
  res.json({ success: true, data: { tiles: MAP_TILES, attribution: MAP_ATTRIBUTION, search: Boolean(require("./services/routing").geocoderName()) } });
});
app.use("/api", publicRoutes);
app.use("/api/inquiries", inquiryRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/checkout", require("./routes/checkout"));
// Lipila's card page sends buyers back here (routes/checkout.js).
app.use("/pay", require("./routes/checkout").pages);
app.use("/api/payments", require("./routes/payments"));
app.use("/api/admin", adminRoutes);
app.use("/api/seller", sellerRoutes);
app.use("/api/buyer", require("./routes/buyer"));
app.use("/api/transport", require("./routes/transport"));
app.use("/api/newsletter", require("./routes/newsletter"));

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
          ? "Too many files. Please add fewer photos or documents."
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
  if (["ER_NO_SUCH_TABLE", "ER_BAD_FIELD_ERROR"].includes(err.code)) {
    console.error("Database out of date:", err.message, "- run: npm run db:setup");
    return res.status(500).json({
      success: false,
      message: "The database needs updating. On the server run: npm run db:setup, then restart the app.",
    });
  }
  if (err.status === 404 || err.statusCode === 404) {
    return res.status(404).json({ success: false, message: "Not found" });
  }
  console.error("Server error:", err);
  return res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
});

// Tables added by later updates are created at startup if missing, so a
// deploy that forgot "npm run db:setup" still works. Column changes still
// need db:setup.
const LATE_TABLES = ["seller_password_resets", "seller_sessions", "seller_notifications", "inquiry_messages", "orders", "app_state", "checkouts", "transaction_events", "buyers", "buyer_tokens", "buyer_notifications", "order_receipt_photos",
  "transport_providers", "transport_provider_documents", "transport_provider_sessions", "transport_provider_resets", "transport_provider_notifications",
  "transport_vehicles", "transport_vehicle_cargo", "transport_vehicle_files", "transport_price_bands", "transport_settings", "transport_bookings",
  "transport_booking_orders", "transport_offers", "transport_quantities", "transport_submissions", "transport_photos", "transport_disputes",
  "transport_events", "transport_locations", "transport_ratings", "platform_ratings",
  "newsletter_subscribers", "newsletter_campaigns", "newsletter_sends"];
// Columns added by later updates, added at startup when missing.
const LATE_COLUMNS = [
  ["livestock", "price", "DECIMAL(12,2) NULL AFTER quantity"],
  ["livestock", "price_unit", "ENUM('head', 'lot') NOT NULL DEFAULT 'head' AFTER price"],
  ["livestock", "price_negotiable", "TINYINT(1) NOT NULL DEFAULT 0 AFTER price_unit"],
  ["livestock", "went_live_at", "DATETIME NULL AFTER published_at"],
  ["orders", "mobile_operator", "ENUM('airtel', 'mtn', 'zamtel') NULL AFTER payment_method"],
  ["orders", "payment_phone", "VARCHAR(30) NULL AFTER mobile_operator"],
  ["orders", "payment_bank", "VARCHAR(80) NULL AFTER payment_phone"],
  ["orders", "payment_account", "VARCHAR(30) NULL AFTER payment_bank"],
  ["orders", "card_brand", "VARCHAR(20) NULL AFTER payment_account"],
  ["orders", "card_last4", "CHAR(4) NULL AFTER card_brand"],
  ["orders", "payment_status", "ENUM('unpaid', 'pending', 'paid', 'failed') NOT NULL DEFAULT 'unpaid' AFTER card_last4"],
  ["orders", "payment_reference", "VARCHAR(64) NULL AFTER payment_status"],
  ["orders", "payment_provider_ref", "VARCHAR(80) NULL AFTER payment_reference"],
  ["orders", "payment_failure", "VARCHAR(255) NULL AFTER payment_provider_ref"],
  ["orders", "payment_attempts", "TINYINT UNSIGNED NOT NULL DEFAULT 0 AFTER payment_failure"],
  ["orders", "payment_checked_at", "DATETIME NULL AFTER payment_attempts"],
  ["orders", "paid_at", "DATETIME NULL AFTER payment_checked_at"],
  ["orders", "public_token", "CHAR(32) NULL AFTER paid_at"],
  ["orders", "payment_reminder_at", "DATETIME NULL AFTER public_token"],
  ["orders", "checkout_id", "INT UNSIGNED NULL AFTER payment_reminder_at, ADD INDEX idx_orders_checkout (checkout_id)"],
  ["checkouts", "payment_provider", "VARCHAR(20) NULL AFTER payment_status"],
  ["checkouts", "payment_url", "VARCHAR(500) NULL AFTER payment_provider"],
  ["checkouts", "payment_started_at", "DATETIME NULL AFTER payment_checked_at"],
  ["checkouts", "payment_alert_at", "DATETIME NULL AFTER payment_started_at"],
  ["checkouts", "terms_accepted_at", "DATETIME NULL AFTER failure_emailed_ref"],
  ["checkouts", "payment_check_error", "VARCHAR(255) NULL AFTER payment_alert_at"],
  ["checkouts", "failure_emailed_ref", "VARCHAR(40) NULL AFTER payment_check_error"],
  ["orders", "hold_until", "DATETIME NULL AFTER stock_deducted"],
  ["checkouts", "payment_method", "ENUM('mobile_money', 'card', 'bank_transfer') NOT NULL DEFAULT 'mobile_money' AFTER payment_status"],
  ["checkouts", "buyer_id", "INT UNSIGNED NULL AFTER public_token, ADD INDEX idx_checkouts_buyer (buyer_id)"],
  ["orders", "buyer_id", "INT UNSIGNED NULL AFTER seller_notified_at, ADD INDEX idx_orders_buyer (buyer_id)"],
  ["orders", "handover_method", "ENUM('collected', 'delivered') NULL AFTER buyer_id"],
  ["orders", "handed_over_at", "DATETIME NULL AFTER handover_method"],
  ["orders", "handed_over_by", "VARCHAR(150) NULL AFTER handed_over_at"],
  ["orders", "received_at", "DATETIME NULL AFTER handed_over_by"],
  ["orders", "received_note", "VARCHAR(500) NULL AFTER received_at"],
  ["orders", "sent_method", "ENUM('collected', 'delivered') NULL AFTER received_note"],
  ["orders", "sent_at", "DATETIME NULL AFTER sent_method"],
  ["orders", "sent_by", "VARCHAR(150) NULL AFTER sent_at"],
  ["orders", "sent_note", "VARCHAR(500) NULL AFTER sent_by"],
  ["order_receipt_photos", "party", "ENUM('buyer', 'seller') NOT NULL DEFAULT 'buyer' AFTER order_id"],
  ["orders", "seller_paid_at", "DATETIME NULL AFTER sent_note"],
  ["orders", "seller_paid_by", "VARCHAR(150) NULL AFTER seller_paid_at"],
  ["orders", "seller_paid_ref", "VARCHAR(150) NULL AFTER seller_paid_by"],
  ["sellers", "pickup_district", "VARCHAR(80) NULL AFTER address"],
  ["sellers", "pickup_address", "VARCHAR(255) NULL AFTER pickup_district"],
  ["sellers", "pickup_lat", "DECIMAL(9,6) NULL AFTER pickup_address"],
  ["sellers", "pickup_lng", "DECIMAL(9,6) NULL AFTER pickup_lat"],
  ["orders", "transport_booking_id", "INT UNSIGNED NULL AFTER seller_paid_ref, ADD INDEX idx_orders_transport (transport_booking_id)"],
  ["checkouts", "delivery_option", "ENUM('collect', 'transport') NOT NULL DEFAULT 'collect' AFTER total"],
  ["checkouts", "transport_total", "DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER delivery_option"],
  ["transport_bookings", "vehicle_registration", "VARCHAR(30) NULL AFTER provider_paid_by"],
  ["transport_bookings", "vehicle_type", "VARCHAR(60) NULL AFTER vehicle_registration"],
  ["transport_bookings", "on_hold", "TINYINT(1) NOT NULL DEFAULT 0 AFTER vehicle_type"],
  ["transport_vehicles", "size_class", "ENUM('small', 'medium', 'large', 'extra_large') NULL AFTER vehicle_type"],
  ["transport_bookings", "vehicle_size", "ENUM('small', 'medium', 'large', 'extra_large') NULL AFTER cargo_summary"],
  ["transport_providers", "preferred_coverage_km", "DECIMAL(7,1) NULL AFTER coverage_active"],
  ["transport_providers", "preferred_coverage_at", "DATETIME NULL AFTER preferred_coverage_km"],
];
async function ensureLateTables() {
  const schema = require("fs").readFileSync(path.join(__dirname, "..", "database", "schema.sql"), "utf8");
  for (const table of LATE_TABLES) {
    const match = schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\) ENGINE=[^;]*;`));
    if (!match) continue;
    try {
      await pool.query(match[0]);
    } catch (error) {
      console.error(`Could not create table ${table}: ${error.message}. Run: npm run db:setup`);
    }
  }
  for (const [table, column, definition] of LATE_COLUMNS) {
    try {
      const [found] = await pool.query(
        "SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?",
        [table, column],
      );
      if (!found.length) await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    } catch (error) {
      console.error(`Could not add ${table}.${column}: ${error.message}. Run: npm run db:setup`);
    }
  }
  // Listings published before went_live_at existed count as having gone live.
  try {
    await pool.query("UPDATE livestock SET went_live_at = published_at WHERE went_live_at IS NULL AND published_at IS NOT NULL");
  } catch (error) {
    console.error(`Could not fill livestock.went_live_at: ${error.message}`);
  }
  // Proof of payment to the seller was added to the photo types later.
  try {
    const [[party]] = await pool.query(
      "SELECT COLUMN_TYPE AS type FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'order_receipt_photos' AND column_name = 'party'",
    );
    if (party && !party.type.includes("'payout'")) {
      await pool.query("ALTER TABLE order_receipt_photos MODIFY party ENUM('buyer', 'seller', 'payout') NOT NULL DEFAULT 'buyer'");
    }
  } catch (error) {
    console.error(`Could not update order_receipt_photos.party: ${error.message}. Run: npm run db:setup`);
  }
  // Card payments were added to the payment_method list later.
  try {
    const [[column]] = await pool.query(
      "SELECT COLUMN_TYPE AS type FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'orders' AND column_name = 'payment_method'",
    );
    if (column && !column.type.includes("'card'")) {
      await pool.query("ALTER TABLE orders MODIFY payment_method ENUM('mobile_money', 'bank_transfer', 'card') NOT NULL DEFAULT 'mobile_money'");
    }
  } catch (error) {
    console.error(`Could not update orders.payment_method: ${error.message}. Run: npm run db:setup`);
  }
}

if (require.main === module) {
  ensureLateTables();
  // Payment reminders and the team's morning summary.
  require("./services/scheduler").start();
  const server = app.listen(PORT, () => {
    console.log("\nFrontier Marketplace");
    console.log(`Running on http://localhost:${PORT}  (${process.env.NODE_ENV || "development"})`);
    const email = emailConfig();
    console.log(
      email.configured
        ? `Inquiry emails: ON - via ${email.host}:${email.port}${email.user ? ` as ${email.user}` : ""}, to ${email.recipients.join(", ")}\n`
        : `Inquiry emails: OFF - ${email.problems.join("; ")}. Inquiries are still saved; fix .env and restart.\n`,
    );
  });
  const shutdown = () => {
    console.log("\nShutting down...");
    server.close(() => {
      sessionStore.close().catch(() => {});
      sellerSessionStore.close().catch(() => {});
      transportSessionStore.close().catch(() => {});
      pool.end().finally(() => process.exit(0));
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

module.exports = app;
