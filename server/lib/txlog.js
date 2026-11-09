// Transaction audit trail: one row per step of a payment (order placed,
// payment request sent, Lipila's answers, confirmed or failed, stock, emails,
// and every admin action on the order). Rows are only ever added.
//
//   actor:  buyer | lipila | website | admin
//
// Recording never breaks a payment: errors are logged and ignored.
const pool = require("../db");

const MAX_DATA = 2000;

async function record({
  checkoutId, orderId = null, reference = null, event, status = null, amount = null,
  actor = "website", admin = null, detail = "", data = null, ip = null,
}) {
  if (!checkoutId || !event) return;
  try {
    await pool.query(
      `INSERT INTO transaction_events
         (checkout_id, order_id, reference, event, status, amount, actor, admin_id, admin_name, detail, data, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        checkoutId, orderId, reference ? String(reference).slice(0, 40) : null, String(event).slice(0, 40),
        status ? String(status).slice(0, 20) : null, amount === null || amount === undefined || amount === "" ? null : Number(amount),
        actor, admin ? admin.id : null, admin ? String(admin.name || admin.email || "Admin").slice(0, 120) : null,
        String(detail || "").slice(0, 500),
        data === null || data === undefined ? null : (typeof data === "string" ? data : JSON.stringify(data)).slice(0, MAX_DATA),
        ip ? String(ip).slice(0, 45) : null,
      ],
    );
  } catch (error) {
    console.error(`Transaction trail not recorded (${event}): ${error.message}`);
  }
}

// Records an email's outcome once sendEmail has finished.
function recordEmail(sending, { checkoutId, orderId = null, who, to }) {
  Promise.resolve(sending)
    .then((r) => record({
      checkoutId, orderId, event: r && r.sent ? "email_sent" : "email_failed",
      detail: r && r.sent ? `"${who === "team" ? "New paid order" : "Payment received"}" email sent to the ${who} (${to})` : `Email to the ${who} (${to}) not sent: ${(r && r.error) || "unknown error"}`,
    }))
    .catch(() => {});
}

module.exports = { record, recordEmail };
