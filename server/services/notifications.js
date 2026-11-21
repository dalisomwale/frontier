// In-app notifications for sellers. Each one is stored, then pushed straight
// to any dashboard the seller has open (Server-Sent Events), so it appears
// without a refresh. Emails are sent separately by the routes.
const pool = require("../db");

const streams = new Map(); // sellerId -> Set of open responses

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function unreadCount(sellerId) {
  const [[{ unread }]] = await pool.query(
    "SELECT COUNT(*) AS unread FROM seller_notifications WHERE seller_id = ? AND read_at IS NULL",
    [sellerId],
  );
  return Number(unread);
}

// Never throws: a notice must not break the action that triggered it.
async function notifySeller(sellerId, { type, title, body = null, link = null }) {
  if (!sellerId) return null;
  try {
    const [[seller]] = await pool.query("SELECT password_hash IS NOT NULL AS has_account FROM sellers WHERE id = ?", [sellerId]);
    if (!seller || !seller.has_account) return null;
    const [result] = await pool.query(
      "INSERT INTO seller_notifications (seller_id, type, title, body, link) VALUES (?, ?, ?, ?, ?)",
      [sellerId, type, String(title).slice(0, 200), body ? String(body).slice(0, 1000) : null, link],
    );
    const [[row]] = await pool.query("SELECT * FROM seller_notifications WHERE id = ?", [result.insertId]);
    const open = streams.get(Number(sellerId));
    if (open && open.size) {
      const unread = await unreadCount(sellerId);
      open.forEach((res) => send(res, "notification", { notification: row, unread }));
    }
    return row;
  } catch (error) {
    console.error("Seller notification failed:", error.message);
    return null;
  }
}

function subscribe(sellerId, req, res) {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  res.write("retry: 5000\n\n");
  const id = Number(sellerId);
  if (!streams.has(id)) streams.set(id, new Set());
  streams.get(id).add(res);
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 25000);
  const cleanup = () => {
    clearInterval(heartbeat);
    streams.get(id)?.delete(res);
    if (streams.get(id)?.size === 0) streams.delete(id);
  };
  req.on("close", cleanup);
  unreadCount(id).then((unread) => send(res, "ready", { unread })).catch(() => {});
}

// Closes a seller's open dashboards, e.g. when the account is deactivated.
function disconnectSeller(sellerId) {
  const open = streams.get(Number(sellerId));
  if (!open) return;
  open.forEach((res) => {
    send(res, "signed-out", {});
    res.end();
  });
  streams.delete(Number(sellerId));
}

// ---------------------------------------------------------------------------
// Buyers: the same, for the buyer account pages.
// ---------------------------------------------------------------------------
const buyerStreams = new Map(); // buyerId -> Set of open responses

async function buyerUnreadCount(buyerId) {
  const [[{ unread }]] = await pool.query(
    "SELECT COUNT(*) AS unread FROM buyer_notifications WHERE buyer_id = ? AND read_at IS NULL",
    [buyerId],
  );
  return Number(unread);
}

// Never throws. `event` is also sent on its own (e.g. "order") so an open
// order page can refresh itself.
async function notifyBuyer(buyerId, { type, title, body = null, link = null }) {
  if (!buyerId) return null;
  try {
    const [result] = await pool.query(
      "INSERT INTO buyer_notifications (buyer_id, type, title, body, link) VALUES (?, ?, ?, ?, ?)",
      [buyerId, type, String(title).slice(0, 200), body ? String(body).slice(0, 1000) : null, link],
    );
    const [[row]] = await pool.query("SELECT * FROM buyer_notifications WHERE id = ?", [result.insertId]);
    const open = buyerStreams.get(Number(buyerId));
    if (open && open.size) {
      const unread = await buyerUnreadCount(buyerId);
      open.forEach((res) => send(res, "notification", { notification: row, unread }));
    }
    return row;
  } catch (error) {
    console.error("Buyer notification failed:", error.message);
    return null;
  }
}

// A change the buyer's open pages should show (no stored notification).
function pingBuyer(buyerId, event, data = {}) {
  const open = buyerStreams.get(Number(buyerId));
  if (open) open.forEach((res) => send(res, event, data));
}

