// Shopping-cart checkout: mobile money or Visa / Mastercard.
//
// The buyer fills a cart (kept in their browser), gives their details at
// checkout and pays once for the whole cart on the payment page. Behind the
// scenes every cart line becomes its own order (orders.checkout_id), so each
// seller, the admin pages and the order emails work exactly as for a single
// order. The payment belongs to the checkout: when it succeeds, every open
// order in it is marked paid and each seller is told about their part.
//
// Payment, by whichever provider is switched on in .env (Lipila first):
//   Lipila   the PIN prompt goes straight to the buyer's phone (Airtel, MTN,
//            Zamtel); confirmed with Lipila's check-status.
//   Lenco    the same, through Lenco.
//   neither  the order is placed and the team arranges payment.
const crypto = require("crypto");
const pool = require("../db");
const lenco = require("../services/lenco");
const lipila = require("../services/lipila");
const { sendEmail, recipients, appUrl } = require("../services/mailer");
const { orderRef, kwacha, headCount, OPERATOR_LABELS } = require("./orders");
const payments = require("./payments");
const txlog = require("./txlog");
const emails = require("./emails");
const { badRequest } = require("./validate");

const MAX_ATTEMPTS = 5;
const MAX_LINES = 20;
const CHECK_EVERY_MS = 4000;
// Mobile money and card: the items are held (not taken off the listing) for
// this long while the buyer pays. Stock comes off only once the payment is
// confirmed.
const HOLD_MINUTES = 10;
// A payment with no clear answer from Lipila after this long: the team and
// the buyer are told, and it keeps being checked (less often). It is never
// marked "not completed" unless Lipila says so.
const ALERT_AFTER_MIN = 30;

const checkoutRef = (id) => `FMC-${1000 + Number(id)}`;
const paymentReference = (id, attempt) => `${checkoutRef(id)}-${attempt}`;
function checkoutIdFromReference(reference) {
  const match = String(reference || "").match(/^FMC-(\d+)-\d+$/);
  return match ? Number(match[1]) - 1000 : null;
}
// Where the buyer pays (and waits for the PIN prompt): our payment page.
const ourPayPage = (checkout) => `/pay.html?checkout=${checkout.id}&token=${checkout.public_token}`;
const payUrl = ourPayPage;
const provider = () => (lipila.enabled() ? "lipila" : lenco.enabled() ? "lenco" : null);
// Mobile money networks the buyer can choose.
const operators = () => (provider() ? ["airtel", "mtn", "zamtel"] : []);

// How buyers can pay at checkout, in order.
function methods() {
  const out = [];
  if (provider()) out.push("mobile_money");
  if (lipila.cardsEnabled()) out.push("card");
  return out;
}
const METHOD_LABELS = { mobile_money: "Mobile money", card: "Visa / Mastercard" };
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

// Quantities held for buyers who are paying right now (mobile money and
// card), per listing. A checkout never counts its own holds.
async function heldQuantities(ids, conn = pool, exceptCheckout = 0) {
  if (!ids.length) return new Map();
  const [rows] = await conn.query(
    `SELECT livestock_id, SUM(quantity) AS q FROM orders
     WHERE livestock_id IN (?) AND stock_deducted = 0 AND hold_until > NOW()
       AND status NOT IN ('cancelled', 'completed') AND payment_status <> 'paid'
       AND (checkout_id IS NULL OR checkout_id <> ?)
     GROUP BY livestock_id`,
    [ids, exceptCheckout],
  );
  return new Map(rows.map((r) => [Number(r.livestock_id), Number(r.q)]));
}

// Mobile money (with a provider on) and card: stock is held while the buyer
// pays and taken off only when the payment is confirmed. Bank transfer and
// offline orders take the stock off straight away, as the team confirms
// those payments by hand.
const holdsStock = (method) => method === "card" || (method === "mobile_money" && Boolean(provider()));

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
  const held = await heldQuantities(lines.map((l) => l.id));
  const out = lines.map(({ id, qty }) => {
    const l = listings.get(id);
    if (!buyable(l)) return { id, available: false, title: l ? l.title : null };
    const lot = l.price_unit === "lot";
    const max = Number(l.quantity) - (held.get(id) || 0);
    if (max <= 0 || (lot && max < Number(l.quantity))) return { id, available: false, held: true, title: l.title };
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
    payment: { provider: provider(), operators: operators(), methods: methods() },
    items: out,
    total: Math.round(ok.reduce((s, i) => s + i.line_total, 0) * 100) / 100,
    sellers: new Set(ok.map((i) => i.seller_key)).size,
  };
}

