const express = require("express");
const pool = require("../db");
const { isAuthenticated } = require("../middleware/auth");

const router = express.Router();

const validId = (value) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

async function userCanReceive(userId) {
  const [users] = await pool.query("SELECT id FROM users WHERE id = ? AND status = 'active'", [userId]);
  return users.length > 0;
}

// GET /api/messages - an authenticated user's conversation list
router.get("/", isAuthenticated, async (req, res, next) => {
  try {
    const userId = req.session.userId;
    const [conversations] = await pool.query(
      "SELECT other_user_id, u.name AS user_name, u.profile_image, " +
        "(SELECT m.message FROM messages m WHERE (m.sender_id = ? AND m.receiver_id = other_user_id) OR (m.sender_id = other_user_id AND m.receiver_id = ?) ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_message, " +
        "(SELECT m.created_at FROM messages m WHERE (m.sender_id = ? AND m.receiver_id = other_user_id) OR (m.sender_id = other_user_id AND m.receiver_id = ?) ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_message_time, " +
        "(SELECT COUNT(*) FROM messages unread WHERE unread.sender_id = other_user_id AND unread.receiver_id = ? AND unread.is_read = false) AS unread_count " +
       "FROM (SELECT CASE WHEN sender_id = ? THEN receiver_id ELSE sender_id END AS other_user_id FROM messages WHERE sender_id = ? OR receiver_id = ?) people " +
       "JOIN users u ON u.id = people.other_user_id AND u.status = 'active' GROUP BY other_user_id, u.name, u.profile_image " +
       "ORDER BY last_message_time DESC",
      [userId, userId, userId, userId, userId, userId, userId, userId],
    );
    return res.json({ success: true, data: conversations });
  } catch (error) {
    return next(error);
  }
});

// GET /api/messages/:userId - history only for the currently authenticated
// user and the requested conversation participant.
router.get("/:userId", isAuthenticated, async (req, res, next) => {
  try {
    const otherUserId = validId(req.params.userId);
    if (!otherUserId || otherUserId === req.session.userId) {
      return res.status(400).json({ success: false, message: "Choose another account to view a conversation" });
    }
    if (!(await userCanReceive(otherUserId))) return res.status(404).json({ success: false, message: "User not found" });
    const [messages] = await pool.query(
      "SELECT id, sender_id, receiver_id, listing_id, message, is_read, created_at FROM messages " +
      "WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?) ORDER BY created_at ASC, id ASC",
      [req.session.userId, otherUserId, otherUserId, req.session.userId],
    );
    await pool.query(
      "UPDATE messages SET is_read = true WHERE sender_id = ? AND receiver_id = ? AND is_read = false",
      [otherUserId, req.session.userId],
    );
    return res.json({ success: true, data: messages });
  } catch (error) {
    return next(error);
  }
});

// POST /api/messages - delivery is persisted before Socket.IO notification.
router.post("/", isAuthenticated, async (req, res, next) => {
  try {
    const receiverId = validId(req.body.receiver_id ?? req.body.recipient_id);
    const listingId = req.body.listing_id ? validId(req.body.listing_id) : null;
    const message = typeof req.body.message === "string" ? req.body.message.trim() : "";
    if (!receiverId || receiverId === req.session.userId || !message || message.length > 5000) {
      return res.status(400).json({ success: false, message: "A recipient and a message of up to 5,000 characters are required" });
    }
    if (!(await userCanReceive(receiverId))) return res.status(404).json({ success: false, message: "Recipient not found" });
    if (req.body.listing_id && !listingId) return res.status(400).json({ success: false, message: "Invalid listing" });
    if (listingId) {
      const [listings] = await pool.query("SELECT id FROM listings WHERE id = ?", [listingId]);
      if (!listings.length) return res.status(404).json({ success: false, message: "Listing not found" });
    }
    const [result] = await pool.query(
      "INSERT INTO messages (sender_id, receiver_id, listing_id, message, is_read) VALUES (?, ?, ?, ?, false)",
      [req.session.userId, receiverId, listingId, message],
    );
    const delivery = {
      id: result.insertId,
      sender_id: req.session.userId,
      receiver_id: receiverId,
      listing_id: listingId,
      message,
      is_read: false,
      created_at: new Date().toISOString(),
    };
    req.app.get("io")?.to("user:" + receiverId).emit("receive_message", delivery);
    return res.status(201).json({ success: true, message: "Message sent successfully", data: delivery });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
