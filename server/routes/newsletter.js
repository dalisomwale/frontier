// Public newsletter endpoints: sign up (footer form), unsubscribe and
// subscribe again (the link in every newsletter email).
const express = require("express");
const newsletter = require("../lib/newsletter");

const router = express.Router();

router.post("/subscribe", async (req, res, next) => {
  try {
    // A hidden field people never see: anything in it is a bot.
    if (req.body && req.body.website) return res.json({ success: true, message: "Thank you! You're subscribed." });
    await newsletter.subscribe(req.body && req.body.email, "footer");
    res.json({ success: true, message: "Thank you! You're subscribed. Check your inbox for a welcome email." });
  } catch (error) {
    next(error);
  }
});

router.get("/status", async (req, res, next) => {
  try {
    const sub = await newsletter.byToken(req.query.token);
    if (!sub) return res.status(404).json({ success: false, message: "This link isn't valid. It may be incomplete: please use the link from the email." });
    res.json({ success: true, data: { email: sub.email, subscribed: sub.status === "subscribed" } });
  } catch (error) {
    next(error);
  }
});

// Also the target of mail apps' one-click unsubscribe (token in the query).
router.post("/unsubscribe", async (req, res, next) => {
  try {
    const sub = await newsletter.unsubscribe((req.body && req.body.token) || req.query.token);
    res.json({ success: true, message: "You're unsubscribed.", data: { email: sub.email } });
  } catch (error) {
    next(error);
  }
});

router.post("/resubscribe", async (req, res, next) => {
  try {
    const sub = await newsletter.resubscribe(req.body && req.body.token);
    res.json({ success: true, message: "You're subscribed again.", data: { email: sub.email } });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
