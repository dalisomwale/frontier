// Payment provider callbacks. Lenco posts here when a collection succeeds or
// fails: set the webhook URL in the Lenco dashboard to
//   https://<your site>/api/payments/lenco/webhook
const express = require("express");
const lenco = require("../services/lenco");
const payments = require("../lib/payments");

const router = express.Router();

router.post("/lenco/webhook", async (req, res) => {
  if (!lenco.validSignature(req.rawBody, req.get("X-Lenco-Signature"))) {
    return res.status(401).json({ success: false, message: "Invalid signature." });
  }
  try {
    const { event, data } = req.body || {};
    if (data && /^collection\./.test(String(event || ""))) {
      const id = payments.orderIdFromReference(data.reference);
      const order = id ? await payments.loadOrder(id) : null;
      if (order) await payments.applyCollection(order, data);
    }
  } catch (error) {
    console.error(`Lenco webhook: ${error.message}`);
  }
  res.json({ success: true });
});

module.exports = router;