// Creates the checkout and one order per cart line in one transaction,
// taking the animals or feed off the listings so nobody else can buy them.
async function create(lines, buyer, ip, pay = null) {
  const method = pay && methods().includes(pay.method) ? pay.method : "mobile_money";
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
    const held = await heldQuantities(clean.map((l) => l.id), conn);
    const hold = holdsStock(method);
    const problems = [];
    const priced = clean.map(({ id, qty }) => {
      const l = listings.get(id);
      if (!buyable(l)) {
        problems.push(`${l ? l.title : "An item"} is no longer available.`);
        return null;
      }
      const lot = l.price_unit === "lot";
      const free = Number(l.quantity) - (held.get(id) || 0);
      if (free <= 0 || (lot && free < Number(l.quantity))) {
        problems.push(`Another buyer is paying for ${l.title} right now. Try again in a few minutes.`);
        return null;
      }
      const quantity = lot ? Number(l.quantity) : qty;
      if (quantity > free) problems.push(`Only ${headCount(free, l.animal_name, l.animal_kind)} of ${l.title} left.`);
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
      `INSERT INTO checkouts (public_token, full_name, phone, email, item_count, total, payment_method, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [token, buyer.full_name, buyer.phone, buyer.email, priced.length, total, method, ip],
    );
    checkoutId = c.insertId;
    for (const { l, quantity, lineTotal } of priced) {
      const sellerName = l.seller_name ? (l.seller_business_name ? `${l.seller_name} (${l.seller_business_name})` : l.seller_name) : null;
      const [o] = await conn.query(
        `INSERT INTO orders
           (livestock_id, livestock_title, seller_id, seller_name, quantity, unit_price, price_unit, total,
            full_name, phone, email, delivery, payment_method, stock_deducted, hold_until, ip_address, public_token, checkout_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'collect', ?, ?, IF(?, NOW() + INTERVAL ? MINUTE, NULL), ?, ?, ?)`,
        [l.id, l.title, l.seller_id, sellerName, quantity, Number(l.price), l.price_unit, lineTotal,
          buyer.full_name, buyer.phone, buyer.email, method, hold ? 0 : 1, hold ? 1 : 0, HOLD_MINUTES, ip, newToken(), checkoutId],
      );
      // Held while the buyer pays (mobile money, card), or taken off now.
      const soldOut = !hold && Number(l.quantity) - quantity === 0;
      if (!hold) {
        await conn.query(
          "UPDATE livestock SET quantity = quantity - ?, status = IF(quantity = 0, 'unpublished', status) WHERE id = ?",
          [quantity, l.id],
        );
      }
      created.push({ id: o.insertId, l, quantity, total: lineTotal, soldOut, sellerName });
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback().catch(() => {});
    throw error;
  } finally {
    conn.release();
  }

  if (buyer.acceptedTerms) await pool.query("UPDATE checkouts SET terms_accepted_at = NOW() WHERE id = ?", [checkoutId]);
  let checkout = await load(checkoutId);
  if (buyer.acceptedTerms) {
    txlog.record({ checkoutId, event: "terms_accepted", actor: "buyer", ip, detail: "Buyer ticked the box: read and accepted the Terms, Refund, Return and Cancellation policies." });
  }
  txlog.record({
    checkoutId, event: "order_placed", actor: "buyer", amount: checkout.total, ip,
    status: holdsStock(method) ? "held" : "reserved",
    detail: `${buyer.full_name} placed the order: ${created.map((o) => `${o.l.title} (${orderRef(o.id)}, ${kwacha(o.total)})`).join("; ")}. Paying by ${METHOD_LABELS[method] || method}. ${holdsStock(method) ? `Items held for ${HOLD_MINUTES} minutes while the buyer pays.` : "Items reserved."}`,
  });
  // Mobile money: the PIN prompt goes to the buyer's phone right away.
  // Card: the payment opens on Lipila's card page. Bank transfer: the buyer
  // gets Frontier's bank details and the team confirms the payment.
  if (method === "card") checkout = await startCard(checkout, { ...pay, fresh: true });
  else if (method === "mobile_money" && provider() && pay && pay.operator && pay.phone) checkout = await startPayment(checkout, { ...pay, fresh: true });
  notifyCreated(checkout, created).catch((error) => console.error(`Checkout ${checkoutRef(checkoutId)}: emails failed (${error.message})`));
  return checkout;
}

const unitsText = (o) => {
  const units = headCount(o.quantity, o.l ? o.l.animal_name : o.animal_name, o.l ? o.l.animal_kind : o.animal_kind);
  return o.l ? (o.l.price_unit === "lot" ? `The whole lot (${units})` : units) : units;
};

async function notifyCreated(checkout, created) {
  const method0 = checkout.payment_method || "mobile_money";
  // Mobile money and card: no email yet. The buyer's only email is
  // "Payment received", and the team hears once the payment is confirmed.
  if (holdsStock(method0)) return;
  const ref = checkoutRef(checkout.id);
  const method = method0;
  const online = Boolean(provider());
  const itemRows = created.map((o) => [`${orderRef(o.id)} · ${o.l.title}`, `${unitsText(o)} · ${kwacha(o.total)}`]);
  const sellers = new Set(created.map((o) => o.l.seller_id || "frontier")).size;
  const [team] = await Promise.all([
    sendEmail({
      to: recipients(),
      subject: `New order ${ref}: ${created.length} item${created.length === 1 ? "" : "s"}, ${kwacha(checkout.total)}`,
      heading: `New order ${ref}`,
      paragraphs: [
        `${checkout.full_name} checked out ${created.length} item${created.length === 1 ? "" : "s"}${sellers > 1 ? ` from ${sellers} sellers` : ""}. Each item is its own order in Admin > Orders. The stock has been taken off the listings; cancelling an order puts it back.`,
        online
            ? `The buyer is paying by ${method === "card" ? "card" : "mobile money"} on the website. You'll get another email when the payment goes through.`
            : "Online payment is switched off, so please arrange payment with the buyer.",
      ],
      rows: [
        ...itemRows,
        ["Total", kwacha(checkout.total)],
        ["Payment", METHOD_LABELS[method]],
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
      rows: [
        ...itemRows,
        ["Total", kwacha(checkout.total)],
        ["Collection", "Collect from the farm. We'll arrange it with you."],
      ],
      stepsTitle: "What happens next",
      steps: [
        ...(online
            ? ["You'll get an email as soon as your payment is confirmed."]
            : ["We'll contact you on WhatsApp to arrange payment."]),
        "We'll contact you to arrange collection.",
        `At collection, check the animals or feed before you accept them, and have your order number ${ref} ready.`,
      ],
      button: online ? { label: "View your order", url: appUrl(ourPayPage(checkout)) } : undefined,
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
  // Paid when the provider confirmed it, or when the team has marked every
  // open order paid (bank transfer).
  const open = orders.filter((o) => o.status !== "cancelled");
  const settled = checkout.payment_status === "paid" || (open.length > 0 && open.every((o) => o.payment_status === "paid"));
  const amount = settled ? (checkout.payment_status === "paid" ? Number(checkout.total) : open.reduce((s, o) => s + Number(o.total), 0)) : due(orders);
  const current = provider();
  return {
    provider: current,
    operators: operators(),
    method: checkout.payment_method || "mobile_money",
    methods: methods(),
    // Card: Lipila's card page for the open payment.
    pay_url: checkout.payment_method === "card" && checkout.payment_status === "pending" ? checkout.payment_url : null,
    id: checkout.id,
    reference: checkoutRef(checkout.id),
    status: settled ? "paid" : checkout.payment_status,
    failure: checkout.payment_status === "failed" ? checkout.payment_failure : null,
    operator: OPERATOR_LABELS[checkout.mobile_operator] || null,
    operator_key: checkout.mobile_operator,
    phone: checkout.payment_phone ? maskPhone(checkout.payment_phone) : null,
    total: amount,
    attempts_left: Math.max(0, MAX_ATTEMPTS - Number(checkout.payment_attempts || 0)),
    closed: checkout.payment_status !== "paid" && !orders.some(isOpen),
    // No answer from Lipila for a while: the team is checking it.
    checking: checkout.payment_status === "pending" && Boolean(checkout.payment_alert_at),
    hold_minutes: HOLD_MINUTES,
    online: Boolean(current),
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
       payment_attempts = ?, payment_reference = ?, payment_method = ?
     WHERE checkout_id = ? AND payment_status <> 'paid' AND status <> 'cancelled'`,
    [checkout.payment_status, checkout.payment_failure, checkout.mobile_operator, checkout.payment_phone,
      checkout.payment_attempts, checkout.payment_reference, checkout.payment_method || "mobile_money", checkout.id],
  );
}

// Takes paid orders' items off their listings (mobile money and card orders
// only held them). Returns { soldOut: [...], short: [...] }: short lists any
// order whose items were sold to someone else in the meantime.
async function takeStock(checkoutId) {
  const conn = await pool.getConnection();
  const soldOut = [];
  const short = [];
  try {
    await conn.beginTransaction();
    const [orders] = await conn.query(
      `SELECT * FROM orders WHERE checkout_id = ? AND stock_deducted = 0 AND livestock_id IS NOT NULL
         AND status NOT IN ('cancelled', 'completed') FOR UPDATE`,
      [checkoutId],
    );
    for (const o of orders) {
      const [[l]] = await conn.query("SELECT id, title, seller_id, quantity FROM livestock WHERE id = ? FOR UPDATE", [o.livestock_id]);
      if (!l || Number(l.quantity) < Number(o.quantity)) {
        short.push({ order: o, left: l ? Number(l.quantity) : 0 });
        continue;
      }
      const left = Number(l.quantity) - Number(o.quantity);
      await conn.query("UPDATE livestock SET quantity = ?, status = IF(? = 0, 'unpublished', status) WHERE id = ?", [left, left, l.id]);
      await conn.query("UPDATE orders SET stock_deducted = 1, hold_until = NULL WHERE id = ?", [o.id]);
      if (left === 0) soldOut.push(l);
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback().catch(() => {});
    throw error;
  } finally {
    conn.release();
  }
  return { soldOut, short };
}

// "Tray of eggs" / "Tray of eggs and Grower pellets" / "A, B and C"
function listingNames(orders) {
  const names = [...new Set(orders.map((o) => o.livestock_title))];
  return names.length < 2 ? names[0] || "order" : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// The payment is confirmed: orders become Paid, the stock comes off the
// listings, and the buyer, the team and each seller are emailed.
async function markPaid(checkout, data) {
  const providerRef = data.providerRef || data.lencoReference || (data.mobileMoneyDetails && data.mobileMoneyDetails.operatorTransactionId) || null;
  const [result] = await pool.query(
    `UPDATE checkouts SET payment_status = 'paid', payment_failure = NULL, paid_at = NOW(),
       payment_provider_ref = COALESCE(?, payment_provider_ref)
     WHERE id = ? AND payment_status <> 'paid'`,
    [providerRef, checkout.id],
  );
  if (!result.affectedRows) return;
  txlog.record({
    checkoutId: checkout.id, reference: data.reference || checkout.payment_reference, event: "payment_confirmed", status: "paid",
    actor: "lipila", amount: data.amount || checkout.total,
    detail: `Lipila confirmed the payment of ${kwacha(data.amount || checkout.total)}${providerRef ? ` (network reference ${providerRef})` : ""}. Orders marked Paid.`,
    data: data.raw || null,
  });
  const orders = (await ordersOf(checkout.id)).filter((o) => isOpen(o) && o.payment_status !== "paid");
  await pool.query(
    `UPDATE orders SET payment_status = 'paid', payment_failure = NULL, paid_at = NOW(), payment_method = ?,
       payment_provider_ref = COALESCE(?, payment_provider_ref), mobile_operator = ?, payment_phone = ?,
       status = IF(status IN ('new', 'confirmed'), 'paid', status)
     WHERE checkout_id = ? AND payment_status <> 'paid' AND status NOT IN ('cancelled', 'completed')`,
    [checkout.payment_method || "mobile_money", providerRef, checkout.mobile_operator, checkout.payment_phone, checkout.id],
  );
  let stock = { soldOut: [], short: [] };
  try {
    stock = await takeStock(checkout.id);
  } catch (error) {
    console.error(`Checkout ${checkoutRef(checkout.id)}: stock not updated after payment (${error.message})`);
  }
  for (const { order, left } of stock.short) {
    console.error(`Order ${orderRef(order.id)}: paid, but not enough left on the listing`);
    txlog.record({ checkoutId: checkout.id, orderId: order.id, event: "stock_short", status: "action_needed", detail: `${orderRef(order.id)} ${order.livestock_title}: paid, but only ${left} left on the listing. Contact the buyer about a replacement or a refund.` });
  }
  const taken = orders.filter((o) => o.livestock_id && !stock.short.some((x) => x.order.id === o.id));
  if (taken.length) {
    txlog.record({ checkoutId: checkout.id, event: "stock_taken", detail: `Stock taken off the listings: ${taken.map((o) => `${o.livestock_title} (${orderRef(o.id)}, ${o.quantity})`).join("; ")}${stock.soldOut.length ? `. Sold out: ${stock.soldOut.map((l) => l.title).join(", ")}` : ""}.` });
  }

  const ref = checkoutRef(checkout.id);
  const amount = kwacha(data.amount || checkout.total);
  const how = checkout.payment_method === "card"
    ? "Visa / Mastercard"
    : checkout.payment_method === "bank_transfer"
      ? "Bank transfer"
      : `${OPERATOR_LABELS[checkout.mobile_operator] || "Mobile money"} (${lenco.localPhone(checkout.payment_phone)})`;
  const units = (o) => (o.price_unit === "lot" ? `The whole lot (${headCount(o.quantity, o.animal_name, o.animal_kind)})` : headCount(o.quantity, o.animal_name, o.animal_kind));
  const itemRows = orders.map((o) => [`${orderRef(o.id)} · ${o.livestock_title}`, `${units(o)} · ${kwacha(o.total)}`]);
  const rows = [["Order", ref], ...itemRows, ["Amount paid", amount], ["Paid with", how]];
  if (providerRef) rows.push(["Payment reference", providerRef]);
  const shortIds = new Set(stock.short.map((x) => x.order.id));
  txlog.recordEmail(sendEmail({
    to: checkout.email,
    subject: `Payment received for order ${ref}`,
    log: true,
    heading: "Payment received",
    paragraphs: [
      `Hi ${String(checkout.full_name).trim().split(/\s+/)[0]}, we've received your payment of ${amount} for the ${listingNames(orders)} with the reference number ${ref}. Your order has been confirmed, kindly advise your mode of collection of the ${orders.length === 1 ? "listing" : "listings"}. Thank you!`,
      ...(shortIds.size ? ["One of your items sold out just before your payment came through. We'll contact you today to offer a replacement or a refund."] : []),
    ],
    rows,
    button: { label: "View your order", url: appUrl(ourPayPage(checkout)) },
  }), { checkoutId: checkout.id, who: "buyer", to: checkout.email });
  txlog.recordEmail(sendEmail({
    to: recipients(),
    subject: `New paid order ${ref}: ${amount}`,
    log: true,
    heading: `New paid order ${ref}`,
    paragraphs: [
      `${checkout.full_name} paid ${amount} by ${how}. ${orders.length === 1 ? "The order is" : `All ${orders.length} orders are`} now marked Paid, the stock has been taken off the listings, and each seller has been told.`,
      ...stock.short.map(({ order, left }) => `Action needed: ${orderRef(order.id)} (${order.livestock_title}) was paid, but only ${left} ${left === 1 ? "is" : "are"} left on the listing. Contact the buyer to offer a replacement or a refund.`),
    ],
    rows: [
      ...rows,
      ["Buyer", checkout.full_name],
      ["WhatsApp", checkout.phone],
      ["Email", checkout.email],
      ...orders.filter((o) => o.seller_name).map((o) => [`Seller (${orderRef(o.id)})`, o.seller_name]),
    ],
    button: orders[0] ? { label: "Open orders", url: appUrl(`/admin/orders.html?id=${orders[0].id}`) } : undefined,
    replyTo: checkout.email,
  }), { checkoutId: checkout.id, who: "team", to: recipients().join(", ") });
  for (const o of orders) {
    if (shortIds.has(o.id)) continue;
    payments.tellSeller({ ...o, payment_status: "paid" })
      .then((r) => txlog.record({
        checkoutId: checkout.id, orderId: o.id, event: r && r.sent ? "email_sent" : r && r.skipped ? "email_skipped" : "email_failed",
        detail: r && r.sent ? `"New order" email sent to the seller of ${o.livestock_title} (${r.to})`
          : r && r.skipped ? `No seller email for ${o.livestock_title}: ${r.skipped}`
            : `Seller email for ${o.livestock_title} not sent: ${(r && r.error) || "unknown error"}`,
      }))
      .catch((error) => console.error(`Order ${orderRef(o.id)}: seller notice failed (${error.message})`));
  }
  for (const l of stock.soldOut) {
    if (l.seller_id) emails.listingSoldOut(l.seller_id, { id: l.id, title: l.title });
  }
}

