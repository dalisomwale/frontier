// Admin > Transactions: every payment (one per cart checkout) with its full
// audit trail. Read-only: nothing here changes a payment or its history.
//
//   GET /api/admin/transactions          list, with filters and totals
//   GET /api/admin/transactions/export   the same list as CSV rows (JSON)
//   GET /api/admin/transactions/:id      one transaction: orders and timeline
const express = require("express");
const pool = require("../../db");
const { positiveInt, text, oneOf, badRequest, notFound } = require("../../lib/validate");
const { orderRef } = require("../../lib/orders");

const router = express.Router();

const STATUSES = ["paid", "pending", "failed", "unpaid"];
const METHODS = ["mobile_money", "card"];
const RANGES = { today: 0, "7d": 7, "30d": 30, "90d": 90, all: null };
const checkoutRef = (id) => `FMC-${1000 + Number(id)}`;

// Filters shared by the list and the export.
function filters(query) {
  const status = oneOf(query.status, STATUSES);
  const method = oneOf(query.method, METHODS);
  const range = Object.prototype.hasOwnProperty.call(RANGES, query.range) ? query.range : "30d";
  const q = text(query.q, 100) || "";
  const where = [];
  const args = [];
  if (status) { where.push("c.payment_status = ?"); args.push(status); }
  if (method) { where.push("c.payment_method = ?"); args.push(method); }
  if (range === "today") where.push("c.created_at >= CURDATE()");
  else if (RANGES[range]) { where.push("c.created_at >= NOW() - INTERVAL ? DAY"); args.push(RANGES[range]); }
  if (q) {
    // FMC-1020 / FM-1027 / FMC-1020-2 / Lipila ID / network reference / buyer
    const fmc = q.match(/^FMC-(\d+)/i);
    const fm = q.match(/^FM-(\d+)$/i);
    const like = `%${q}%`;
    const parts = ["c.full_name LIKE ?", "c.email LIKE ?", "c.phone LIKE ?", "c.payment_phone LIKE ?", "c.payment_reference LIKE ?", "c.payment_provider_ref LIKE ?"];
    const vals = [like, like, like, like, like, like];
    if (fmc) { parts.push("c.id = ?"); vals.push(Number(fmc[1]) - 1000); }
    if (fm) { parts.push("c.id = (SELECT checkout_id FROM orders WHERE id = ?)"); vals.push(Number(fm[1]) - 1000); }
    parts.push("c.id IN (SELECT checkout_id FROM transaction_events WHERE reference LIKE ? OR detail LIKE ?)");
    vals.push(like, like);
    where.push(`(${parts.join(" OR ")})`);
    args.push(...vals);
  }
  return { sql: where.length ? `WHERE ${where.join(" AND ")}` : "", args, applied: { status: status || "", method: method || "", range, q } };
}

const LIST_FIELDS = `
  c.id, c.created_at, c.full_name, c.email, c.phone, c.total, c.payment_method, c.payment_provider,
  c.payment_status, c.payment_reference, c.payment_provider_ref, c.payment_attempts, c.mobile_operator,
  c.payment_phone, c.payment_failure, c.paid_at, c.payment_alert_at,
  (SELECT COUNT(*) FROM orders o WHERE o.checkout_id = c.id) AS items,
  (SELECT GROUP_CONCAT(o.livestock_title ORDER BY o.id SEPARATOR ', ') FROM orders o WHERE o.checkout_id = c.id) AS titles,
  (SELECT COUNT(*) FROM transaction_events e WHERE e.checkout_id = c.id) AS events`;

function shape(row) {
  return { ...row, reference: checkoutRef(row.id), total: Number(row.total), alerted: Boolean(row.payment_alert_at) };
}

router.get("/", async (req, res, next) => {
  try {
    const page = positiveInt(req.query.page) || 1;
    const limit = 25;
    const f = filters(req.query);
    const [rows] = await pool.query(
      `SELECT ${LIST_FIELDS} FROM checkouts c ${f.sql} ORDER BY c.id DESC LIMIT ? OFFSET ?`,
      [...f.args, limit, (page - 1) * limit],
    );
    const [[totals]] = await pool.query(
      `SELECT COUNT(*) AS count,
         SUM(c.payment_status = 'paid') AS paid, SUM(c.payment_status = 'pending') AS pending,
         SUM(c.payment_status = 'failed') AS failed, SUM(c.payment_status = 'unpaid') AS unpaid,
         COALESCE(SUM(IF(c.payment_status = 'paid', c.total, 0)), 0) AS paid_amount
       FROM checkouts c ${f.sql}`,
      f.args,
    );
    res.json({
      success: true,
      data: rows.map(shape),
      totals: { ...totals, paid_amount: Number(totals.paid_amount), count: Number(totals.count) },
      filters: f.applied,
      page,
      pages: Math.max(1, Math.ceil(Number(totals.count) / limit)),
    });
  } catch (error) {
    next(error);
  }
});

// The filtered list as rows for a CSV file (up to 5,000), built in the browser.
router.get("/export", async (req, res, next) => {
  try {
    const f = filters(req.query);
    const [rows] = await pool.query(`SELECT ${LIST_FIELDS} FROM checkouts c ${f.sql} ORDER BY c.id DESC LIMIT 5000`, f.args);
    const header = ["Order", "Date", "Buyer", "Email", "Phone", "Items", "Amount (ZMW)", "Method", "Network", "Paying number",
      "Status", "Payment reference", "Lipila ID", "Attempts", "Paid at", "Reason not completed"];
    const fmt = (d) => (d ? new Date(d).toISOString().replace("T", " ").slice(0, 19) : "");
    const lines = rows.map((r) => [
      checkoutRef(r.id), fmt(r.created_at), r.full_name, r.email, r.phone, r.titles || "", Number(r.total).toFixed(2),
      r.payment_method === "card" ? "Visa / Mastercard" : r.payment_method === "mobile_money" ? "Mobile money" : r.payment_method || "",
      r.mobile_operator || "", r.payment_phone || "", r.payment_status, r.payment_reference || "", r.payment_provider_ref || "",
      r.payment_attempts || 0, fmt(r.paid_at), r.payment_failure || "",
    ]);
    res.json({ success: true, data: { header, lines } });
  } catch (error) {
    next(error);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id);
    if (!id) throw badRequest("Invalid transaction.");
    const [[row]] = await pool.query(`SELECT ${LIST_FIELDS}, c.payment_check_error FROM checkouts c WHERE c.id = ?`, [id]);
    if (!row) throw notFound("Transaction not found.");
    const [orders] = await pool.query(
      `SELECT id, livestock_title, quantity, price_unit, total, status, payment_status, stock_deducted, seller_name
       FROM orders WHERE checkout_id = ? ORDER BY id`,
      [id],
    );
    const [events] = await pool.query(
      `SELECT id, order_id, reference, event, status, amount, actor, admin_name, detail, data, ip_address, created_at
       FROM transaction_events WHERE checkout_id = ? ORDER BY id`,
      [id],
    );
    res.json({
      success: true,
      data: {
        ...shape(row),
        check_error: row.payment_check_error,
        orders: orders.map((o) => ({ ...o, reference: orderRef(o.id), total: Number(o.total) })),
        events: events.map((e) => ({ ...e, amount: e.amount === null ? null : Number(e.amount) })),
      },
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
