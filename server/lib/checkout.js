// Shopping-cart checkout, paid by mobile money only.
//
// The buyer fills a cart (kept in their browser), gives their details at
// checkout and pays once for the whole cart on the payment page. Behind the
// scenes every cart line becomes its own order (orders.checkout_id), so each
// seller, the admin pages and the order emails work exactly as for a single
// order. The payment belongs to the checkout: when it succeeds, every open
// order in it is marked paid and each seller is told about their part.
//
// The payment page is ours for now (Lenco sends the PIN prompt). A payment
// gateway with its own hosted payment page plugs in at payUrl() and
// startCollection().
const crypto = require("crypto");
const pool = require("../db");
const lenco = require("../services/lenco");
const { sendEmail, recipients, appUrl } = require("../services/mailer");
const { orderRef, kwacha, headCount, OPERATOR_LABELS } = require("./orders");
const payments = require("./payments");
const emails = require("./emails");
const { badRequest } = require("./validate");

const MAX_ATTEMPTS = 5;
const MAX_LINES = 20;
const CHECK_EVERY_MS = 4000;

const checkoutRef = (id) => `FMC-${1000 + Number(id)}`;
const paymentReference = (id, attempt) => `${checkoutRef(id)}-${attempt}`;
function checkoutIdFromReference(reference) {
  const match = String(reference || "").match(/^FMC-(\d+)-\d+$/);
  return match ? Number(match[1]) - 1000 : null;
}
const payUrl = (checkout) => `/pay.html?checkout=${checkout.id}&token=${checkout.public_token}`;
const newToken = () => crypto.randomBytes(16).toString("hex");

// Listing details needed to price a cart line. Only published listings with
// a price can be bought.
async function loadListings(ids, conn = pool, lock = false) {
  if (!ids.length) return new Map();
  const [rows] = await conn.query(
    `SELECT l.id, l.title, l.quantity, l.price, l.price_unit, l.location, l.status, l.seller_id,
       a.name AS animal_name, a.kind AS animal_kind, c.status AS category_status, a.status AS animal_status,
       s.name AS seller_name, s.business_name AS seller_business_name,
       (SELECT li.thumb_path FROM livestock_images li WHERE li.livestock_id = l.id ORDER BY li.sort_order, li.id LIMIT 1) AS thumb_path
     FROM livestock l
     JOIN categories c ON c.id = l.category_id
     JOIN animals a ON a.id = c.animal_id
     LEFT JOIN sellers s ON s.id = l.seller_id
     WHERE l.id IN (?) ORDER BY l.id${lock ? " FOR UPDATE" : ""}`,
    [ids],
  );
  return new Map(rows.map((r) => [Number(r.id), r]));
}

function buyable(l) {
  return l && l.status === "published" && l.category_status === "active" && l.animal_status === "active"
    && l.price !== null && Number(l.quantity) > 0;
}

// Cart lines from the browser: [{ id, qty }] -> unique, sane lines.
function cleanLines(items) {
  const lines = new Map();
  for (const it of Array.isArray(items) ? items.slice(0, MAX_LINES) : []) {
    const id = Number.parseInt(it && it.id, 10);
    const qty = Number.parseInt(it && it.qty, 10);
    if (id > 0 && qty > 0) lines.set(id, Math.min(qty, 100000));
  }
  return [...lines].map(([id, qty]) => ({ id, qty }));
}

