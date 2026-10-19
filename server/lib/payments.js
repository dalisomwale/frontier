// Mobile money payments on the website, through Lenco.
//
// Placing an order with mobile money sends the buyer a PIN prompt on their
// phone. The checkout page then asks for the payment status every few
// seconds; Lenco also tells us by webhook. When the payment succeeds the
// order is marked paid and the buyer and team are emailed. If it fails
// (wrong PIN, not enough money, no answer) the order stays reserved and the
// buyer can try again or leave it for the team to arrange.
const crypto = require("crypto");
const pool = require("../db");
const lenco = require("../services/lenco");
const { sendEmail, recipients, appUrl } = require("../services/mailer");
const { orderRef, kwacha, OPERATOR_LABELS } = require("./orders");

const MAX_ATTEMPTS = 5;
const CHECK_EVERY_MS = 4000;

function newToken() {
  return crypto.randomBytes(16).toString("hex");
}

// "FM-1042-2": order FM-1042, second attempt.
function paymentReference(order, attempt) {
  return `${orderRef(order.id)}-${attempt}`;
}

function orderIdFromReference(reference) {
  const match = String(reference || "").match(/^FM-(\d+)-\d+$/);
  return match ? Number(match[1]) - 1000 : null;
}

function maskPhone(phone) {
  const local = lenco.localPhone(phone);
  return local.length >= 7 ? `${local.slice(0, 4)} ••• ${local.slice(-3)}` : local;
}

// What the checkout page is told about a payment.
function publicView(order) {
  return {
    status: order.payment_status,
    failure: order.payment_status === "failed" ? order.payment_failure : null,
    operator: OPERATOR_LABELS[order.mobile_operator] || "Mobile money",
    phone: maskPhone(order.payment_phone),
    total: Number(order.total),
    attempts_left: Math.max(0, MAX_ATTEMPTS - Number(order.payment_attempts || 0)),
    order_status: order.status,
  };
}

async function loadOrder(id) {
  const [[order]] = await pool.query("SELECT * FROM orders WHERE id = ?", [id]);
  return order || null;
}

async function markPaid(order, data) {
  const [result] = await pool.query(
    `UPDATE orders SET payment_status = 'paid', payment_failure = NULL, paid_at = NOW(),
       payment_provider_ref = COALESCE(?, payment_provider_ref),
       status = IF(status IN ('new', 'confirmed'), 'paid', status)
     WHERE id = ? AND payment_status <> 'paid'`,
    [data.lencoReference || (data.mobileMoneyDetails && data.mobileMoneyDetails.operatorTransactionId) || null, order.id],
  );
  if (!result.affectedRows) return;
  const ref = orderRef(order.id);
  const how = `${OPERATOR_LABELS[order.mobile_operator] || "Mobile money"} (${lenco.localPhone(order.payment_phone)})`;
  const rows = [
    ["Order", ref],
    ["Listing", order.livestock_title],
    ["Amount paid", kwacha(data.amount || order.total)],
    ["Paid with", how],
  ];
  if (data.lencoReference) rows.push(["Payment reference", data.lencoReference]);
  sendEmail({
    to: order.email,
    subject: `Payment received for order ${ref}`,
    heading: "Payment received",
    paragraphs: [
      `Hi ${order.full_name}, we've received your payment of ${kwacha(data.amount || order.total)} for order ${ref}. Thank you.`,
      "We'll contact you on both WhatsApp and email to arrange collection.",
    ],
    rows,
  });
  sendEmail({
    to: recipients(),
    subject: `Order ${ref} paid: ${order.livestock_title}`,
    heading: `Order ${ref} has been paid`,
    paragraphs: [`${order.full_name} paid ${kwacha(data.amount || order.total)} by ${how}. The order is now marked paid.`],
    rows: [...rows, ["Buyer", order.full_name], ["WhatsApp", order.phone]],
    button: { label: "Open order", url: appUrl(`/admin/orders.html?id=${order.id}`) },
  });
}

async function markFailed(order, reason, reference) {
  await pool.query(
    `UPDATE orders SET payment_status = 'failed', payment_failure = ?
     WHERE id = ? AND payment_status <> 'paid' AND (? IS NULL OR payment_reference = ?)`,
    [String(reason || "The payment was not completed.").slice(0, 255), order.id, reference || null, reference || null],
  );
}

// Applies a collection result from Lenco (start, status check or webhook).
async function applyCollection(order, data) {
  const status = data && data.status;
  if (status === "successful") {
    // Never mark an order paid for less than its total.
    if (Number(data.amount) + 0.005 < Number(order.total)) {
      return markFailed(order, "The amount paid did not match the order. Our team will contact you.", data.reference);
    }
    return markPaid(order, data);
  }
  if (status === "failed") return markFailed(order, data.reasonForFailure, data.reference);
}

// Sends the PIN prompt. Optionally with a different operator / number.
async function startCollection(order, changes = {}) {
  const attempt = Number(order.payment_attempts || 0) + 1;
  const reference = paymentReference(order, attempt);
  const operator = changes.mobile_operator || order.mobile_operator;
  const phone = changes.payment_phone || order.payment_phone;
  await pool.query(
    `UPDATE orders SET payment_status = 'pending', payment_reference = ?, payment_failure = NULL,
       payment_attempts = ?, payment_checked_at = NOW(), mobile_operator = ?, payment_phone = ?
     WHERE id = ?`,
    [reference, attempt, operator, phone, order.id],
  );
  const current = { ...order, payment_reference: reference, payment_attempts: attempt, mobile_operator: operator, payment_phone: phone };
  try {
    const data = await lenco.collectMobileMoney({ amount: order.total, reference, phone, operator });
    await applyCollection(current, { ...data, reference });
  } catch (error) {
    console.error(`Order ${orderRef(order.id)}: payment request failed (${error.message})`);
    await markFailed(current, `We couldn't send the payment request: ${error.message}`, reference);
  }
  return loadOrder(order.id);
}

// Asks Lenco for news on a pending payment (at most every few seconds).
async function refresh(order) {
  if (order.payment_status !== "pending" || !order.payment_reference || !lenco.enabled()) return order;
  const last = order.payment_checked_at ? new Date(order.payment_checked_at).getTime() : 0;
  if (Date.now() - last < CHECK_EVERY_MS) return order;
  await pool.query("UPDATE orders SET payment_checked_at = NOW() WHERE id = ?", [order.id]);
  try {
    const data = await lenco.collectionStatus(order.payment_reference);
    await applyCollection(order, { ...data, reference: data.reference || order.payment_reference });
  } catch (error) {
    // Not found yet or a network blip: keep waiting.
    if (error.status !== 404) console.error(`Order ${orderRef(order.id)}: status check failed (${error.message})`);
  }
  return loadOrder(order.id);
}

module.exports = {
  MAX_ATTEMPTS,
  newToken,
  publicView,
  loadOrder,
  startCollection,
  refresh,
  applyCollection,
  orderIdFromReference,
};
