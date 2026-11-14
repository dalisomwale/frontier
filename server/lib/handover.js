// Handover and receipt of an order.
//
//   1. Once the order is paid, the buyer confirms they've received it
//      (collected or delivered), with 1 to 4 photos and an optional note.
//   2. Only then can the seller (or Frontier's team, for its own stock or on
//      a seller's behalf) mark it as handed over. The order becomes Completed
//      and the team is told the seller's funds can be processed.
const pool = require("../db");
const txlog = require("./txlog");
const emails = require("./emails");
const { saveImage, deleteImageFiles } = require("../middleware/upload");
const { sendEmail, recipients, appUrl } = require("../services/mailer");
const { notifySeller, notifyBuyer, pingBuyer, broadcastAdmin } = require("../services/notifications");
const { orderRef, kwacha, headCount } = require("./orders");
const { badRequest, notFound, HttpError } = require("./validate");

const METHODS = ["collected", "delivered"];
const MIN_PHOTOS = 1;
const MAX_PHOTOS = 4;
const checkoutRef = (id) => `FMC-${1000 + Number(id)}`;

async function loadOrder(id, conn = pool) {
  const [[order]] = await conn.query(
    `SELECT o.*, a.name AS animal_name, a.kind AS animal_kind
     FROM orders o
     LEFT JOIN livestock l ON l.id = o.livestock_id
     LEFT JOIN categories c ON c.id = l.category_id
     LEFT JOIN animals a ON a.id = c.animal_id
     WHERE o.id = ?`,
    [id],
  );
  return order || null;
}

async function photosOf(orderIds) {
  const ids = [].concat(orderIds).filter(Boolean);
  if (!ids.length) return new Map();
  const [rows] = await pool.query(
    "SELECT id, order_id, image_path, thumb_path, created_at FROM order_receipt_photos WHERE order_id IN (?) ORDER BY id",
    [ids],
  );
  const map = new Map();
  rows.forEach((r) => {
    if (!map.has(r.order_id)) map.set(r.order_id, []);
    map.get(r.order_id).push({ id: r.id, image_path: r.image_path, thumb_path: r.thumb_path });
  });
  return map;
}

const isPaid = (order) => order.payment_status === "paid" || ["paid", "confirmed"].includes(order.status);
const isOpen = (order) => !["completed", "cancelled"].includes(order.status);

// The buyer can confirm a paid, open order they haven't confirmed yet.
function canConfirm(order) {
  return Boolean(order && isOpen(order) && isPaid(order) && !order.received_at);
}

// The seller can hand over once the buyer has confirmed.
function canHandOver(order) {
  return Boolean(order && isOpen(order) && isPaid(order) && order.received_at && !order.handed_over_at);
}

function handoverProblem(order) {
  if (!order) return "Order not found.";
  if (order.status === "cancelled") return "This order was cancelled.";
  if (order.status === "completed" || order.handed_over_at) return "This order has already been marked as handed over.";
  if (!isPaid(order)) return "This order can be handed over once it has been paid.";
  return "You can mark this order as handed over once the buyer has confirmed they received it.";
}

const methodText = (m) => (m === "delivered" ? "delivered" : "collected");
const sellerName = async (sellerId) => {
  if (!sellerId) return "Frontier";
  const [[s]] = await pool.query("SELECT name, business_name FROM sellers WHERE id = ?", [sellerId]);
  return s ? (s.business_name || s.name) : "-";
};

// by: { kind: "seller" | "admin", name, admin? }
// Completes the order: the seller's funds can now be processed.
async function handOver(orderId, by, ip = null) {
  const order = await loadOrder(orderId);
  if (!canHandOver(order)) throw new HttpError(409, handoverProblem(order));
  const [result] = await pool.query(
    `UPDATE orders SET status = 'completed', handed_over_at = NOW(), handed_over_by = ?
     WHERE id = ? AND handed_over_at IS NULL AND received_at IS NOT NULL AND status NOT IN ('completed', 'cancelled')`,
    [String(by.name || by.kind).slice(0, 150), order.id],
  );
  if (!result.affectedRows) throw new HttpError(409, "This order has already been marked as handed over.");
  const ref = orderRef(order.id);
  const units = headCount(order.quantity, order.animal_name, order.animal_kind);
  const how = methodText(order.handover_method);
  txlog.record({
    checkoutId: order.checkout_id,
    orderId: order.id,
    reference: ref,
    event: "handed_over",
    status: "completed",
    actor: by.kind === "admin" ? "admin" : "seller",
    admin: by.admin || null,
    detail: `${ref} (${order.livestock_title}) marked as handed over by ${by.kind === "admin" ? "Frontier" : "the seller"}${by.kind === "seller" && by.name ? ` (${by.name})` : ""}. Order Completed; the seller's funds can be processed.`,
    ip,
  });
  if (order.buyer_id) {
    notifyBuyer(order.buyer_id, {
      type: "order",
      title: `Order ${ref} is complete`,
      body: `Thank you for buying ${order.livestock_title} on Frontier Marketplace.`,
      link: `/account/?tab=orders&id=${order.id}`,
    });
    pingBuyer(order.buyer_id, "order", { id: order.id });
  }
  if (order.seller_id) {
    if (by.kind === "admin") {
      notifySeller(order.seller_id, {
        type: "order",
        title: `Order ${ref} is complete`,
        body: `Frontier marked ${order.livestock_title} as handed over. We'll process your payment.`,
        link: `/seller/?tab=orders&id=${order.id}`,
      });
    }
    emails.sellerOrder(order, "completed", { units });
  }
  sendEmail({
    to: recipients(),
    subject: `Ready to pay the seller: ${ref}`,
    heading: "An order is complete: the seller can be paid",
    paragraphs: [`The buyer confirmed ${how === "delivered" ? "delivery" : "collection"} and ${by.kind === "admin" ? "Frontier" : "the seller"} marked ${ref} (${order.livestock_title}) as handed over. Please process the seller's funds.`],
    rows: [
      ["Order", ref],
      ["Seller", await sellerName(order.seller_id)],
      ["Quantity", units],
      ["Total", kwacha(order.total)],
      ["Buyer confirmed", order.received_at ? new Date(order.received_at).toLocaleString("en-GB", { timeZone: process.env.APP_TIMEZONE || "Africa/Lusaka" }) : "-"],
    ],
    button: { label: "Open the order", url: appUrl(`/admin/orders.html?id=${order.id}`) },
    log: true,
  });
  broadcastAdmin("order", { id: order.id, checkout_id: order.checkout_id, change: "handed_over" });
  return loadOrder(order.id);
}

