// Payment provider callbacks. Lenco posts here when a collection succeeds or
// fails: set the webhook URL in the Lenco dashboard to
//   https://<your site>/api/payments/lenco/webhook
const express = require("express");
const lenco = require("../services/lenco");
const payments = require("../lib/payments");
const checkout = require("../lib/checkout");

const router = express.Router();

router.post("/lenco/webhook", async (req, res) => {
  if (!lenco.validSignature(req.rawBody, req.get("X-Lenco-Signature"))) {
    return res.status(401).json({ success: false, message: "Invalid signature." });
  }
  try {
    const { event, data } = req.body || {};
    if (data && /^collection\./.test(String(event || ""))) {
      // "FMC-1003-1": a cart checkout; "FM-1042-1": a single order.
      const checkoutId = checkout.checkoutIdFromReference(data.reference);
      if (checkoutId) {
        const found = await checkout.load(checkoutId);
        if (found) await checkout.applyCollection(found, data);
      } else {
        const id = payments.orderIdFromReference(data.reference);
        const order = id ? await payments.loadOrder(id) : null;
        if (order) await payments.applyCollection(order, data);
      }
    }
  } catch (error) {
    console.error(`Lenco webhook: ${error.message}`);
  }
  res.json({ success: true });
});

// Lipila calls this when a mobile money payment finishes. The call itself is
// not trusted: we look up our open payment by its reference and ask Lipila's
// check-status, which is what marks the orders paid.
router.post("/lipila/callback", async (req, res) => {
  res.status(200).json({ received: true });
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const event = body.data && typeof body.data === "object" ? body.data : body;
    const reference = String(event.referenceId || event.referenceData || "").trim();
    const id = checkout.checkoutIdFromReference(reference);
    if (!id) return;
    const found = await checkout.load(id);
    if (found && found.payment_provider === "lipila" && found.payment_status === "pending" && found.payment_reference === reference) {
      await checkout.refreshLipila(found);
    }
  } catch (error) {
    console.error("Lipila callback:", error.message);
  }
});

module.exports = router;
