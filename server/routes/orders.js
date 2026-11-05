// Single orders placed before the shopping cart. New orders go through the
// cart and checkout (routes/checkout.js); these endpoints remain so the
// "Try the payment again" links in earlier emails keep working.
const express = require("express");
const pool = require("../db");
const { positiveInt, text, isPhone, oneOf, badRequest, notFound } = require("../lib/validate");
const payments = require("../lib/payments");
const lenco = require("../services/lenco");

const router = express.Router();

// Whether mobile money is paid on the website (PIN prompt).
router.get("/payment-options", (req, res) => {
  res.json({ success: true, data: { mobile_money_online: lenco.enabled() } });
});

// The checkout page asks for the payment status every few seconds.
async function orderForBuyer(req) {
  const id = positiveInt(req.params.id);
  const token = String(req.query.token || req.body?.token || "");
  if (!id || !/^[a-f0-9]{32}$/.test(token)) throw notFound("Order not found.");
  const [[order]] = await pool.query("SELECT * FROM orders WHERE id = ? AND public_token = ?", [id, token]);
  if (!order) throw notFound("Order not found.");
  return order;
}

router.get("/:id/payment", async (req, res, next) => {
  try {
    const order = await payments.refresh(await orderForBuyer(req));
    res.json({ success: true, data: payments.publicView(order) });
  } catch (error) {
    next(error);
  }
});

// Try again: a new PIN prompt, optionally to another operator or number.
router.post("/:id/payment", async (req, res, next) => {
  try {
    if (!lenco.enabled()) throw badRequest("Mobile money payments on the website are not switched on.");
    const order = await orderForBuyer(req);
    if (order.payment_method !== "mobile_money") throw badRequest("This order is not paid by mobile money.");
    if (order.status === "cancelled") throw badRequest("This order has been cancelled.");
    if (order.payment_status === "paid") return res.json({ success: true, data: payments.publicView(order) });
    if (order.payment_status === "pending") throw badRequest("A payment request is already waiting on your phone.");
    if (Number(order.payment_attempts) >= payments.MAX_ATTEMPTS) {
      throw badRequest("Too many attempts. Our team will contact you to arrange payment.");
    }
    const changes = {};
    if (req.body.mobile_operator !== undefined || req.body.payment_phone !== undefined) {
      const operator = oneOf(req.body.mobile_operator, ["airtel", "mtn", "zamtel"]);
      const phone = text(req.body.payment_phone, 30);
      const errors = {};
      if (!operator) errors.mobile_operator = "Please choose your mobile money operator.";
      if (!phone || !isPhone(phone)) errors.payment_phone = "Please enter the mobile money number, e.g. 0977 123 456.";
      if (Object.keys(errors).length) return res.status(422).json({ success: false, message: "Please correct the highlighted fields.", errors });
      Object.assign(changes, { mobile_operator: operator, payment_phone: phone });
    }
    const updated = await payments.startCollection(order, changes);
    res.json({ success: true, data: payments.publicView(updated) });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
