const express = require("express");
const pool = require("../db");
const { isAuthenticated, isBuyer } = require("../middleware/auth");

const router = express.Router();

// GET /api/inquiries - Get inquiries for authenticated user
router.get("/", isAuthenticated, async (req, res) => {
  try {
    const userId = req.session.userId;
    const userRole = req.session.userRole;

    let query = `SELECT i.*, l.title as listing_title, u.name as sender_name
                 FROM inquiries i
                 JOIN listings l ON i.listing_id = l.id
                 LEFT JOIN users u ON i.buyer_id = u.id
                 WHERE 1=1`;
    const params = [];

    // If seller, show inquiries about their listings
    // If buyer, show inquiries they sent
    if (userRole === "seller") {
      query += " AND i.seller_id = ?";
      params.push(userId);
    } else if (userRole === "buyer") {
      query += " AND i.buyer_id = ?";
      params.push(userId);
    }

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
router.post("/", isAuthenticated, isBuyer, async (req, res) => {
  try {
    const { listing_id, message } = req.body;
    const buyer_id = req.session.userId;

    if (!listing_id || typeof message !== "string" || !message.trim() || message.trim().length > 5000) {
      return res.status(400).json({
        success: false,
        message: "A listing and a message of up to 5,000 characters are required",
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
      return res.status(400).json({ success: false, message: "You cannot inquire about your own listing" });
    }

    const [result] = await pool.query(
      'INSERT INTO inquiries (listing_id, buyer_id, seller_id, message, status) VALUES (?, ?, ?, ?, "pending")',
      [listing_id, buyer_id, seller_id, message.trim()],
    );

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
      "SELECT seller_id FROM inquiries WHERE id = ?",
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