// files: multer files (images). The photos are checked and saved before
// anything changes; if saving the order fails they're removed again.
async function confirmReceipt(orderId, buyer, method, files, note, ip = null) {
  const order = await loadOrder(orderId);
  if (!order || Number(order.buyer_id) !== Number(buyer.id)) throw notFound("Order not found.");
  if (order.received_at) throw new HttpError(409, "You've already confirmed this order.");
  if (order.status === "cancelled") throw new HttpError(409, "This order was cancelled.");
  if (order.status === "completed") throw new HttpError(409, "This order is already complete.");
  if (!isPaid(order)) throw new HttpError(409, "You can confirm once your order has been paid.");
  if (!METHODS.includes(method)) {
    const e = new HttpError(422, "Please choose whether you collected it or it was delivered.");
    e.errors = { method: "Please choose one." };
    throw e;
  }
  const list = files || [];
  if (list.length < MIN_PHOTOS) {
    const e = new HttpError(422, "Please add at least one photo of what you received.");
    e.errors = { images: "Please add at least one photo." };
    throw e;
  }
  if (list.length > MAX_PHOTOS) throw badRequest(`Please add no more than ${MAX_PHOTOS} photos.`);
  const saved = [];
  try {
    for (const file of list) saved.push(await saveImage(file.buffer));
  } catch (error) {
    deleteImageFiles(...saved.flatMap((p) => [p.image_path, p.thumb_path]));
    throw error;
  }
  const clean = note ? String(note).trim().slice(0, 500) : null;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.query(
      `UPDATE orders SET received_at = NOW(), received_note = ?, handover_method = ?
       WHERE id = ? AND status NOT IN ('completed', 'cancelled') AND received_at IS NULL`,
      [clean, method, order.id],
    );
    if (!result.affectedRows) throw new HttpError(409, "This order has already been confirmed.");
    for (const p of saved) {
      await conn.query("INSERT INTO order_receipt_photos (order_id, image_path, thumb_path) VALUES (?, ?, ?)", [order.id, p.image_path, p.thumb_path]);
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    deleteImageFiles(...saved.flatMap((p) => [p.image_path, p.thumb_path]));
    throw error;
  } finally {
    conn.release();
  }

  const ref = orderRef(order.id);
  const how = methodText(method);
  txlog.record({
    checkoutId: order.checkout_id,
    orderId: order.id,
    reference: ref,
    event: "buyer_confirmed",
    actor: "buyer",
    detail: `${order.full_name} confirmed they received ${ref} (${order.livestock_title}, ${how}) with ${saved.length} photo${saved.length === 1 ? "" : "s"}${clean ? `: "${clean}"` : ""}. Waiting for the seller to mark it as handed over.`,
    data: { photos: saved.map((p) => p.image_path) },
    ip,
  });
  if (order.seller_id) {
    notifySeller(order.seller_id, {
      type: "order",
      title: `Buyer confirmed order ${ref}`,
      body: `The buyer confirmed they received ${order.livestock_title}. Mark it as handed over so Frontier can process your payment.`,
      link: `/seller/?tab=orders&id=${order.id}`,
    });
    emails.sellerOrder(order, "received", { units: headCount(order.quantity, order.animal_name, order.animal_kind) });
  }
  sendEmail({
    to: recipients(),
    subject: `Buyer confirmed ${how === "delivered" ? "delivery" : "collection"}: ${ref}`,
    heading: `${order.full_name} confirmed they received their order`,
    paragraphs: [`The buyer's photos are on ${ref} (${order.livestock_title}). ${order.seller_id ? "Waiting for the seller to mark it as handed over." : "Mark it as handed over to complete it."}`],
    rows: [
      ["Order", ref],
      ["Checkout", order.checkout_id ? checkoutRef(order.checkout_id) : "-"],
      ["How", how === "delivered" ? "Delivered" : "Collected"],
      ["Photos", String(saved.length)],
      ...(clean ? [["Buyer's note", clean]] : []),
    ],
    button: { label: "Open the order", url: appUrl(`/admin/orders.html?id=${order.id}`) },
    log: true,
  });
  pingBuyer(buyer.id, "order", { id: order.id });
  broadcastAdmin("order", { id: order.id, checkout_id: order.checkout_id, change: "received" });
  return loadOrder(order.id);
}

module.exports = { METHODS, MIN_PHOTOS, MAX_PHOTOS, loadOrder, photosOf, canConfirm, canHandOver, handOver, confirmReceipt, methodText };
