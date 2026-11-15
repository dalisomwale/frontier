// Admin > Payouts: paying sellers. Every handed-over order that hasn't been
// paid is owed to its seller, whatever cart it came in. The admin pays a
// seller for some or all of those orders at once, with one payment
// reference and one proof of payment (photos or PDFs).
const express = require("express");
const pool = require("../../db");
const handover = require("../../lib/handover");
const { uploadProof } = require("../../middleware/upload");
const { orderRef } = require("../../lib/orders");
const { positiveInt, text, notFound } = require("../../lib/validate");

const router = express.Router();

// Orders a seller can be paid for now.
const READY = `o.seller_id IS NOT NULL AND o.handed_over_at IS NOT NULL AND o.seller_paid_at IS NULL AND o.status <> 'cancelled'`;
const checkoutRef = (id) => (id ? `FMC-${1000 + Number(id)}` : null);

async function totals() {
  const [[owed]] = await pool.query(
    `SELECT COUNT(*) AS orders, COUNT(DISTINCT o.seller_id) AS sellers, COALESCE(SUM(o.total), 0) AS amount FROM orders o WHERE ${READY}`,
  );
  const [[month]] = await pool.query(
    `SELECT COUNT(*) AS orders, COALESCE(SUM(total), 0) AS amount FROM orders
     WHERE seller_paid_at IS NOT NULL AND seller_paid_at >= DATE_FORMAT(NOW(), '%Y-%m-01')`,
  );
  return {
    owed: Number(owed.amount),
    owed_orders: Number(owed.orders),
    sellers_waiting: Number(owed.sellers),
    paid_this_month: Number(month.amount),
    paid_this_month_orders: Number(month.orders),
  };
}

// Sellers owed money, most owed first.
router.get("/", async (req, res, next) => {
  try {
    const q = text(req.query.q, 100);
    const args = [];
    let search = "";
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
      search = "AND (s.name LIKE ? OR s.business_name LIKE ? OR s.phone LIKE ? OR s.email LIKE ?)";
      args.push(like, like, like, like);
    }
    const [rows] = await pool.query(
      `SELECT s.id, s.name, s.business_name, s.phone, s.email, s.province,
         COUNT(*) AS orders, COUNT(DISTINCT o.checkout_id) AS carts, SUM(o.total) AS owed,
         MIN(o.handed_over_at) AS waiting_since
       FROM orders o JOIN sellers s ON s.id = o.seller_id
       WHERE ${READY} ${search}
       GROUP BY s.id ORDER BY owed DESC, s.name`,
      args,
    );
    res.json({
      success: true,
      data: rows.map((r) => ({ ...r, orders: Number(r.orders), carts: Number(r.carts), owed: Number(r.owed) })),
      totals: await totals(),
    });
  } catch (error) {
    next(error);
  }
});

// Payments already made, newest first: one row per payment (orders paid
// together share the same time, reference and proof).
router.get("/paid", async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT o.seller_id, s.name, s.business_name, o.seller_paid_at, o.seller_paid_ref, o.seller_paid_by,
         COUNT(*) AS orders, SUM(o.total) AS amount,
         GROUP_CONCAT(o.id ORDER BY o.id) AS order_ids,
         GROUP_CONCAT(o.livestock_title ORDER BY o.id SEPARATOR '|~|') AS titles
       FROM orders o LEFT JOIN sellers s ON s.id = o.seller_id
       WHERE o.seller_paid_at IS NOT NULL
       GROUP BY o.seller_id, o.seller_paid_at, o.seller_paid_ref, o.seller_paid_by, s.name, s.business_name
       ORDER BY o.seller_paid_at DESC LIMIT 300`,
    );
    const ids = rows.flatMap((r) => String(r.order_ids || "").split(",").filter(Boolean).map(Number));
    const proofs = {};
    if (ids.length) {
      const [files] = await pool.query(
        "SELECT order_id, image_path, thumb_path FROM order_receipt_photos WHERE party = 'payout' AND order_id IN (?) ORDER BY id",
        [ids],
      );
      files.forEach((f) => { (proofs[f.order_id] = proofs[f.order_id] || []).push({ image_path: f.image_path, thumb_path: f.thumb_path }); });
    }
    res.json({
      success: true,
      data: rows.map((r) => {
        const orderIds = String(r.order_ids || "").split(",").filter(Boolean).map(Number);
        return {
          seller_id: r.seller_id,
          name: r.name,
          business_name: r.business_name,
          paid_at: r.seller_paid_at,
          reference: r.seller_paid_ref,
          paid_by: r.seller_paid_by,
          orders: orderIds.map((id, i) => ({ id, reference: orderRef(id), title: String(r.titles || "").split("|~|")[i] || "" })),
          amount: Number(r.amount),
          proof: proofs[orderIds[0]] || [],
        };
      }),
    });
  } catch (error) {
    next(error);
  }
});

// One seller and the orders they can be paid for now.
router.get("/sellers/:id", async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id);
    const [[seller]] = await pool.query(
      "SELECT id, name, business_name, phone, email, province, address FROM sellers WHERE id = ?",
      [id || 0],
    );
    if (!seller) throw notFound("Seller not found.");
    const [orders] = await pool.query(
      `SELECT o.id, o.checkout_id, o.livestock_title, o.quantity, o.price_unit, o.unit_price, o.total,
         o.full_name AS buyer_name, o.created_at, o.handed_over_at, o.sent_method
       FROM orders o WHERE ${READY} AND o.seller_id = ? ORDER BY o.handed_over_at, o.id`,
      [seller.id],
    );
    res.json({
      success: true,
      data: {
        seller,
        orders: orders.map((o) => ({ ...o, reference: orderRef(o.id), checkout_reference: checkoutRef(o.checkout_id), total: Number(o.total), unit_price: Number(o.unit_price) })),
      },
    });
  } catch (error) {
    next(error);
  }
});

// Pay a seller for the chosen orders: order_ids (comma separated),
// reference (optional), images (1 to 4 photos or PDFs).
router.post("/sellers/:id/pay", uploadProof, async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id);
    if (!id) throw notFound("Seller not found.");
    const orderIds = String(req.body.order_ids || "").split(",").map((v) => positiveInt(v)).filter(Boolean);
    const result = await handover.payOrders(id, orderIds, req.admin, req.files, text(req.body.reference, 150) || null, req.ip);
    res.json({
      success: true,
      message: `Paid: ${result.orders.length} order${result.orders.length === 1 ? "" : "s"} marked as paid and completed. The seller has been told.`,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