function stream(res, req, map, id, onReady) {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  res.write("retry: 5000\n\n");
  if (!map.has(id)) map.set(id, new Set());
  map.get(id).add(res);
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 25000);
  req.on("close", () => {
    clearInterval(heartbeat);
    map.get(id)?.delete(res);
    if (map.get(id)?.size === 0) map.delete(id);
  });
  if (onReady) onReady();
}

function subscribeBuyer(buyerId, req, res) {
  const id = Number(buyerId);
  stream(res, req, buyerStreams, id, () => buyerUnreadCount(id).then((unread) => send(res, "ready", { unread })).catch(() => {}));
}

// ---------------------------------------------------------------------------
// Admins: every open admin page hears about changes to orders, payments and
// inquiries, and refreshes what it shows (no stored notifications).
// ---------------------------------------------------------------------------
const adminStreams = new Map(); // adminId -> Set

function subscribeAdmin(adminId, req, res) {
  stream(res, req, adminStreams, Number(adminId), () => send(res, "ready", {}));
}

// Never throws. kind: "order", "payment", "inquiry", ...
function broadcastAdmin(kind, data = {}) {
  try {
    adminStreams.forEach((set) => set.forEach((res) => send(res, "change", { kind, ...data, at: Date.now() })));
  } catch (error) {
    console.error("Admin live update failed:", error.message);
  }
}

// A live update for a seller's open dashboards (no stored notification),
// e.g. a delivery's new position.
function pingSeller(sellerId, event, data = {}) {
  const open = streams.get(Number(sellerId));
  if (open) open.forEach((res) => send(res, event, data));
}

// Admins: a named live event (e.g. "transport" for delivery positions) that
// does not count as a change to refresh lists for.
function pingAdmins(event, data = {}) {
  try {
    adminStreams.forEach((set) => set.forEach((res) => send(res, event, data)));
  } catch (error) {
    console.error("Admin live update failed:", error.message);
  }
}

// ---------------------------------------------------------------------------
// Transport providers: stored notifications and live updates for their
// dashboard, like sellers.
// ---------------------------------------------------------------------------
const providerStreams = new Map(); // providerId -> Set

async function providerUnreadCount(providerId) {
  const [[{ unread }]] = await pool.query(
    "SELECT COUNT(*) AS unread FROM transport_provider_notifications WHERE provider_id = ? AND read_at IS NULL",
    [providerId],
  );
  return Number(unread);
}

// Never throws.
async function notifyProvider(providerId, { type, title, body = null, link = null }) {
  if (!providerId) return null;
  try {
    const [result] = await pool.query(
      "INSERT INTO transport_provider_notifications (provider_id, type, title, body, link) VALUES (?, ?, ?, ?, ?)",
      [providerId, type, String(title).slice(0, 200), body ? String(body).slice(0, 1000) : null, link],
    );
    const [[row]] = await pool.query("SELECT * FROM transport_provider_notifications WHERE id = ?", [result.insertId]);
    const open = providerStreams.get(Number(providerId));
    if (open && open.size) {
      const unread = await providerUnreadCount(providerId);
      open.forEach((res) => send(res, "notification", { notification: row, unread }));
    }
    return row;
  } catch (error) {
    console.error("Provider notification failed:", error.message);
    return null;
  }
}

function pingProvider(providerId, event, data = {}) {
  const open = providerStreams.get(Number(providerId));
  if (open) open.forEach((res) => send(res, event, data));
}

function subscribeProvider(providerId, req, res) {
  const id = Number(providerId);
  stream(res, req, providerStreams, id, () => providerUnreadCount(id).then((unread) => send(res, "ready", { unread })).catch(() => {}));
}

function disconnectProvider(providerId) {
  const open = providerStreams.get(Number(providerId));
  if (!open) return;
  open.forEach((res) => {
    send(res, "signed-out", {});
    res.end();
  });
  providerStreams.delete(Number(providerId));
}

module.exports = {
  notifySeller, subscribe, disconnectSeller, unreadCount, pingSeller,
  notifyBuyer, pingBuyer, subscribeBuyer, buyerUnreadCount,
  subscribeAdmin, broadcastAdmin, pingAdmins,
  notifyProvider, pingProvider, subscribeProvider, disconnectProvider, providerUnreadCount,
};
