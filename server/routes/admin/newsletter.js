// Admin > Newsletter: who's subscribed, and sending a newsletter to them.
const express = require("express");
const pool = require("../../db");
const newsletter = require("../../lib/newsletter");
const { positiveInt, notFound } = require("../../lib/validate");

const router = express.Router();

router.get("/subscribers", async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, email, status, source, subscribed_at, unsubscribed_at, created_at FROM newsletter_subscribers ORDER BY id DESC LIMIT 5000",
    );
    const [[sum]] = await pool.query(
      `SELECT SUM(status = 'subscribed') AS subscribed, SUM(status = 'unsubscribed') AS unsubscribed,
              SUM(status = 'subscribed' AND subscribed_at >= NOW() - INTERVAL 30 DAY) AS recent
       FROM newsletter_subscribers`,
    );
    res.json({
      success: true,
      data: rows,
      summary: { subscribed: Number(sum.subscribed) || 0, unsubscribed: Number(sum.unsubscribed) || 0, recent: Number(sum.recent) || 0 },
    });
  } catch (error) {
    next(error);
  }
});

// Removes someone from the list entirely (e.g. they asked to be forgotten).
router.delete("/subscribers/:id", async (req, res, next) => {
  try {
    const [r] = await pool.query("DELETE FROM newsletter_subscribers WHERE id = ?", [positiveInt(req.params.id) || 0]);
    if (!r.affectedRows) throw notFound("Subscriber not found.");
    res.json({ success: true, message: "Removed from the list." });
  } catch (error) {
    next(error);
  }
});

router.get("/campaigns", async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT c.*,
              (SELECT COUNT(*) FROM newsletter_sends s WHERE s.campaign_id = c.id AND s.status = 'sent') AS sent,
              (SELECT COUNT(*) FROM newsletter_sends s WHERE s.campaign_id = c.id AND s.status = 'failed') AS failed,
              (SELECT COUNT(*) FROM newsletter_sends s WHERE s.campaign_id = c.id AND s.status = 'pending') AS pending
       FROM newsletter_campaigns c ORDER BY c.id DESC LIMIT 200`,
    );
    res.json({ success: true, data: rows.map((r) => ({ ...r, sent: Number(r.sent), failed: Number(r.failed), pending: Number(r.pending) })) });
  } catch (error) {
    next(error);
  }
});

// { subject, heading, body, button_label, button_url, test }
// test: a copy to the signed-in admin only.
router.post("/campaigns", async (req, res, next) => {
  try {
    if (req.body.test === true || req.body.test === "1") {
      await newsletter.sendTest(req.body, req.admin.email);
      return res.json({ success: true, message: `Test sent to ${req.admin.email}.` });
    }
    const { id, recipients } = await newsletter.createCampaign(req.body, req.admin);
    res.status(201).json({ success: true, message: `Sending to ${recipients} subscriber${recipients === 1 ? "" : "s"}. This continues in the background.`, data: { id, recipients } });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
