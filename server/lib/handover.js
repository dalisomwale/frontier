// Handover and receipt of an order.
//
//   1. Once the order is paid, the seller (or Frontier's team, for its own
//      stock or on a seller's behalf) marks it as delivered or collected,
//      with 1 to 4 photos.
//   2. The buyer then confirms they've received it, with their own 1 to 4
//      photos and an optional note.
//   3. Only then can the seller (or the team) mark it as handed over. The
//      team is told to pay the seller.
//   4. The team pays the seller and marks it, with 1 to 4 photos of the proof
//      of payment. The order is then Completed. (Frontier's own stock has no
//      seller to pay, so handing it over completes it.)
const pool = require("../db");
const txlog = require("./txlog");
const emails = require("./emails");
const { saveImage, savePdf, deleteImageFiles } = require("../middleware/upload");
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
    "SELECT id, order_id, party, image_path, thumb_path, created_at FROM order_receipt_photos WHERE order_id IN (?) ORDER BY id",
    [ids],
  );
  const map = new Map();
  rows.forEach((r) => {
    if (!map.has(r.order_id)) map.set(r.order_id, []);
    map.get(r.order_id).push({ id: r.id, party: r.party, image_path: r.image_path, thumb_path: r.thumb_path });
  });
  return map;
}

const isPaid = (order) => order.payment_status === "paid" || ["paid", "confirmed"].includes(order.status);
const isOpen = (order) => !["completed", "cancelled"].includes(order.status);

// Step 1: the seller says it was delivered or collected.
function canSend(order) {
  return Boolean(order && isOpen(order) && isPaid(order) && !order.sent_at);
}

// Step 2: the buyer confirms, after the seller.
function canConfirm(order) {
  return Boolean(order && isOpen(order) && isPaid(order) && order.sent_at && !order.received_at);
}

// Step 3: the seller marks it handed over, after the buyer.
function canHandOver(order) {
  return Boolean(order && isOpen(order) && isPaid(order) && order.received_at && !order.handed_over_at);
}

// Step 4: Frontier pays the seller, after the handover.
function canPaySeller(order) {
  return Boolean(order && order.seller_id && order.status !== "cancelled" && order.handed_over_at && !order.seller_paid_at);
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

function problem(status, message, errors) {
  const e = new HttpError(status, message);
  if (errors) e.errors = errors;
  return e;
}

// Checks the method and 1-4 photos, then saves the photos. Returns their paths.
// Proof of payment: photos and PDFs, 1 to 4 files.
async function saveProof(files) {
  const list = files || [];
  if (!list.length) throw problem(422, "Please add the proof of payment (a photo or PDF).", { images: "Please add at least one photo or PDF." });
  if (list.length > MAX_PHOTOS) throw badRequest(`Please add no more than ${MAX_PHOTOS} files.`);
  const saved = [];
  try {
    for (const file of list) saved.push(file.mimetype === "application/pdf" ? await savePdf(file.buffer) : await saveImage(file.buffer));
  } catch (error) {
    deleteImageFiles(...saved.flatMap((p) => [p.image_path, p.thumb_path]));
    throw error;
  }
  return saved;
}

async function savePhotos(method, files, who) {
  if (who !== "payout" && !METHODS.includes(method)) throw problem(422, "Please choose delivered or collected.", { method: "Please choose one." });
  const list = files || [];
  if (list.length < MIN_PHOTOS) throw problem(422, `Please add at least one photo${who === "buyer" ? " of what you received" : ""}.`, { images: "Please add at least one photo." });
  if (list.length > MAX_PHOTOS) throw badRequest(`Please add no more than ${MAX_PHOTOS} photos.`);
  const saved = [];
  try {
    for (const file of list) saved.push(await saveImage(file.buffer));
  } catch (error) {
    deleteImageFiles(...saved.flatMap((p) => [p.image_path, p.thumb_path]));
    throw error;
  }
  return saved;
}

// Runs the order update and photo inserts together; removes the files if it fails.
async function storeStep(saved, party, orderId, sql, params, conflict) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.query(sql, params);
    if (!result.affectedRows) throw new HttpError(409, conflict);
    for (const p of saved) {
      await conn.query("INSERT INTO order_receipt_photos (order_id, party, image_path, thumb_path) VALUES (?, ?, ?, ?)", [orderId, party, p.image_path, p.thumb_path]);
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    deleteImageFiles(...saved.flatMap((p) => [p.image_path, p.thumb_path]));
    throw error;
  } finally {
    conn.release();
  }
}

