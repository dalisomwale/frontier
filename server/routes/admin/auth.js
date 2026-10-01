const express = require("express");
const bcrypt = require("bcrypt");
const pool = require("../../db");
const { requireAdmin } = require("../../middleware/auth");
const { text, badRequest } = require("../../lib/validate");

const router = express.Router();

// Compared against when the email is unknown, so a wrong email and a wrong
// password take the same time and can't be told apart.
const DUMMY_HASH = bcrypt.hashSync("frontier-timing-guard", 12);

router.post("/login", async (req, res, next) => {
  try {
    const email = text(req.body.email, 255);
    const password = typeof req.body.password === "string" ? req.body.password : "";
    if (!email || !password) throw badRequest("Email and password are required.");

    const [rows] = await pool.query(
      "SELECT id, name, email, password_hash FROM admins WHERE email = ?",
      [email.toLowerCase()],
    );
    const admin = rows[0];
    const valid = await bcrypt.compare(password, admin ? admin.password_hash : DUMMY_HASH);
    if (!admin || !valid) {
      return res
        .status(401)
        .json({ success: false, message: "Incorrect email or password." });
    }

    // New session id on login prevents session fixation.
    req.session.regenerate(async (error) => {
      if (error) return next(error);
      req.session.adminId = admin.id;
      await pool.query("UPDATE admins SET last_login_at = NOW() WHERE id = ?", [admin.id]);
      req.session.save((saveError) => {
        if (saveError) return next(saveError);
        return res.json({
          success: true,
          data: { id: admin.id, name: admin.name, email: admin.email },
        });
      });
    });
  } catch (error) {
    next(error);
  }
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie(req.app.get("sessionCookieName"));
    res.json({ success: true });
  });
});

router.get("/me", requireAdmin, (req, res) => {
  res.json({ success: true, data: req.admin });
});

router.patch("/me/password", requireAdmin, async (req, res, next) => {
  try {
    const current = String(req.body.current_password || "");
    const next_ = String(req.body.new_password || "");
    if (next_.length < 10) throw badRequest("New password must be at least 10 characters.");

    const [[row]] = await pool.query("SELECT password_hash FROM admins WHERE id = ?", [req.admin.id]);
    if (!(await bcrypt.compare(current, row.password_hash))) {
      throw badRequest("Your current password is incorrect.");
    }
    await pool.query("UPDATE admins SET password_hash = ? WHERE id = ?", [
      await bcrypt.hash(next_, 12),
      req.admin.id,
    ]);
    res.json({ success: true, message: "Password updated." });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
