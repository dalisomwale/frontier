const express = require("express");
const pool = require("../db");
const { isAuthenticated, isBuyer } = require("../middleware/auth");

const router = express.Router();

// GET /api/favorites - Get user's favorite listings
router.get("/", isAuthenticated, isBuyer, async (req, res) => {
  try {
    const userId = req.session.userId;
    const { page = 1, limit = 12 } = req.query;
    const offset = (page - 1) * limit;

    const [favorites] = await pool.query(
      `SELECT l.*, u.name as seller_name, f.id as favorite_id
       FROM favorites f
       JOIN listings l ON f.listing_id = l.id
       JOIN users u ON l.seller_id = u.id
       WHERE f.user_id = ? AND l.status IN ('active', 'approved')
       ORDER BY f.created_at DESC
       LIMIT ? OFFSET ?`,
      [userId, parseInt(limit), offset],
    );

    const [countResult] = await pool.query(
      "SELECT COUNT(*) as total FROM favorites WHERE user_id = ?",
      [userId],
    );

    const total = countResult[0].total;
    const totalPages = Math.ceil(total / limit);

    return res.json({
      success: true,
      data: favorites,
      pagination: {
        current: parseInt(page),
        total: totalPages,
        perPage: parseInt(limit),
        totalItems: total,
      },
    });
  } catch (error) {
    console.error("Get favorites error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to retrieve favorites",
    });
  }
});

// POST /api/favorites/:listingId - Add to favorites
router.post("/:listingId", isAuthenticated, isBuyer, async (req, res) => {
  try {
    const { listingId } = req.params;
    const userId = req.session.userId;

    // Verify listing exists
    const [listings] = await pool.query(
      "SELECT id FROM listings WHERE id = ? AND status = 'active'",
      [listingId],
    );

    if (listings.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Listing not found",
      });
    }

    // Check if already favorited
    const [existing] = await pool.query(
      "SELECT id FROM favorites WHERE user_id = ? AND listing_id = ?",
      [userId, listingId],
    );

    if (existing.length > 0) {
      return res.status(409).json({
        success: false,
        message: "Already favorited",
      });
    }

    const [result] = await pool.query(
      "INSERT INTO favorites (user_id, listing_id) VALUES (?, ?)",
      [userId, listingId],
    );

    return res.status(201).json({
      success: true,
      message: "Added to favorites",
      data: {
        id: result.insertId,
      },
    });
  } catch (error) {
    console.error("Add favorite error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to add favorite",
    });
  }
});

// DELETE /api/favorites/:listingId - Remove from favorites
router.delete("/:listingId", isAuthenticated, isBuyer, async (req, res) => {
  try {
    const { listingId } = req.params;
    const userId = req.session.userId;

    const result = await pool.query(
      "DELETE FROM favorites WHERE user_id = ? AND listing_id = ?",
      [userId, listingId],
    );

    return res.json({
      success: true,
      message: "Removed from favorites",
    });
  } catch (error) {
    console.error("Remove favorite error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to remove favorite",
    });
  }
});

// GET /api/favorites/check/:listingId - Check if listing is favorited
router.get("/check/:listingId", isAuthenticated, isBuyer, async (req, res) => {
  try {
    const { listingId } = req.params;
    const userId = req.session.userId;

    const [favorites] = await pool.query(
      "SELECT id FROM favorites WHERE user_id = ? AND listing_id = ?",
      [userId, listingId],
    );

    return res.json({
      success: true,
      isFavorited: favorites.length > 0,
    });
  } catch (error) {
    console.error("Check favorite error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to check favorite",
    });
  }
});

module.exports = router;
