// Handover and receipt of an order.
//
//   1. The seller (or Frontier's team, for its own stock or on a seller's
//      behalf) marks a paid order as handed over: collected by the buyer or
//      delivered.
//   2. The buyer then confirms they've received it, with 1 to 4 photos and
//      an optional note. The order becomes Completed straight away; the team
//      and the seller are told and can see the photos.
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

// Paid (online or confirmed by the team), not finished, not yet handed over.
function canHandOver(order) {
  return order
    && !["completed", "cancelled"].includes(order.status)
    && (order.payment_status === "paid" || ["paid", "confirmed"].includes(order.status))
    && !order.handed_over_at;
}

function handoverProblem(order) {
  if (!order) return "Order not found.";
  if (order.status === "cancelled") return "This order was cancelled.";
  if (order.status === "completed") return "This order is already complete.";
  if (order.handed_over_at) return "This order has already been marked as handed over.";
  return "This order can be handed over once it has been paid.";
}

const methodText = (m) => (m === "delivered" ? "delivered" : "collected");

// by: { kind: "seller" | "admin", name, admin? }
async function handOver(orderId, method, by, ip = null) {
  if (!METHODS.includes(method)) throw badRequest("Please choose whether the buyer collected it or it was delivered.");
  const order = await loadOrder(orderId);
  if (!canHandOver(order)) throw new HttpError(409, handoverProblem(order));
  const [result] = await pool.query(
    `UPDATE orders SET handover_method = ?, handed_over_at = NOW(), handed_over_by = ?
     WHERE id = ? AND handed_over_at IS NULL AND status NOT IN ('completed', 'cancelled')`,
    [method, String(by.name || by.kind).slice(0, 150), order.id],
  );
  if (!result.affectedRows) throw new HttpError(409, "This order has already been marked as handed over.");
  const ref = orderRef(order.id);
  const units = headCount(order.quantity, order.animal_name, order.animal_kind);
  txlog.record({
    checkoutId: order.checkout_id,
    orderId: order.id,
    reference: ref,
    event: "handed_over",
    actor: by.kind === "admin" ? "admin" : "seller",
    admin: by.admin || null,
    detail: `${ref} (${order.livestock_title}) marked as ${methodText(method)} by ${by.kind === "admin" ? "Frontier" : "the seller"}${by.kind === "seller" && by.name ? ` (${by.name})` : ""}. Waiting for the buyer to confirm.`,
    ip,
  });
  const link = `/account/?tab=orders&id=${order.id}`;
  if (order.buyer_id) {
    notifyBuyer(order.buyer_id, {
      type: "order",
      title: `Please confirm you've received ${order.livestock_title}`,
      body: `${ref} was marked as ${methodText(method)}. Confirm with a few photos of what you received.`,
      link,
    });
    pingBuyer(order.buyer_id, "order", { id: order.id });
  }
  sendEmail({
    to: order.email,
    subject: `Please confirm you've received your order ${ref}`,
    heading: method === "delivered" ? "Your order has been delivered" : "Your order has been collected",
    paragraphs: [
      `Hi ${String(order.full_name).split(/\s+/)[0]},`,
      `${order.price_unit === "lot" ? `The whole lot (${units})` : units} of ${order.livestock_title} ${method === "delivered" ? "was delivered to you" : "was collected by you"}, according to ${by.kind === "admin" ? "our team" : "the seller"}.`,
      "Please confirm you've received it, with 1 to 4 photos of what you received. If something isn't right, reply to this email instead.",
    ],
    rows: [["Order", ref], ["Quantity", units], ["Total", kwacha(order.total)]],
    button: { label: "Confirm I've received it", url: appUrl(link) },
    log: true,
  });
  if (by.kind === "admin" && order.seller_id) {
    notifySeller(order.seller_id, {
      type: "order",
      title: `Order ${ref} marked as handed over`,
      body: `Frontier marked ${order.livestock_title} as ${methodText(method)}. The buyer will confirm.`,
      link: `/seller/?tab=orders&id=${order.id}`,
    });
  }
  broadcastAdmin("order", { id: order.id, checkout_id: order.checkout_id, change: "handed_over" });
  return loadOrder(order.id);
}

// files: multer files (images). The photos are checked and saved before
// anything changes; if saving the order fails they're removed again.
async function confirmReceipt(orderId, buyer, files, note, ip = null) {
  const order = await loadOrder(orderId);
  if (!order || Number(order.buyer_id) !== Number(buyer.id)) throw notFound("Order not found.");
  if (order.status === "completed") throw new HttpError(409, "You've already confirmed this order.");
  if (order.status === "cancelled") throw new HttpError(409, "This order was cancelled.");
  if (!order.handed_over_at) throw new HttpError(409, "You can confirm once the seller has handed your order over.");
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
      `UPDATE orders SET status = 'completed', received_at = NOW(), received_note = ?
       WHERE id = ? AND status NOT IN ('completed', 'cancelled') AND handed_over_at IS NOT NULL`,
      [clean, order.id],
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
  const how = methodText(order.handover_method);
  txlog.record({
    checkoutId: order.checkout_id,
    orderId: order.id,
    reference: ref,
    event: "buyer_confirmed",
    status: "completed",
    actor: "buyer",
    detail: `${order.full_name} confirmed they received ${ref} (${order.livestock_title}, ${how}) with ${saved.length} photo${saved.length === 1 ? "" : "s"}${clean ? `: "${clean}"` : ""}. Order marked Completed.`,
    data: { photos: saved.map((p) => p.image_path) },
    ip,
  });
  if (order.seller_id) {
    notifySeller(order.seller_id, {
      type: "order",
      title: `Order ${ref} is complete`,
      body: `The buyer confirmed they received ${order.livestock_title}.`,
      link: `/seller/?tab=orders&id=${order.id}`,
    });
    emails.sellerOrder(order, "completed", { units: headCount(order.quantity, order.animal_name, order.animal_kind) });
  }
  sendEmail({
    to: recipients(),
    subject: `Buyer confirmed ${how === "delivered" ? "delivery" : "collection"}: ${ref}`,
    heading: `${order.full_name} confirmed they received their order`,
    paragraphs: [`${ref} (${order.livestock_title}) is now Completed. The buyer's photos are on the order.`],
    rows: [
      ["Order", ref],
      ["Checkout", order.checkout_id ? checkoutRef(order.checkout_id) : "-"],
      ["Handed over", `${how === "delivered" ? "Delivered" : "Collected"} (${order.handed_over_by || "-"})`],
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

module.exports = { METHODS, MIN_PHOTOS, MAX_PHOTOS, loadOrder, photosOf, canHandOver, handOver, confirmReceipt, methodText };
