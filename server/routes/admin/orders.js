// Admin > Orders. Buy Now requests from the website.
//
// Status flow: new -> confirmed (awaiting payment) -> paid -> completed, or
// cancelled at any point. The buyer is emailed on every status change (with
// the admin's message, e.g. payment details). The seller is told once, when
// the order is first confirmed, without the buyer's details. Stock comes off
// the listing when the order is placed and goes back if it is cancelled.
const express = require("express");
const pool = require("../../db");
const { sendEmail } = require("../../services/mailer");
const { notifySeller } = require("../../services/notifications");
const emails = require("../../lib/emails");
const { positiveInt, text, oneOf, badRequest, notFound } = require("../../lib/validate");
const {
  ORDER_STATUSES,
  STATUS_LABELS,
  STOCK_STATUSES,
  DELIVERY_LABELS,
  PAYMENT_LABELS,
  orderRef,
  kwacha,
  headCount,
  paymentText,
  parseOrderRef,
} = require("../../lib/orders");

const router = express.Router();

const ORDER_FIELDS = `o.*,
  (SELECT li.thumb_path FROM livestock_images li WHERE li.livestock_id = o.livestock_id
     ORDER BY li.sort_order, li.id LIMIT 1) AS thumb_path`;

function present(row) {
  return {
    ...row,
    reference: orderRef(row.id),
    checkout_reference: row.checkout_id ? `FMC-${1000 + Number(row.checkout_id)}` : null,
    unit_price: Number(row.unit_price),
    total: Number(row.total),
    status_label: STATUS_LABELS[row.status],
  };
}

async function loadOrder(id) {
  const [rows] = await pool.query(
    `SELECT ${ORDER_FIELDS}, l.quantity AS listing_quantity, l.status AS listing_status,
       s.phone AS seller_phone, s.email AS seller_email
     FROM orders o
     LEFT JOIN livestock l ON l.id = o.livestock_id
     LEFT JOIN sellers s ON s.id = o.seller_id
     WHERE o.id = ?`,
    [id],
  );
  if (!rows.length) throw notFound("Order not found.");
  const order = present(rows[0]);
  // Other orders bought in the same cart checkout.
  if (order.checkout_id) {
    const [others] = await pool.query("SELECT id FROM orders WHERE checkout_id = ? AND id <> ? ORDER BY id", [order.checkout_id, order.id]);
    order.checkout_orders = others.map((r) => ({ id: r.id, reference: orderRef(r.id) }));
  }
  return order;
}

async function summary() {
  const [rows] = await pool.query("SELECT status, COUNT(*) AS n FROM orders GROUP BY status");
  const out = Object.fromEntries(ORDER_STATUSES.map((s) => [s, 0]));
  rows.forEach((r) => { out[r.status] = Number(r.n); });
  out.all = Object.values(out).reduce((a, b) => a + b, 0);
  return out;
}

router.get("/", async (req, res, next) => {
  try {
    const page = positiveInt(req.query.page, 1);
    const limit = Math.min(positiveInt(req.query.limit, 25), 100);
    const where = ["1 = 1"];
    const params = [];
    const status = oneOf(req.query.status, ORDER_STATUSES);
    if (status) {
      where.push("o.status = ?");
      params.push(status);
    }
    const q = text(req.query.q, 100);
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
      // "FMC-1001" finds every order from that cart checkout.
      const cart = q.trim().match(/^fmc-?(\d+)$/i);
      const cartId = cart ? Number(cart[1]) - 1000 : null;
      const refId = cart ? null : parseOrderRef(q);
      where.push(`(o.full_name LIKE ? OR o.livestock_title LIKE ? OR o.phone LIKE ? OR o.email LIKE ?${refId ? " OR o.id = ?" : ""}${cartId ? " OR o.checkout_id = ?" : ""})`);
      params.push(like, like, like, like, ...(refId ? [refId] : []), ...(cartId ? [cartId] : []));
    }
    const condition = where.join(" AND ");
    const [rows] = await pool.query(
      `SELECT ${ORDER_FIELDS} FROM orders o WHERE ${condition}
       ORDER BY o.created_at DESC, o.id DESC LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit],
    );
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM orders o WHERE ${condition}`, params);
    res.json({
      success: true,
      data: rows.map(present),
      summary: await summary(),
      pagination: { current: page, total: Math.max(1, Math.ceil(total / limit)), totalItems: Number(total) },
    });
  } catch (error) {
    next(error);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    res.json({ success: true, data: await loadOrder(positiveInt(req.params.id)) });
  } catch (error) {
    next(error);
  }
});