// Step 1. by: { kind: "seller" | "admin", name, admin? }
async function markSent(orderId, method, by, files, note, ip = null) {
  const order = await loadOrder(orderId);
  if (!order) throw notFound("Order not found.");
  if (!canSend(order)) {
    if (order.sent_at) throw new HttpError(409, "This order has already been marked as delivered or collected.");
    throw new HttpError(409, handoverProblem(order));
  }
  const saved = await savePhotos(method, files, "seller");
  const clean = note ? String(note).trim().slice(0, 500) : null;
  await storeStep(saved, "seller", order.id,
    `UPDATE orders SET sent_method = ?, sent_at = NOW(), sent_by = ?, sent_note = ?
     WHERE id = ? AND sent_at IS NULL AND status NOT IN ('completed', 'cancelled')`,
    [method, String(by.name || by.kind).slice(0, 150), clean, order.id],
    "This order has already been marked as delivered or collected.");
  const ref = orderRef(order.id);
  const how = methodText(method);
  const units = headCount(order.quantity, order.animal_name, order.animal_kind);
  txlog.record({
    checkoutId: order.checkout_id,
    orderId: order.id,
    reference: ref,
    event: "seller_sent",
    actor: by.kind === "admin" ? "admin" : "seller",
    admin: by.admin || null,
    detail: `${ref} (${order.livestock_title}) marked as ${how} by ${by.kind === "admin" ? "Frontier" : "the seller"}${by.kind === "seller" && by.name ? ` (${by.name})` : ""} with ${saved.length} photo${saved.length === 1 ? "" : "s"}. Waiting for the buyer to confirm.`,
    data: { photos: saved.map((p) => p.image_path) },
    ip,
  });
  const link = `/account/?tab=orders&id=${order.id}`;
  if (order.buyer_id) {
    notifyBuyer(order.buyer_id, {
      type: "order",
      title: `Please confirm you've received ${order.livestock_title}`,
      body: `${ref} was marked as ${how}. Confirm with a few photos.`,
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
      "Please confirm you've received it, with 1 to 4 photos. If something isn't right, reply to this email instead.",
    ],
    rows: [["Order", ref], ["Quantity", units], ["Total", kwacha(order.total)]],
    button: { label: "Confirm I've received it", url: appUrl(link) },
    log: true,
  });
  if (by.kind === "admin" && order.seller_id) {
    notifySeller(order.seller_id, {
      type: "order",
      title: `Order ${ref} marked as ${how}`,
      body: `Frontier marked ${order.livestock_title} as ${how}. The buyer will confirm.`,
      link: `/seller/?tab=orders&id=${order.id}`,
    });
    emails.sellerOrder(order, "sent", { units, how });
  }
  sendEmail({
    to: recipients(),
    subject: `Order ${how}: ${ref}`,
    heading: `${ref} was ${how}`,
    paragraphs: [`${by.kind === "admin" ? "Frontier" : `The seller${by.name ? ` (${by.name})` : ""}`} marked ${ref} (${order.livestock_title}) as ${how}, with ${saved.length} photo${saved.length === 1 ? "" : "s"}. ${order.buyer_id ? "The buyer has been asked to confirm." : "The buyer has no account, so they can't confirm online."}`],
    rows: [["Order", ref], ["Seller", await sellerName(order.seller_id)], ["Buyer", order.full_name], ["Quantity", units], ["Total", kwacha(order.total)]],
    button: { label: "Open the order", url: appUrl(`/admin/orders.html?id=${order.id}`) },
    log: true,
  });
  broadcastAdmin("order", { id: order.id, checkout_id: order.checkout_id, change: "sent" });
  return loadOrder(order.id);
}