// Prices a cart for the cart and checkout pages. Never trusts the browser's
// prices: only listing ids and quantities come from the cart.
async function quote(items) {
  const lines = cleanLines(items);
  const listings = await loadListings(lines.map((l) => l.id));
  const out = lines.map(({ id, qty }) => {
    const l = listings.get(id);
    if (!buyable(l)) return { id, available: false, title: l ? l.title : null };
    const lot = l.price_unit === "lot";
    const max = Number(l.quantity);
    const quantity = lot ? max : Math.min(qty, max);
    return {
      id,
      available: true,
      title: l.title,
      location: l.location,
      thumb_path: l.thumb_path,
      animal_name: l.animal_name,
      animal_kind: l.animal_kind,
      price: Number(l.price),
      price_unit: l.price_unit,
      max,
      quantity,
      adjusted: !lot && qty > max,
      line_total: lot ? Number(l.price) : Math.round(Number(l.price) * quantity * 100) / 100,
      seller_key: l.seller_id ? `s${l.seller_id}` : "frontier",
    };
  });
  const ok = out.filter((i) => i.available);
  return {
    items: out,
    total: Math.round(ok.reduce((s, i) => s + i.line_total, 0) * 100) / 100,
    sellers: new Set(ok.map((i) => i.seller_key)).size,
  };
}

