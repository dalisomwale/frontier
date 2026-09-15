const express = require("express");
const pool = require("../db");
const { isAuthenticated } = require("../middleware/auth");

const router = express.Router();

const positiveId = (value) => {
  const id = Number.parseInt(value, 10);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

// A small reporting endpoint is required for the administrator's report queue.
// It accepts exactly one report target and never lets the reporter be supplied
// by the browser.
router.post("/", isAuthenticated, async (req, res, next) => {
  try {
    const reason = typeof req.body.reason === "string" ? req.body.reason.trim() : "";
    const reportedUserId = req.body.reported_user_id ? positiveId(req.body.reported_user_id) : null;
    const listingId = req.body.listing_id ? positiveId(req.body.listing_id) : null;
    const messageId = req.body.message_id ? positiveId(req.body.message_id) : null;
    const targets = [reportedUserId, listingId, messageId].filter(Boolean);
    if (!reason || reason.length > 255 || targets.length !== 1) {
      return res.status(400).json({ success: false, message: "Provide one report target and a reason of up to 255 characters" });
    }
    if (reportedUserId === req.session.userId) {
      return res.status(400).json({ success: false, message: "You cannot report your own account" });
    }
    const [result] = await pool.query(
      "INSERT INTO reports (reporter_id, reported_user_id, listing_id, message_id, reason) VALUES (?, ?, ?, ?, ?)",
      [req.session.userId, reportedUserId, listingId, messageId, reason],
    );
    return res.status(201).json({ success: true, message: "Report submitted for review", data: { id: result.insertId } });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