// Step 3. Completes the order: the seller's funds can now be processed.
async function handOver(orderId, by, ip = null) {
  const order = await loadOrder(orderId);
  if (!canHandOver(order)) throw new HttpError(409, handoverProblem(order));
  // With a seller to pay, the order completes once they're paid (step 4).
  const [result] = await pool.query(
    `UPDATE orders SET status = IF(seller_id IS NULL, 'completed', status), handed_over_at = NOW(), handed_over_by = ?
     WHERE id = ? AND handed_over_at IS NULL AND received_at IS NOT NULL AND status NOT IN ('completed', 'cancelled')`,
    [String(by.name || by.kind).slice(0, 150), order.id],
  );
  if (!result.affectedRows) throw new HttpError(409, "This order has already been marked as handed over.");
  const ref = orderRef(order.id);
  const units = headCount(order.quantity, order.animal_name, order.animal_kind);
  const how = methodText(order.handover_method || order.sent_method);
  txlog.record({
    checkoutId: order.checkout_id,
    orderId: order.id,
    reference: ref,
    event: "handed_over",
    ...(order.seller_id ? {} : { status: "completed" }),
    actor: by.kind === "admin" ? "admin" : "seller",
    admin: by.admin || null,
    detail: `${ref} (${order.livestock_title}) marked as handed over by ${by.kind === "admin" ? "Frontier" : "the seller"}${by.kind === "seller" && by.name ? ` (${by.name})` : ""}. ${order.seller_id ? "The seller can now be paid." : "Order Completed."}`,
    ip,
  });
  // For the buyer the order was already complete when they confirmed.
  if (order.buyer_id) pingBuyer(order.buyer_id, "order", { id: order.id });
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
  if (order.seller_id) sendEmail({
    to: recipients(),
    subject: `Ready to pay the seller: ${ref}`,
    heading: "An order is complete: the seller can be paid",
    paragraphs: [`The buyer confirmed ${how === "delivered" ? "delivery" : "collection"} and ${by.kind === "admin" ? "Frontier" : "the seller"} marked ${ref} (${order.livestock_title}) as handed over. Please pay the seller, then mark it on the order with a photo of the proof of payment.`],
    rows: [
      ["Order", ref],
      ["Seller", await sellerName(order.seller_id)],
      ["Quantity", units],
      ["Total", kwacha(order.total)],
    ],
    button: { label: "Open the order", url: appUrl(`/admin/orders.html?id=${order.id}`) },
    log: true,
  });
  broadcastAdmin("order", { id: order.id, checkout_id: order.checkout_id, change: "handed_over" });
  return loadOrder(order.id);
}