// Creates the checkout and one order per cart line in one transaction,
// taking the animals or feed off the listings so nobody else can buy them.
async function create(lines, buyer, ip) {
  const clean = cleanLines(lines);
  if (!clean.length) throw badRequest("Your cart is empty.");
  const token = newToken();
  const conn = await pool.getConnection();
  const created = [];
  let checkoutId;
  let total = 0;
  try {
    await conn.beginTransaction();
    const listings = await loadListings(clean.map((l) => l.id), conn, true);
    const problems = [];
    const priced = clean.map(({ id, qty }) => {
      const l = listings.get(id);
      if (!buyable(l)) {
        problems.push(`${l ? l.title : "An item"} is no longer available.`);
        return null;
      }
      const lot = l.price_unit === "lot";
      const quantity = lot ? Number(l.quantity) : qty;
      if (quantity > Number(l.quantity)) problems.push(`Only ${headCount(l.quantity, l.animal_name, l.animal_kind)} of ${l.title} left.`);
      const lineTotal = lot ? Number(l.price) : Math.round(Number(l.price) * quantity * 100) / 100;
      total += lineTotal;
      return { l, quantity, lineTotal };
    });
    if (problems.length) {
      const e = new Error(`${problems.join(" ")} Please review your cart.`);
      e.status = 409;
      e.code = "CART_CHANGED";
      throw e;
    }
    total = Math.round(total * 100) / 100;
    const [c] = await conn.query(
      `INSERT INTO checkouts (public_token, full_name, phone, email, item_count, total, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [token, buyer.full_name, buyer.phone, buyer.email, priced.length, total, ip],
    );
    checkoutId = c.insertId;
    for (const { l, quantity, lineTotal } of priced) {
      const sellerName = l.seller_name ? (l.seller_business_name ? `${l.seller_name} (${l.seller_business_name})` : l.seller_name) : null;
      const [o] = await conn.query(
        `INSERT INTO orders
           (livestock_id, livestock_title, seller_id, seller_name, quantity, unit_price, price_unit, total,
            full_name, phone, email, delivery, payment_method, stock_deducted, ip_address, public_token, checkout_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'collect', 'mobile_money', 1, ?, ?, ?)`,
        [l.id, l.title, l.seller_id, sellerName, quantity, Number(l.price), l.price_unit, lineTotal,
          buyer.full_name, buyer.phone, buyer.email, ip, newToken(), checkoutId],
      );
      const soldOut = Number(l.quantity) - quantity === 0;
      await conn.query(
        "UPDATE livestock SET quantity = quantity - ?, status = IF(quantity = 0, 'unpublished', status) WHERE id = ?",
        [quantity, l.id],
      );
      created.push({ id: o.insertId, l, quantity, total: lineTotal, soldOut, sellerName });
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback().catch(() => {});
    throw error;
  } finally {
    conn.release();
  }

  const checkout = await load(checkoutId);
  notifyCreated(checkout, created).catch((error) => console.error(`Checkout ${checkoutRef(checkoutId)}: emails failed (${error.message})`));
  return checkout;
}

const unitsText = (o) => {
  const units = headCount(o.quantity, o.l ? o.l.animal_name : o.animal_name, o.l ? o.l.animal_kind : o.animal_kind);
  return o.l ? (o.l.price_unit === "lot" ? `The whole lot (${units})` : units) : units;
};

async function notifyCreated(checkout, created) {
  const ref = checkoutRef(checkout.id);
  const online = lenco.enabled();
  const itemRows = created.map((o) => [`${orderRef(o.id)} · ${o.l.title}`, `${unitsText(o)} · ${kwacha(o.total)}`]);
  const sellers = new Set(created.map((o) => o.l.seller_id || "frontier")).size;
  const [team] = await Promise.all([
    sendEmail({
      to: recipients(),
      subject: `New order ${ref}: ${created.length} item${created.length === 1 ? "" : "s"}, ${kwacha(checkout.total)}`,
      heading: `New order ${ref}`,
      paragraphs: [
        `${checkout.full_name} checked out ${created.length} item${created.length === 1 ? "" : "s"}${sellers > 1 ? ` from ${sellers} sellers` : ""}. Each item is its own order in Admin > Orders. The stock has been taken off the listings; cancelling an order puts it back.`,
        online ? "The buyer is paying by mobile money on the website. You'll get another email when the payment goes through." : "Online payment is switched off, so please arrange payment with the buyer.",
      ],
      rows: [
        ...itemRows,
        ["Total", kwacha(checkout.total)],
        ["Buyer", checkout.full_name],
        ["WhatsApp", checkout.phone],
        ["Email", checkout.email],
        ...created.filter((o) => o.sellerName).map((o) => [`Seller (${orderRef(o.id)})`, o.sellerName]),
      ],
      button: { label: "Open orders", url: appUrl(`/admin/orders.html?id=${created[0].id}`) },
      replyTo: checkout.email,
    }),
    sendEmail({
      to: checkout.email,
      subject: `Order ${ref} received`,
      heading: `Order ${ref} received`,
      paragraphs: [
        `Hi ${String(checkout.full_name).trim().split(/\s+/)[0]},`,
        `Thank you for your order. ${created.length === 1 ? "Your item is" : "Your items are"} now reserved for you.`,
      ],
      rows: [...itemRows, ["Total", kwacha(checkout.total)], ["Collection", "Collect from the farm. We'll arrange it with you."]],
      stepsTitle: "What happens next",
      steps: [
        online ? "Pay by mobile money (Airtel, MTN or Zamtel) on the payment page, if you haven't yet." : "We contact you to arrange mobile money payment.",
        "We confirm everything with the seller.",
        "We contact you on WhatsApp and email to arrange collection.",
      ],
      button: online ? { label: "Complete payment", url: appUrl(payUrl(checkout)) } : undefined,
    }),
  ]);
  await pool.query("UPDATE orders SET email_status = ?, email_error = ? WHERE checkout_id = ?", [
    team.sent ? "sent" : "failed",
    team.sent ? null : String(team.error || "").slice(0, 500),
    checkout.id,
  ]);
  for (const o of created) {
    if (o.soldOut && o.l.seller_id) emails.listingSoldOut(o.l.seller_id, { id: o.l.id, title: o.l.title });
  }
}

async function load(id) {
  const [[c]] = await pool.query("SELECT * FROM checkouts WHERE id = ?", [id]);
  return c || null;
}

async function ordersOf(id) {
  const [rows] = await pool.query(
    `SELECT o.*, a.name AS animal_name, a.kind AS animal_kind,
       (SELECT li.thumb_path FROM livestock_images li WHERE li.livestock_id = o.livestock_id ORDER BY li.sort_order, li.id LIMIT 1) AS thumb_path
     FROM orders o
     LEFT JOIN livestock l ON l.id = o.livestock_id
     LEFT JOIN categories c ON c.id = l.category_id
     LEFT JOIN animals a ON a.id = c.animal_id
     WHERE o.checkout_id = ? ORDER BY o.id`,
    [id],
  );
  return rows;
}

const isOpen = (o) => o.status !== "cancelled" && o.status !== "completed";
const due = (orders) => Math.round(orders.filter((o) => isOpen(o) && o.payment_status !== "paid").reduce((s, o) => s + Number(o.total), 0) * 100) / 100;

function maskPhone(phone) {
  const local = lenco.localPhone(phone);
  return local.length >= 7 ? `${local.slice(0, 4)} ••• ${local.slice(-3)}` : local;
}

// What the payment page is told.
function publicView(checkout, orders) {
  const amount = checkout.payment_status === "paid" ? Number(checkout.total) : due(orders);
  return {
    id: checkout.id,
    reference: checkoutRef(checkout.id),
    status: checkout.payment_status,
    failure: checkout.payment_status === "failed" ? checkout.payment_failure : null,
    operator: OPERATOR_LABELS[checkout.mobile_operator] || null,
    operator_key: checkout.mobile_operator,
    phone: checkout.payment_phone ? maskPhone(checkout.payment_phone) : null,
    total: amount,
    attempts_left: Math.max(0, MAX_ATTEMPTS - Number(checkout.payment_attempts || 0)),
    closed: checkout.payment_status !== "paid" && !orders.some(isOpen),
    online: lenco.enabled(),
    first_name: String(checkout.full_name).trim().split(/\s+/)[0],
    items: orders.map((o) => ({
      reference: orderRef(o.id),
      title: o.livestock_title,
      quantity: o.price_unit === "lot" ? `The whole lot (${headCount(o.quantity, o.animal_name, o.animal_kind)})` : headCount(o.quantity, o.animal_name, o.animal_kind),
      total: Number(o.total),
      thumb_path: o.thumb_path,
      cancelled: o.status === "cancelled",
    })),
  };
}

// Copies the checkout's payment state onto its unpaid orders, so the admin
// and seller pages show it.
async function syncOrders(checkout) {
  await pool.query(
    `UPDATE orders SET payment_status = ?, payment_failure = ?, mobile_operator = ?, payment_phone = ?,
       payment_attempts = ?, payment_reference = ?
     WHERE checkout_id = ? AND payment_status <> 'paid' AND status <> 'cancelled'`,
    [checkout.payment_status, checkout.payment_failure, checkout.mobile_operator, checkout.payment_phone,
      checkout.payment_attempts, checkout.payment_reference, checkout.id],
  );
}

async function markPaid(checkout, data) {
  const providerRef = data.lencoReference || (data.mobileMoneyDetails && data.mobileMoneyDetails.operatorTransactionId) || null;
  const [result] = await pool.query(
    `UPDATE checkouts SET payment_status = 'paid', payment_failure = NULL, paid_at = NOW(),
       payment_provider_ref = COALESCE(?, payment_provider_ref)
     WHERE id = ? AND payment_status <> 'paid'`,
    [providerRef, checkout.id],
  );
  if (!result.affectedRows) return;
  const orders = (await ordersOf(checkout.id)).filter((o) => isOpen(o) && o.payment_status !== "paid");
  await pool.query(
    `UPDATE orders SET payment_status = 'paid', payment_failure = NULL, paid_at = NOW(), payment_method = 'mobile_money',
       payment_provider_ref = COALESCE(?, payment_provider_ref), mobile_operator = ?, payment_phone = ?,
       status = IF(status IN ('new', 'confirmed'), 'paid', status)
     WHERE checkout_id = ? AND payment_status <> 'paid' AND status NOT IN ('cancelled', 'completed')`,
    [providerRef, checkout.mobile_operator, checkout.payment_phone, checkout.id],
  );
  const ref = checkoutRef(checkout.id);
  const amount = kwacha(data.amount || checkout.total);
  const how = `${OPERATOR_LABELS[checkout.mobile_operator] || "Mobile money"} (${lenco.localPhone(checkout.payment_phone)})`;
  const itemRows = orders.map((o) => [`${orderRef(o.id)} · ${o.livestock_title}`, kwacha(o.total)]);
  const rows = [["Order", ref], ...itemRows, ["Amount paid", amount], ["Paid with", how]];
  if (providerRef) rows.push(["Payment reference", providerRef]);
  sendEmail({
    to: checkout.email,
    subject: `Payment received for order ${ref}`,
    heading: "Payment received",
    paragraphs: [
      `Hi ${String(checkout.full_name).trim().split(/\s+/)[0]}, we've received your payment of ${amount} for order ${ref}. Thank you.`,
      "We'll contact you on both WhatsApp and email to arrange collection.",
    ],
    rows,
  });
  sendEmail({
    to: recipients(),
    subject: `Order ${ref} paid: ${amount}`,
    heading: `Order ${ref} has been paid`,
    paragraphs: [`${checkout.full_name} paid ${amount} by ${how}. ${orders.length === 1 ? "The order is" : `All ${orders.length} orders are`} now marked paid, and each seller has been told.`],
    rows: [...rows, ["Buyer", checkout.full_name], ["WhatsApp", checkout.phone]],
    button: orders[0] ? { label: "Open orders", url: appUrl(`/admin/orders.html?id=${orders[0].id}`) } : undefined,
  });
  for (const o of orders) {
    payments.tellSeller({ ...o, payment_status: "paid" }).catch((error) => console.error(`Order ${orderRef(o.id)}: seller notice failed (${error.message})`));
  }
}

