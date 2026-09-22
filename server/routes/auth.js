const express = require("express");
const bcrypt = require("bcrypt");
const pool = require("../db");
const { isAuthenticated } = require("../middleware/auth");

const router = express.Router();

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normalize = (value) => (typeof value === "string" ? value.trim() : "");

async function createSession(req, user) {
  req.session.userId = user.id;
  req.session.userRole = user.role;
  req.session.userName = user.name;
}

// POST /api/auth/register
router.post("/register", async (req, res) => {
  try {
    const { phone, password, confirmPassword, role } = req.body;
    const name = normalize(req.body.name);
    const email = normalize(req.body.email).toLowerCase();
    const location = normalize(req.body.location);

    // Validation
    if (
      !name ||
      !email ||
      !password ||
      !confirmPassword ||
      !location ||
      !role
    ) {
      return res.status(400).json({
        success: false,
        message: "All fields are required",
      });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({
        success: false,
        message: "Passwords do not match",
      });
    }

    if (typeof password !== "string" || password.length < 8) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 8 characters",
      });
    }

    if (
      !emailPattern.test(email) ||
      name.length > 255 ||
      location.length > 255 ||
      (phone && String(phone).length > 20)
    ) {
      return res.status(400).json({
        success: false,
        message: "Please provide valid registration details",
      });
    }

    const validRoles = ["member", "service_provider"];
    if (!validRoles.includes(role)) {
      return res.status(400).json({
        success: false,
        message: "Invalid role selected",
      });
    }

    // Check if email already exists
    const [existingUsers] = await pool.query(
      "SELECT id FROM users WHERE email = ?",
      [email],
    );

    if (existingUsers.length > 0) {
      return res.status(409).json({
        success: false,
        message: "Email already registered",
      });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Create user
    const [result] = await pool.query(
      "INSERT INTO users (name, email, phone, password_hash, role, location) VALUES (?, ?, ?, ?, ?, ?)",
      [name, email, phone || null, passwordHash, role, location],
    );

    // Set session
    await createSession(req, { id: result.insertId, role, name });

    return res.status(201).json({
      success: true,
      message: "Registration successful",
      data: {
        id: result.insertId,
        name,
        email,
        role,
      },
    });
  } catch (error) {
    console.error("Registration error:", error);
    return res.status(500).json({
      success: false,
      message: "Registration failed",
    });
  }
});

// POST /api/auth/login
router.post("/login", async (req, res) => {
  try {
    const email = normalize(req.body.email).toLowerCase();
    const { password } = req.body;

    // Validation
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required",
      });
    }

    // Get user
    const [users] = await pool.query(
      "SELECT id, name, email, password_hash, role, status FROM users WHERE email = ?",
      [email],
    );

    if (users.length === 0) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    const user = users[0];

    // Check if user is suspended
    if (user.status === "suspended") {
      return res.status(403).json({
        success: false,
        message: "Account has been suspended",
      });
    }

    // Verify password
    const passwordMatch = await bcrypt.compare(password, user.password_hash);

    if (!passwordMatch) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    // Set session
    await createSession(req, user);

    return res.json({
      success: true,
      message: "Login successful",
      data: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    return res.status(500).json({
      success: false,
      message: "Login failed",
    });
  }
});

// POST /api/auth/logout
router.post("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({
        success: false,
        message: "Logout failed",
      });
    }
    return res.json({
      success: true,
      message: "Logout successful",
    });
  });
});

// POST /api/auth/forgot-password
router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email is required",
      });
    }

    // Email delivery is deliberately not simulated. Connect a transactional
    // provider here before enabling resets in production.
    return res.status(501).json({
      success: false,
      message:
        "Password reset email is not configured. Please contact platform developers.",

    });
  } catch (error) {
    console.error("Forgot password error:", error);
    return res.status(500).json({
      success: false,
      message: "Request failed",
    });
  }
});

// POST /api/auth/setup-admin
// One-time, environment-protected administrator bootstrap. It is unavailable
// once any administrator exists and cannot be used without a deployment secret.
router.post("/setup-admin", async (req, res) => {
  try {
    const setupToken = req.get("x-admin-setup-token");
    if (
      !process.env.ADMIN_SETUP_TOKEN ||
      !setupToken ||
      setupToken !== process.env.ADMIN_SETUP_TOKEN
    ) {
      return res.status(403).json({
        success: false,
        message: "Administrator setup is not authorized",
      });
    }
    const [admins] = await pool.query(
      "SELECT id FROM users WHERE role = 'admin' LIMIT 1",
    );
    if (admins.length) {
      return res.status(409).json({
        success: false,
        message: "An administrator has already been configured",
      });
    }
    const name = normalize(req.body.name);
    const email = normalize(req.body.email).toLowerCase();
    const location = normalize(req.body.location);
    const password = req.body.password;
    if (
      !name ||
      !location ||
      !emailPattern.test(email) ||
      typeof password !== "string" ||
      password.length < 12
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Name, location, a valid email, and a 12-character password are required",
      });
    }
    const hash = await bcrypt.hash(password, 12);
    const [result] = await pool.query(
      "INSERT INTO users (name, email, phone, password_hash, role, location) VALUES (?, ?, ?, ?, 'admin', ?)",
      [name, email, normalize(req.body.phone) || null, hash, location],
    );
    return res.status(201).json({
      success: true,
      message: "Administrator account created",
      data: { id: result.insertId },
    });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY")
      return res
        .status(409)
        .json({ success: false, message: "Email already registered" });
    return res
      .status(500)
      .json({ success: false, message: "Administrator setup failed" });
  }
});

// GET /api/auth/check
router.get("/check", isAuthenticated, async (req, res) => {
  try {
    const [users] = await pool.query(
      "SELECT id, name, email, role, location FROM users WHERE id = ?",
      [req.session.userId],
    );

    if (users.length === 0) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const user = users[0];
    return res.json({
      success: true,
      authenticated: true,
      data: user,
    });
  } catch (error) {
    console.error("Auth check error:", error);
    return res.status(500).json({
      success: false,
      message: "Auth check failed",
    });
  }
});

module.exports = router;
