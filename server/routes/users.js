const express = require("express");
const pool = require("../db");
const { isAuthenticated } = require("../middleware/auth");

const router = express.Router();

// GET /api/users/profile
router.get("/profile", isAuthenticated, async (req, res) => {
  try {
    const [users] = await pool.query(
      "SELECT id, name, email, phone, role, location, service_description, profile_image, status, created_at FROM users WHERE id = ?",
      [req.session.userId],
    );

    if (users.length === 0) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    return res.json({
      success: true,
      data: users[0],
    });
  } catch (error) {
    console.error("Get profile error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to retrieve profile",
    });
  }
});

// PUT /api/users/profile
router.put("/profile", isAuthenticated, async (req, res) => {
  try {
    const { name, phone, location, serviceDescription } = req.body;

    if (!name && !phone && !location && serviceDescription === undefined) {
      return res.status(400).json({
        success: false,
        message: "At least one field must be provided",
      });
    }

    const updates = [];
    const values = [];

    if (name) {
      updates.push("name = ?");
      values.push(name);
    }
    if (phone) {
      updates.push("phone = ?");
      values.push(phone);
    }
    if (location) {
      updates.push("location = ?");
      values.push(location);
    }
    if (serviceDescription !== undefined) {
      if (req.session.userRole !== "service_provider" || typeof serviceDescription !== "string" || serviceDescription.trim().length > 1000) {
        return res.status(400).json({ success: false, message: "Service description is invalid" });
      }
      updates.push("service_description = ?");
      values.push(serviceDescription.trim() || null);
    }

    values.push(req.session.userId);

    const query = `UPDATE users SET ${updates.join(", ")} WHERE id = ?`;

    await pool.query(query, values);

    return res.json({
      success: true,
      message: "Profile updated successfully",
    });
  } catch (error) {
    console.error("Update profile error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update profile",
    });
  }
});

// PUT /api/users/password
router.put("/password", isAuthenticated, async (req, res) => {
  try {
    const bcrypt = require("bcrypt");
    const { currentPassword, newPassword, confirmPassword } = req.body;
    if (typeof currentPassword !== "string" || typeof newPassword !== "string" || newPassword.length < 8 || newPassword !== confirmPassword) {
      return res.status(400).json({ success: false, message: "Provide your current password and matching new passwords of at least 8 characters" });
    }
    const [users] = await pool.query("SELECT password_hash FROM users WHERE id = ?", [req.session.userId]);
    if (!users.length || !(await bcrypt.compare(currentPassword, users[0].password_hash))) {
      return res.status(401).json({ success: false, message: "Current password is incorrect" });
    }
    const passwordHash = await bcrypt.hash(newPassword, 12);
    await pool.query("UPDATE users SET password_hash = ? WHERE id = ?", [passwordHash, req.session.userId]);
    return res.json({ success: true, message: "Password updated successfully" });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Unable to update password" });
  }
});

// GET /api/users/:id
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const [users] = await pool.query(
      'SELECT id, name, role, location, service_description, profile_image, created_at FROM users WHERE id = ? AND status = "active"',
      [id],
    );

    if (users.length === 0) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    return res.json({
      success: true,
      data: users[0],
    });
  } catch (error) {
    console.error("Get user error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to retrieve user",
    });
  }
});

module.exports = router;