async function markFailed(checkout, reason, reference) {
  await pool.query(
    `UPDATE checkouts SET payment_status = 'failed', payment_failure = ?
     WHERE id = ? AND payment_status <> 'paid' AND (? IS NULL OR payment_reference = ?)`,
    [String(reason || "The payment was not completed.").slice(0, 255), checkout.id, reference || null, reference || null],
  );
  const fresh = await load(checkout.id);
  if (fresh && fresh.payment_status === "failed") await syncOrders(fresh);
}

async function applyCollection(checkout, data) {
  const status = data && data.status;
  if (status === "successful") {
    if (Number(data.amount) + 0.005 < Number(checkout.total)) {
      return markFailed(checkout, "The amount paid did not match the order. Our team will contact you.", data.reference);
    }
    return markPaid(checkout, data);
  }
  if (status === "failed") return markFailed(checkout, data.reasonForFailure, data.reference);
}

// Sends the PIN prompt for whatever is still owed on the checkout.
async function startCollection(checkout, { operator, phone }) {
  const orders = await ordersOf(checkout.id);
  const amount = due(orders);
  const attempt = Number(checkout.payment_attempts || 0) + 1;
  const reference = paymentReference(checkout.id, attempt);
  await pool.query(
    `UPDATE checkouts SET payment_status = 'pending', payment_reference = ?, payment_failure = NULL, total = ?,
       payment_attempts = ?, payment_checked_at = NOW(), mobile_operator = ?, payment_phone = ?
     WHERE id = ?`,
    [reference, amount, attempt, operator, phone, checkout.id],
  );
  const current = await load(checkout.id);
  await syncOrders(current);
  try {
    const data = await lenco.collectMobileMoney({ amount, reference, phone, operator });
    await applyCollection(current, { ...data, reference });
  } catch (error) {
    console.error(`Checkout ${checkoutRef(checkout.id)}: payment request failed (${error.message})`);
    await markFailed(current, `We couldn't send the payment request: ${error.message}`, reference);
  }
  return load(checkout.id);
}

