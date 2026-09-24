const express = require("express");
const pool = require("../db");
const { isAuthenticated, isMember } = require("../middleware/auth");

const router = express.Router();

// GET /api/inquiries - Get inquiries for authenticated user
router.get("/", isAuthenticated, async (req, res) => {
  try {
    const userId = req.session.userId;

    // A member can both send inquiries (as the buyer) and receive them (as
    // the seller of the listing) from the same account, so show both sides
    // rather than branching on role.
    let query = `SELECT i.*, l.title as listing_title, u.name as sender_name
                 FROM inquiries i
                 JOIN listings l ON i.listing_id = l.id
                 LEFT JOIN users u ON i.buyer_id = u.id
                 WHERE (i.buyer_id = ? OR i.seller_id = ?)`;
    const params = [userId, userId];

    query += " ORDER BY i.created_at DESC";

    const [inquiries] = await pool.query(query, params);

    return res.json({
      success: true,
      data: inquiries,
    });
  } catch (error) {
    console.error("Get inquiries error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to retrieve inquiries",
    });
  }
});

// GET /api/inquiries/:id - Get single inquiry
router.get("/:id", isAuthenticated, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.session.userId;

    const [inquiries] = await pool.query(
      `SELECT i.*, l.title as listing_title, b.name as buyer_name, s.name as seller_name
       FROM inquiries i
       JOIN listings l ON i.listing_id = l.id
       JOIN users b ON i.buyer_id = b.id
       JOIN users s ON i.seller_id = s.id
       WHERE i.id = ? AND (i.buyer_id = ? OR i.seller_id = ?)`,
      [id, userId, userId],
    );

    if (inquiries.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Inquiry not found",
      });
    }

    return res.json({
      success: true,
      data: inquiries[0],
    });
  } catch (error) {
    console.error("Get inquiry error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to retrieve inquiry",
    });
  }
});

// POST /api/inquiries - Create inquiry
router.post("/", isAuthenticated, isMember, async (req, res) => {
  try {
    const { listing_id, message } = req.body;
    const buyer_id = req.session.userId;

    if (
      !listing_id ||
      typeof message !== "string" ||
      !message.trim() ||
      message.trim().length > 5000
    ) {
      return res.status(400).json({
        success: false,
        message:
          "A listing and a message of up to 5,000 characters are required",
      });
    }

    // Get listing and seller info
    const [listings] = await pool.query(
      "SELECT seller_id FROM listings WHERE id = ? AND status = 'active'",
      [listing_id],
    );

    if (listings.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Listing not found",
      });
    }

    const seller_id = listings[0].seller_id;
    if (seller_id === buyer_id) {
      return res
        .status(400)
        .json({
          success: false,
          message: "You cannot inquire about your own listing",
        });
    }

    const [result] = await pool.query(
      'INSERT INTO inquiries (listing_id, buyer_id, seller_id, message, status) VALUES (?, ?, ?, ?, "pending")',
      [listing_id, buyer_id, seller_id, message.trim()],
    );

    // Notify the seller's open sockets so their unread badge updates without
    // waiting for a poll. Fired after the insert so the eventual refetch
    // sees the new row.
    const io = req.app.get("io");
    if (io) {
      const [buyers] = await pool.query("SELECT name FROM users WHERE id = ?", [
        buyer_id,
      ]);
      io.to("user:" + seller_id).emit("new_inquiry", {
        id: result.insertId,
        listing_id,
        buyer_id,
        buyer_name: buyers[0]?.name || "Someone",
        created_at: new Date().toISOString(),
      });
    }

    return res.status(201).json({
      success: true,
      message: "Inquiry sent successfully",
      data: {
        id: result.insertId,
      },
    });
  } catch (error) {
    console.error("Create inquiry error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to create inquiry",
    });
  }
});

// PATCH /api/inquiries/:id - Update inquiry status
router.patch("/:id", isAuthenticated, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const userId = req.session.userId;

    const validStatuses = ["pending", "responded", "closed"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid status",
      });
    }

    // Verify ownership (seller can update)
    const [inquiries] = await pool.query(
      "SELECT seller_id, buyer_id FROM inquiries WHERE id = ?",
      [id],
    );

    if (inquiries.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Inquiry not found",
      });
    }

    if (inquiries[0].seller_id !== userId) {
      return res.status(403).json({
        success: false,
        message: "You do not have permission to update this inquiry",
      });
    }

    await pool.query("UPDATE inquiries SET status = ? WHERE id = ?", [
      status,
      id,
    ]);

    // Tell both parties so their badge counts refresh. The seller's badge
    // was pinned on this inquiry until the status moved off pending; the
    // buyer's UI also shows the current status.
    const io = req.app.get("io");
    if (io) {
      const payload = { id: Number(id), status };
      io.to("user:" + inquiries[0].seller_id).emit("inquiry_updated", payload);
      io.to("user:" + inquiries[0].buyer_id).emit("inquiry_updated", payload);
    }

    return res.json({
      success: true,
      message: `Inquiry status updated to ${status}`,
    });
  } catch (error) {
    console.error("Update inquiry error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update inquiry",
    });
  }
});

module.exports = router;
