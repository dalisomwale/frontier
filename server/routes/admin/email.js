// Email status for the admin dashboard: shows whether inquiry emails are set
// up, sends a test email, and resends notifications that failed.
const express = require("express");
const pool = require("../../db");
const { emailConfig, verifyEmail, sendInquiryNotification } = require("../../services/mailer");

const router = express.Router();

router.get("/status", (req, res) => {
  const config = emailConfig();
  res.json({
    success: true,
    data: {
      configured: config.configured,
      problems: config.problems,
      host: config.host,
      port: config.port,
      user: config.user,
      from: config.from,
      recipients: config.recipients,
    },
  });
});

router.post("/test", async (req, res, next) => {
  try {
    const check = await verifyEmail();
    if (!check.ok) return res.status(400).json({ success: false, message: check.message });
    const config = emailConfig();
    await sendInquiryNotification({
      livestock_title: "TEST - Frontier email check",
      animal_name: "Cattle",
      category_name: "Beef",
      breed_name: "Boran",
      full_name: req.admin.name,
      phone: "+260 000 000 000",
      email: req.admin.email,
      message: "Test email sent from the admin dashboard. If you received it, inquiry notifications are working.",
      created_at: new Date(),
    });
    res.json({ success: true, message: `Test email sent to ${config.recipients.join(" and ")}.` });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Resend every notification that failed (oldest first). Stops at the first
// failure when it's a settings problem, so it doesn't hammer the server.
router.post("/resend-failed", async (req, res, next) => {
  try {
    const check = await verifyEmail();
    if (!check.ok) return res.status(400).json({ success: false, message: check.message });
    const [rows] = await pool.query(
      "SELECT * FROM inquiries WHERE email_status = 'failed' AND is_archived = 0 ORDER BY created_at ASC LIMIT 50",
    );
    let sent = 0;
    let failed = 0;
    let lastError = "";
    for (const row of rows) {
      try {
        await sendInquiryNotification({ ...row, created_at: new Date(row.created_at) });
        await pool.query("UPDATE inquiries SET email_status = 'sent', email_error = NULL WHERE id = ?", [row.id]);
        sent++;
      } catch (error) {
        failed++;
        lastError = error.message;
        await pool.query("UPDATE inquiries SET email_error = ? WHERE id = ?", [lastError.slice(0, 500), row.id]);
      }
    }
    res.json({
      success: true,
      data: { sent, failed },
      message: failed
        ? `Sent ${sent}, ${failed} still failing: ${lastError}`
        : `Sent ${sent} notification email${sent === 1 ? "" : "s"}.`,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
