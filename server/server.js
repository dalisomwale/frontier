require("dotenv").config();

const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const http = require("http");
const socketIO = require("socket.io");

const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/users");
const listingRoutes = require("./routes/listings");
const messageRoutes = require("./routes/messages");
const inquiriesRoutes = require("./routes/inquiries");
const favoritesRoutes = require("./routes/favorites");
const adminRoutes = require("./routes/admin");
const reportsRoutes = require("./routes/reports");

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin:
      process.env.CORS_ORIGIN || `http://localhost:${process.env.PORT || 5000}`,
    methods: ["GET", "POST"],
  },
});

const PORT = process.env.PORT || 5000;
const corsOrigin = process.env.CORS_ORIGIN || `http://localhost:${PORT}`;

if (process.env.NODE_ENV === "production" && !process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET must be set in production");
}

// Security middleware. The frontend uses Tailwind's browser build and Socket.IO
// from their CDNs, plus small inline page scripts and event handlers. Helmet's
// default CSP blocks them, leaving the pages looking like unstyled HTML.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        "script-src": [
          "'self'",
          "'unsafe-inline'",
          "https://cdn.tailwindcss.com",
          "https://cdn.socket.io",
        ],
        "script-src-attr": ["'unsafe-inline'"],
        "style-src": ["'self'", "'unsafe-inline'"],
        "connect-src": ["'self'", "wss:"],
      },
    },
  }),
);
app.use(
  cors({
    origin: corsOrigin,
    credentials: true,
  }),
);

// Rate limiting
// Both limiters return JSON explicitly. express-rate-limit's default
// response is plain text, which breaks any frontend code that calls
// response.json() on it - the request silently "fails" with a generic
// parse error instead of a real "too many attempts" message.
const jsonRateLimitHandler = (req, res) => {
  res.status(429).json({
    success: false,
    message: "Too many attempts. Please wait a few minutes and try again.",
  });
};

// Scoped to /api only, so loading pages, scripts, and stylesheets during
// normal browsing doesn't eat into the same budget as API calls.
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  handler: jsonRateLimitHandler,
});

// Applied only to /api/auth/login and /api/auth/register (see below),
// not the whole /api/auth router. /api/auth/check fires on nearly every
// page load via checkAuthentication(), so sharing one 5-request budget
// across it and actual login/register attempts meant a normal browsing
// session could exhaust the limit before the user ever submitted the
// registration form.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  handler: jsonRateLimitHandler,
});

app.use("/api", limiter);

// Body parsing middleware
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// Session middleware
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || "development-only-change-this-secret",
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: "lax",
    maxAge: 24 * 60 * 60 * 1000,
  },
});
app.use(sessionMiddleware);

// Static files
app.use(express.static("public"));

// API Routes
// authLimiter is scoped to only the login/register endpoints, not the whole
// router - see the comment above where it's defined.
app.use("/api/auth/login", authLimiter);
app.use("/api/auth/register", authLimiter);
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/listings", listingRoutes);
app.use("/api/messages", messageRoutes);
app.use("/api/inquiries", inquiriesRoutes);
app.use("/api/favorites", favoritesRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/reports", reportsRoutes);

// Socket.IO shares the HTTP session, so clients cannot impersonate another
// account by supplying a user id in a socket event.
io.use((socket, next) => sessionMiddleware(socket.request, {}, next));
io.use((socket, next) => {
  if (!socket.request.session?.userId)
    return next(new Error("Authentication required"));
  socket.data.userId = socket.request.session.userId;
  return next();
});
io.on("connection", (socket) => {
  const room = "user:" + socket.data.userId;
  socket.join(room);
  socket.broadcast.emit("user_online", { userId: socket.data.userId });
  socket.on("user_join", () =>
    socket.emit("joined", { userId: socket.data.userId }),
  );
  socket.on("disconnect", () =>
    socket.broadcast.emit("user_offline", { userId: socket.data.userId }),
  );
});
app.set("io", io);

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "API endpoint not found",
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error("Server error:", err);

  // Multer file upload errors
  if (err.name === "MulterError") {
    return res.status(400).json({
      success: false,
      message: err.message,
    });
  }

  // Expected validation/upload errors are safe to show. Unexpected errors are
  // deliberately not returned to clients.
  if (err.message && (err.name === "Error" || err.status === 400)) {
    return res.status(400).json({
      success: false,
      message: err.message,
    });
  }

  res.status(500).json({
    success: false,
    message: "Internal server error",
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`\nFrontier Marketplace Server`);
  console.log(`Running on http://localhost:${PORT}`);
  console.log(`Port: ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || "development"}\n`);
});

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\nShutting down server...");
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});

module.exports = app;