// The payment didn't go through. The held items are released right away so
// others can buy them.
async function markFailed(checkout, reason, reference) {
  await pool.query(
    `UPDATE checkouts SET payment_status = 'failed', payment_failure = ?
     WHERE id = ? AND payment_status <> 'paid' AND (? IS NULL OR payment_reference = ?)`,
    [String(reason || "The payment was not completed.").slice(0, 255), checkout.id, reference || null, reference || null],
  );
  const fresh = await load(checkout.id);
  if (!fresh || fresh.payment_status !== "failed") return;
  await syncOrders(fresh);
  await pool.query("UPDATE orders SET hold_until = NULL WHERE checkout_id = ? AND stock_deducted = 0", [checkout.id]);
  txlog.record({
    checkoutId: checkout.id, reference: fresh.payment_reference, event: "payment_failed", status: "failed", actor: "lipila",
    amount: fresh.total, detail: `Payment not completed: ${fresh.payment_failure || "no reason given"}. Held items released.`,
  });
  // The buyer sees the failure on their payment page and can try again
  // there; they are only emailed once a payment succeeds.
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

// Before another payment attempt: hold the items again for HOLD_MINUTES,
// unless someone else has bought them or is paying for them right now.
async function holdItems(checkout) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [orders] = await conn.query(
      `SELECT id, livestock_id, livestock_title, quantity FROM orders
       WHERE checkout_id = ? AND stock_deducted = 0 AND livestock_id IS NOT NULL
         AND payment_status <> 'paid' AND status NOT IN ('cancelled', 'completed') FOR UPDATE`,
      [checkout.id],
    );
    if (orders.length) {
      const ids = [...new Set(orders.map((o) => o.livestock_id))];
      const [listings] = await conn.query("SELECT id, quantity, status FROM livestock WHERE id IN (?) FOR UPDATE", [ids]);
      const byId = new Map(listings.map((l) => [Number(l.id), l]));
      const held = await heldQuantities(ids, conn, checkout.id);
      const gone = orders.filter((o) => {
        const l = byId.get(Number(o.livestock_id));
        return !l || l.status !== "published" || Number(l.quantity) - (held.get(Number(o.livestock_id)) || 0) < Number(o.quantity);
      });
      if (gone.length) {
        const e = new Error(`${gone.map((o) => o.livestock_title).join(", ")} ${gone.length === 1 ? "is" : "are"} no longer available, or another buyer is paying for ${gone.length === 1 ? "it" : "them"} right now. Please try again in a few minutes or contact us.`);
        e.status = 409;
        e.expose = true;
        throw e;
      }
      await conn.query(
        `UPDATE orders SET hold_until = NOW() + INTERVAL ? MINUTE
         WHERE checkout_id = ? AND stock_deducted = 0 AND payment_status <> 'paid' AND status NOT IN ('cancelled', 'completed')`,
        [HOLD_MINUTES, checkout.id],
      );
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback().catch(() => {});
    throw error;
  } finally {
    conn.release();
  }
}