// Step 4. The team pays the seller: 1 to 4 photos of the proof of payment and
// an optional payment reference. The order is then Completed.
async function paySeller(orderId, admin, files, reference, ip = null) {
  const order = await loadOrder(orderId);
  if (!order) throw notFound("Order not found.");
  if (order.seller_paid_at) throw new HttpError(409, "The seller has already been marked as paid.");
  if (!canPaySeller(order)) throw new HttpError(409, order.seller_id ? "The seller can be paid once the order has been handed over." : "This order is Frontier's own stock: there's no seller to pay.");
  const saved = await saveProof(files);
  const ref = orderRef(order.id);
  const cleanRef = reference ? String(reference).trim().slice(0, 150) : null;
  await storeStep(saved, "payout", order.id,
    `UPDATE orders SET seller_paid_at = NOW(), seller_paid_by = ?, seller_paid_ref = ?, status = 'completed'
     WHERE id = ? AND seller_paid_at IS NULL AND handed_over_at IS NOT NULL AND status <> 'cancelled'`,
    [`Frontier (${admin.name})`.slice(0, 150), cleanRef, order.id],
    "The seller has already been marked as paid.");
  txlog.record({
    checkoutId: order.checkout_id,
    orderId: order.id,
    reference: ref,
    event: "seller_paid",
    status: "completed",
    actor: "admin",
    admin,
    detail: `${admin.name} marked the seller of ${ref} (${order.livestock_title}) as paid${cleanRef ? ` (reference ${cleanRef})` : ""}, with ${saved.length} file${saved.length === 1 ? "" : "s"} of the proof of payment. Order Completed.`,
    data: { photos: saved.map((p) => p.image_path) },
    ip,
  });
  notifySeller(order.seller_id, {
    type: "order",
    title: `You've been paid for order ${ref}`,
    body: `Frontier paid you for ${order.livestock_title}. The proof of payment is on the order.`,
    link: `/seller/?tab=orders&id=${order.id}`,
  });
  emails.sellerOrder(order, "paid", { units: headCount(order.quantity, order.animal_name, order.animal_kind), reference: cleanRef });
  broadcastAdmin("order", { id: order.id, checkout_id: order.checkout_id, change: "seller_paid" });
  return loadOrder(order.id);
}

// Step 2. files: multer files (images).
async function confirmReceipt(orderId, buyer, method, files, note, ip = null) {
  const order = await loadOrder(orderId);
  if (!order || Number(order.buyer_id) !== Number(buyer.id)) throw notFound("Order not found.");
  if (order.received_at) throw new HttpError(409, "You've already confirmed this order.");
  if (order.status === "cancelled") throw new HttpError(409, "This order was cancelled.");
  if (order.status === "completed") throw new HttpError(409, "This order is already complete.");
  if (!canConfirm(order)) throw new HttpError(409, "You can confirm once the seller has marked your order as delivered or collected.");
  const saved = await savePhotos(method, files, "buyer");
  const clean = note ? String(note).trim().slice(0, 500) : null;
  await storeStep(saved, "buyer", order.id,
    `UPDATE orders SET received_at = NOW(), received_note = ?, handover_method = ?
     WHERE id = ? AND status NOT IN ('completed', 'cancelled') AND received_at IS NULL AND sent_at IS NOT NULL`,
    [clean, method, order.id],
    "This order has already been confirmed.");

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
  // For the buyer, confirming completes the order.
  notifyBuyer(buyer.id, {
    type: "order",
    title: `Order ${ref} is complete`,
    body: `Thank you for buying ${order.livestock_title} on Frontier Marketplace.`,
    link: `/account/?tab=orders&id=${order.id}`,
  });
  sendEmail({
    to: order.email,
    subject: `Your order ${ref} is complete`,
    heading: "Thank you, your order is complete",
    paragraphs: [
      `Hi ${String(order.full_name).split(/\s+/)[0]}, thank you for confirming you've received ${order.livestock_title}.`,
      "Thank you for buying on Frontier Marketplace.",
    ],
    rows: [["Order", ref], ["Total paid", kwacha(order.total)], ["How", how === "delivered" ? "Delivered" : "Collected"]],
    button: { label: "View your order", url: appUrl(`/account/?tab=orders&id=${order.id}`) },
    log: true,
  });
  pingBuyer(buyer.id, "order", { id: order.id });
  broadcastAdmin("order", { id: order.id, checkout_id: order.checkout_id, change: "received" });
  return loadOrder(order.id);
}

module.exports = { METHODS, MIN_PHOTOS, MAX_PHOTOS, loadOrder, photosOf, canSend, canConfirm, canHandOver, canPaySeller, markSent, handOver, paySeller, confirmReceipt, methodText };