// Asks Lenco for news on a pending payment (at most every few seconds).
async function refresh(checkout) {
  if (checkout.payment_status !== "pending" || !checkout.payment_reference || !lenco.enabled()) return checkout;
  const last = checkout.payment_checked_at ? new Date(checkout.payment_checked_at).getTime() : 0;
  if (Date.now() - last < CHECK_EVERY_MS) return checkout;
  await pool.query("UPDATE checkouts SET payment_checked_at = NOW() WHERE id = ?", [checkout.id]);
  try {
    const data = await lenco.collectionStatus(checkout.payment_reference);
    await applyCollection(checkout, { ...data, reference: data.reference || checkout.payment_reference });
  } catch (error) {
    if (error.status !== 404) console.error(`Checkout ${checkoutRef(checkout.id)}: status check failed (${error.message})`);
  }
  return load(checkout.id);
}

// --- Reminder emails (scheduler) ------------------------------------------

function reminderEmails(checkout, orders) {
  const ref = checkoutRef(checkout.id);
  const amount = kwacha(due(orders));
  const items = orders.filter(isOpen).map((o) => [`${orderRef(o.id)} · ${o.livestock_title}`, kwacha(o.total)]);
  const tried = Number(checkout.payment_attempts) > 0;
  return Promise.all([
    sendEmail({
      to: checkout.email,
      subject: tried ? `Your payment for order ${ref} didn't go through` : `Complete your payment for order ${ref}`,
      heading: tried ? "Your payment didn't go through" : "Complete your payment",
      paragraphs: [
        `Hi ${String(checkout.full_name).trim().split(/\s+/)[0]},`,
        tried
          ? `Your mobile money payment for order ${ref} wasn't completed${checkout.payment_failure ? ` (reason: ${checkout.payment_failure})` : ""}. Don't worry: your items are still reserved for you.`
          : `Your items are reserved for you, but we haven't received your payment for order ${ref} yet.`,
      ],
      rows: [...items, ["Amount", amount]],
      button: { label: "Complete payment", url: appUrl(payUrl(checkout)) },
      after: ["Prefer to pay another way? Reply to this email and we'll help."],
    }),
    sendEmail({
      to: recipients(),
      subject: `Unpaid order ${ref}: ${amount}`,
      heading: `Order ${ref} is unpaid`,
      paragraphs: [`${checkout.full_name} hasn't completed the mobile money payment for order ${ref}${checkout.payment_failure ? ` (${checkout.payment_failure})` : ""}. The items are still reserved. You may want to follow up.`],
      rows: [...items, ["Amount", amount], ["WhatsApp", checkout.phone], ["Attempts", String(checkout.payment_attempts || 0)]],
      button: orders[0] ? { label: "Open orders", url: appUrl(`/admin/orders.html?id=${orders[0].id}`) } : undefined,
    }),
  ]);
}