// Sends the PIN prompt for whatever is still owed on the checkout.
async function startCollection(checkout, { operator, phone, fresh }) {
  if (!fresh) await holdItems(checkout);
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

// Lipila: sends the PIN prompt for whatever is still owed (a new payment
// reference for each attempt).
async function startLipila(checkout, { operator, phone, fresh }) {
  const orders = await ordersOf(checkout.id);
  const amount = due(orders);
  if (!amount) return checkout;
  if (!fresh) await holdItems(checkout);
  const attempt = Number(checkout.payment_attempts || 0) + 1;
  const reference = paymentReference(checkout.id, attempt);
  await pool.query(
    `UPDATE checkouts SET payment_provider = 'lipila', payment_method = 'mobile_money', payment_status = 'pending',
       payment_reference = ?, payment_provider_ref = NULL, payment_url = NULL, payment_failure = NULL, total = ?,
       payment_attempts = ?, payment_checked_at = NOW(), payment_started_at = NOW(), payment_alert_at = NULL, payment_check_error = NULL,
       mobile_operator = ?, payment_phone = ?
     WHERE id = ? AND payment_status <> 'paid'`,
    [reference, amount, attempt, operator, phone, checkout.id],
  );
  const current = await load(checkout.id);
  await syncOrders(current);
  const site = appUrl("/");
  try {
    const items = orders.filter((o) => isOpen(o) && o.payment_status !== "paid");
    const res = await lipila.collect({
      reference,
      amount,
      phone,
      email: checkout.email,
      narration: `Frontier Marketplace ${checkoutRef(checkout.id)}: ${items.map((o) => o.livestock_title).join(", ")}`,
      // Lipila only calls a public https address.
      callbackUrl: /^https:\/\//.test(site) ? appUrl("/api/payments/lipila/callback") : undefined,
    });
    if (res.identifier) await pool.query("UPDATE checkouts SET payment_provider_ref = ? WHERE id = ?", [res.identifier, checkout.id]);
    txlog.record({
      checkoutId: checkout.id, reference, event: "payment_requested", actor: "buyer", status: res.status, amount,
      detail: `${attempt > 1 ? `Attempt ${attempt}: p` : "P"}ayment request for ${kwacha(amount)} sent to ${OPERATOR_LABELS[operator] || operator} ${lenco.localPhone(phone)}${res.identifier ? `. Lipila ID ${res.identifier}` : ""}.`,
      data: res.raw || null,
    });
    if (res.status === "failed") await markFailed(current, res.message || "The payment was not completed.", reference);
    // "Successful" straight away is confirmed with check-status, never trusted as is.
    if (res.status === "paid") await refreshLipila({ ...current, payment_checked_at: null });
  } catch (error) {
    if (error.unknownOutcome) {
      // No clear answer: the prompt may have gone out. Keep waiting and check.
      console.error(`Checkout ${checkoutRef(checkout.id)}: Lipila didn't answer clearly (${error.message}); will check the status`);
      txlog.record({ checkoutId: checkout.id, reference, event: "payment_request_unclear", status: "pending", amount, detail: `Payment request for ${kwacha(amount)} to ${OPERATOR_LABELS[operator] || operator} ${lenco.localPhone(phone)}: no clear answer from Lipila (${error.message}). Checking the status.` });
    } else {
      console.error(`Checkout ${checkoutRef(checkout.id)}: Lipila payment not started (${error.message})`);
      txlog.record({ checkoutId: checkout.id, reference, event: "payment_request_failed", status: "failed", amount, actor: "lipila", detail: `Lipila didn't accept the payment request: ${error.message}` });
      await markFailed(current, `We couldn't send the payment request: ${error.message}`, reference);
    }
  }
  return load(checkout.id);
}

// Card: opens a payment on Lipila's card page for whatever is still owed and
// returns the checkout with payment_url set to that page.
async function startCard(checkout, details = {}) {
  const orders = await ordersOf(checkout.id);
  const amount = due(orders);
  if (!amount) return checkout;
  if (!details.fresh) await holdItems(checkout);
  const attempt = Number(checkout.payment_attempts || 0) + 1;
  const reference = paymentReference(checkout.id, attempt);
  await pool.query(
    `UPDATE checkouts SET payment_provider = 'lipila', payment_method = 'card', payment_status = 'pending',
       payment_reference = ?, payment_provider_ref = NULL, payment_url = NULL, payment_failure = NULL, total = ?,
       payment_attempts = ?, payment_checked_at = NOW(), payment_started_at = NOW(), payment_alert_at = NULL, payment_check_error = NULL,
       mobile_operator = NULL, payment_phone = NULL
     WHERE id = ? AND payment_status <> 'paid'`,
    [reference, amount, attempt, checkout.id],
  );
  const current = await load(checkout.id);
  await syncOrders(current);
  const site = appUrl("/");
  try {
    const items = orders.filter((o) => isOpen(o) && o.payment_status !== "paid");
    const made = await lipila.collectCard({
      reference,
      amount,
      phone: checkout.phone,
      email: checkout.email,
      narration: `Frontier Marketplace ${checkoutRef(checkout.id)}: ${items.map((o) => o.livestock_title).join(", ")}`,
      customer: { name: checkout.full_name, address: details.address, city: details.city },
      backUrl: appUrl(`/pay/return/${checkout.id}/${checkout.public_token}`),
      callbackUrl: /^https:\/\//.test(site) ? appUrl("/api/payments/lipila/callback") : undefined,
    });
    await pool.query("UPDATE checkouts SET payment_url = ?, payment_provider_ref = ? WHERE id = ?", [made.url, made.identifier, checkout.id]);
    txlog.record({
      checkoutId: checkout.id, reference, event: "card_page_opened", actor: "buyer", status: "pending", amount,
      detail: `${attempt > 1 ? `Attempt ${attempt}: c` : "C"}ard payment page for ${kwacha(amount)} opened on Lipila${made.identifier ? `. Lipila ID ${made.identifier}` : ""}.`,
    });
  } catch (error) {
    console.error(`Checkout ${checkoutRef(checkout.id)}: card payment not started (${error.message})`);
    txlog.record({ checkoutId: checkout.id, reference, event: "payment_request_failed", status: "failed", amount, actor: "lipila", detail: `Lipila didn't open the card page: ${error.message}` });
    await markFailed(current, `We couldn't open the card payment page: ${error.message}`, reference);
  }
  return load(checkout.id);
}

// Sends the PIN prompt with whichever provider is on.
function startPayment(checkout, pay) {
  if (provider() === "lipila") return startLipila(checkout, pay);
  return startCollection(checkout, pay);
}

// Status-check errors are logged at most every 15 minutes per payment, with
// Lipila's full answer, so the log shows what went wrong without flooding.
const lastLogged = new Map();
function logCheckError(checkout, error) {
  const key = checkout.payment_reference;
  const now = Date.now();
  if (now - (lastLogged.get(key) || 0) < 15 * 60 * 1000) return;
  lastLogged.set(key, now);
  console.error(`Checkout ${checkoutRef(checkout.id)}: Lipila status check failed for ${key} (${error.message})${error.raw ? `. Lipila answered: ${error.raw}` : ""}`);
}

// Asks Lipila whether the open payment has been paid. Only Lipila's own
// answer changes the order: Successful -> paid, Failed -> not completed.
// Anything else (still pending, or errors) keeps it waiting.
async function refreshLipila(checkout) {
  await pool.query("UPDATE checkouts SET payment_checked_at = NOW() WHERE id = ?", [checkout.id]);
  try {
    const v = await lipila.checkStatus(checkout.payment_reference, checkout.payment_provider_ref);
    await pool.query("UPDATE checkouts SET payment_check_error = NULL WHERE id = ?", [checkout.id]);
    if (v.status === "paid") {
      if (v.currency && String(v.currency).toUpperCase() !== "ZMW") {
        await markFailed(checkout, "The payment was made in the wrong currency. Our team will contact you.", checkout.payment_reference);
      } else {
        await applyCollection(checkout, {
          status: "successful",
          amount: v.amount ?? checkout.total,
          reference: checkout.payment_reference,
          providerRef: v.externalId || v.identifier || checkout.payment_provider_ref,
          raw: v.raw,
        });
      }
    } else if (v.status === "failed") {
      await markFailed(checkout, v.message || "The payment was not approved.", checkout.payment_reference);
    }
  } catch (error) {
    const [first] = await pool.query(
      "UPDATE checkouts SET payment_check_error = ? WHERE id = ? AND payment_check_error IS NULL",
      [String(error.message).slice(0, 255), checkout.id],
    );
    if (first.affectedRows) {
      txlog.record({ checkoutId: checkout.id, reference: checkout.payment_reference, event: "status_check_error", status: "pending", detail: `Lipila's status check failed: ${error.message}. The website keeps checking.`, data: error.raw || null });
    }
    await pool.query("UPDATE checkouts SET payment_check_error = ? WHERE id = ?", [String(error.message).slice(0, 255), checkout.id]);
    logCheckError(checkout, error);
  }
  const fresh = await load(checkout.id);
  if (fresh && fresh.payment_status === "pending") await alertIfUnconfirmed(fresh);
  return load(checkout.id);
}

// No clear answer after ALERT_AFTER_MIN minutes: tell the team (check the
// Lipila dashboard). Sent once per attempt. The buyer's page says the payment
// is being confirmed and not to pay twice.
// Mobile money prompts expire within minutes, so a long "pending" is unusual;
// a card page left open is normal, so cards only count when checks fail.
async function alertIfUnconfirmed(checkout) {
  if (checkout.payment_alert_at) return;
  if (checkout.payment_method === "card" && !checkout.payment_check_error) return;
  const [[age]] = await pool.query(
    "SELECT TIMESTAMPDIFF(MINUTE, COALESCE(payment_started_at, created_at), NOW()) AS m FROM checkouts WHERE id = ?",
    [checkout.id],
  );
  if (Number(age.m) < ALERT_AFTER_MIN) return;
  const [claim] = await pool.query(
    "UPDATE checkouts SET payment_alert_at = NOW() WHERE id = ? AND payment_alert_at IS NULL AND payment_status = 'pending'",
    [checkout.id],
  );
  if (!claim.affectedRows) return;
  console.error(`Checkout ${checkoutRef(checkout.id)}: payment ${checkout.payment_reference} not confirmed after ${ALERT_AFTER_MIN} minutes; team alerted`);
  txlog.record({ checkoutId: checkout.id, reference: checkout.payment_reference, event: "unconfirmed_alert", status: "pending", detail: `No confirmation from Lipila after ${ALERT_AFTER_MIN} minutes. Team emailed to check the Lipila dashboard.` });
  const orders = await ordersOf(checkout.id);
  const ref = checkoutRef(checkout.id);
  const amount = kwacha(due(orders));
  const how = checkout.payment_method === "card" ? "Visa / Mastercard" : `${OPERATOR_LABELS[checkout.mobile_operator] || "Mobile money"} (${lenco.localPhone(checkout.payment_phone)})`;
  const items = orders.filter(isOpen).map((o) => [`${orderRef(o.id)} · ${o.livestock_title}`, kwacha(o.total)]);
  sendEmail({
    to: recipients(),
    subject: `Check payment ${checkout.payment_reference}: not confirmed after ${ALERT_AFTER_MIN} minutes`,
    heading: `Payment for order ${ref} not confirmed`,
    paragraphs: [
      `${checkout.full_name}'s payment of ${amount} by ${how} hasn't been confirmed by Lipila after ${ALERT_AFTER_MIN} minutes${checkout.payment_check_error ? ` (Lipila's status check answers: ${checkout.payment_check_error})` : ""}.`,
      `Look up ${checkout.payment_reference} in the Lipila dashboard. If it was paid there, open the order and press "Check payment with Lipila", or mark the orders Paid; the buyer and seller are then emailed. The website keeps checking in the meantime.`,
    ],
    rows: [...items, ["Amount", amount], ["Payment reference", checkout.payment_reference], ["Buyer", checkout.full_name], ["WhatsApp", checkout.phone], ["Email", checkout.email]],
    button: orders[0] ? { label: "Open order", url: appUrl(`/admin/orders.html?id=${orders[0].id}`) } : undefined,
    replyTo: checkout.email,
  });
}

// Asks the provider for news on a pending payment (at most every few seconds).
async function refresh(checkout) {
  if (checkout.payment_status !== "pending" || !checkout.payment_reference) return checkout;
  if (checkout.payment_provider === "lipila") {
    if (!lipila.enabled()) return checkout;
    const last = checkout.payment_checked_at ? new Date(checkout.payment_checked_at).getTime() : 0;
    if (Date.now() - last < CHECK_EVERY_MS) return checkout;
    return refreshLipila(checkout);
  }
  if (!lenco.enabled()) return checkout;
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
  const tried = checkout.payment_status === "failed";
  return Promise.all([
    sendEmail({
      to: recipients(),
      subject: `Unpaid order ${ref}: ${amount}`,
      heading: `Order ${ref} is unpaid`,
      paragraphs: [`${checkout.full_name} hasn't completed the payment for order ${ref}${checkout.payment_failure ? ` (${checkout.payment_failure})` : ""}. You may want to follow up.`],
      rows: [...items, ["Amount", amount], ["WhatsApp", checkout.phone], ["Attempts", String(checkout.payment_attempts || 0)]],
      button: orders[0] ? { label: "Open orders", url: appUrl(`/admin/orders.html?id=${orders[0].id}`) } : undefined,
    }),
  ]);
}

// Payments can finish while the buyer is away from our site (closed the tab
// before approving), so open Lipila payments are checked in the background:
// every minute for the first half hour, then every 10 minutes for 3 days.
// Asks Lipila about pending payments not checked in the last `everySeconds`.
async function checkOpenPayments(everySeconds = 60) {
  if (!lipila.enabled()) return;
  const [rows] = await pool.query(
    `SELECT * FROM checkouts
     WHERE payment_provider = 'lipila' AND payment_status = 'pending' AND payment_reference IS NOT NULL
       AND created_at > NOW() - INTERVAL 3 DAY
       AND (payment_checked_at IS NULL OR payment_checked_at < NOW() - INTERVAL
         IF(COALESCE(payment_started_at, created_at) > NOW() - INTERVAL ? MINUTE, ?, 600) SECOND)
     ORDER BY payment_checked_at IS NOT NULL, payment_checked_at LIMIT 20`,
    [ALERT_AFTER_MIN, Math.max(5, Number(everySeconds) || 60)],
  );
  for (const c of rows) await refreshLipila(c);
}

async function sendReminders(afterMinutes) {
  if (!provider()) return;
  const [rows] = await pool.query(
    `SELECT * FROM checkouts
     WHERE payment_status = 'unpaid' AND payment_reminder_at IS NULL
       AND payment_method <> 'bank_transfer'
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
  provider,
  operators,
  methods,
  startPayment,
  startCard,
  checkOpenPayments,
  refreshLipila,
  holdsStock,
  HOLD_MINUTES,
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
