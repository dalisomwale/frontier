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

module.exports = { notifySeller, subscribe, disconnectSeller, unreadCount };