async function sendReminders(afterMinutes) {
  if (!lenco.enabled()) return;
  const [rows] = await pool.query(
    `SELECT * FROM checkouts
     WHERE payment_status IN ('unpaid', 'failed', 'pending') AND payment_reminder_at IS NULL
       AND created_at < NOW() - INTERVAL ? MINUTE AND created_at > NOW() - INTERVAL 3 DAY
     ORDER BY id LIMIT 20`,
    [afterMinutes],
  );
  for (let checkout of rows) {
    if (checkout.payment_status === "pending") checkout = await refresh({ ...checkout, payment_checked_at: null });
    if (!checkout || checkout.payment_status === "paid") continue;
    const orders = await ordersOf(checkout.id);
    if (!due(orders)) continue;
    const [claim] = await pool.query(
      "UPDATE checkouts SET payment_reminder_at = NOW() WHERE id = ? AND payment_reminder_at IS NULL",
      [checkout.id],
    );
    if (claim.affectedRows) await reminderEmails(checkout, orders);
  }
}

module.exports = {
  MAX_ATTEMPTS,
  checkoutRef,
  checkoutIdFromReference,
  payUrl,
  quote,
  create,
  load,
  ordersOf,
  publicView,
  startCollection,
  refresh,
  applyCollection,
  sendReminders,
};