// Update the status and/or send the buyer a message.
router.patch("/:id", async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const id = positiveInt(req.params.id);
    const status = req.body.status === undefined ? undefined : oneOf(req.body.status, ORDER_STATUSES);
    const message = text(req.body.message, 2000);
    if (status === null) throw badRequest("Invalid status.");
    if (message === undefined) throw badRequest("Message must be 2000 characters or fewer.");

    await conn.beginTransaction();
    const [[order]] = await conn.query("SELECT * FROM orders WHERE id = ? FOR UPDATE", [id]);
    if (!order) throw notFound("Order not found.");
    const newStatus = status || order.status;
    const changed = newStatus !== order.status;
    if (!changed && !message) throw badRequest("Choose a new status or write a message.");

    // Stock: off the listing while the order counts as paid, back otherwise.
    const wantDeducted = STOCK_STATUSES.includes(newStatus);
    let soldOut = false;
    if (order.livestock_id && wantDeducted && !order.stock_deducted) {
      const [[listing]] = await conn.query("SELECT quantity FROM livestock WHERE id = ? FOR UPDATE", [order.livestock_id]);
      if (listing) {
        const left = Math.max(0, Number(listing.quantity) - Number(order.quantity));
        soldOut = left === 0;
        // A listing with nothing left comes off the website (quantity stays 1
        // minimum in the form, so record 0 only alongside unpublishing).
        await conn.query(
          `UPDATE livestock SET quantity = ?, status = IF(? = 0, 'unpublished', status) WHERE id = ?`,
          [left, left, order.livestock_id],
        );
      }
    } else if (order.livestock_id && !wantDeducted && order.stock_deducted) {
      // A listing that sold out (and so came off the website) goes back on.
      await conn.query(
        `UPDATE livestock SET status = IF(quantity = 0 AND review_status = 'approved', 'published', status),
           quantity = quantity + ? WHERE id = ?`,
        [order.quantity, order.livestock_id],
      );
    }

    const notifySellerNow = changed && order.seller_id && !order.seller_notified_at && ["confirmed", "paid", "completed"].includes(newStatus);
    await conn.query(
      `UPDATE orders SET status = ?, stock_deducted = ?, seller_notified_at = IF(?, NOW(), seller_notified_at) WHERE id = ?`,
      [newStatus, wantDeducted && order.livestock_id ? 1 : 0, notifySellerNow ? 1 : 0, id],
    );
    await conn.commit();

    const ref = orderRef(id);
    const lot = order.price_unit === "lot";
    const [[animal]] = await pool.query(
      `SELECT a.name, a.kind FROM livestock l JOIN categories c ON c.id = l.category_id JOIN animals a ON a.id = c.animal_id WHERE l.id = ?`,
      [order.livestock_id || 0],
    );
    const units = headCount(order.quantity, animal && animal.name, animal && animal.kind);
    const qtyText = lot ? `The whole lot (${units})` : units;
    const kind = animal && animal.kind;
    const buyerMail = await emails.orderUpdate(
      { ...order, previous_status: order.status },
      { status: newStatus, changed, message, kind },
    );

    // Seller: told once when the order is confirmed (without the buyer's
    // details), then if it's completed or cancelled after that.
    if (notifySellerNow) {
      const body = `${lot ? "The whole lot" : units} from "${order.livestock_title}" has been ordered (${kwacha(order.total)}). Our team will contact you to arrange the handover.`;
      notifySeller(order.seller_id, { type: "order", title: `New order ${ref}: ${order.livestock_title}`, body, link: "/seller/" });
      const [[left]] = await pool.query("SELECT quantity FROM livestock WHERE id = ?", [order.livestock_id || 0]);
      emails.sellerOrder(order, "new", { units, leftOnListing: left ? headCount(left.quantity, animal && animal.name, kind) : undefined });
    } else if (changed && order.seller_id && order.seller_notified_at && ["completed", "cancelled"].includes(newStatus)) {
      notifySeller(order.seller_id, {
        type: "order",
        title: newStatus === "completed" ? `Order ${ref} is complete` : `Order ${ref} was cancelled`,
        body: order.livestock_title,
        link: "/seller/",
      });
      emails.sellerOrder(order, newStatus, { units });
    }
    if (soldOut && order.seller_id) emails.listingSoldOut(order.seller_id, { id: order.livestock_id, title: order.livestock_title });

    const data = await loadOrder(id);
    res.json({
      success: true,
      message: [
        changed ? `Order marked ${STATUS_LABELS[newStatus].toLowerCase()}.` : "Message sent.",
        buyerMail.sent ? "The buyer was emailed." : `The buyer email was not sent (${buyerMail.error}).`,
        soldOut ? "The listing is now sold out and hidden from the website." : "",
      ].filter(Boolean).join(" "),
      data,
    });
  } catch (error) {
    await conn.rollback().catch(() => {});
    next(error);
  } finally {
    conn.release();
  }
});

module.exports = router;
