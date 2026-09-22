const express = require("express");
const pool = require("../db");
const { isAuthenticated, isAdmin } = require("../middleware/auth");

const router = express.Router();
const pageValues = (query) => {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, Number.parseInt(query.limit, 10) || 20));
  return { page, limit, offset: (page - 1) * limit };
};

// All admin routes require authentication and admin role
router.use(isAuthenticated, isAdmin);

// GET /api/admin/stats - Get dashboard statistics
router.get("/stats", async (req, res) => {
  try {
    const [totalUsers] = await pool.query(
      'SELECT COUNT(*) as count FROM users WHERE role != "admin"',
    );
    const [totalMembers] = await pool.query(
      'SELECT COUNT(*) as count FROM users WHERE role = "member"',
    );
    const [totalServiceProviders] = await pool.query(
      'SELECT COUNT(*) as count FROM users WHERE role = "service_provider"',
    );

    const [totalListings] = await pool.query(
      "SELECT COUNT(*) as count FROM listings",
    );
    const [pendingListings] = await pool.query(
      'SELECT COUNT(*) as count FROM listings WHERE status = "pending"',
    );
    const [activeListings] = await pool.query(
      'SELECT COUNT(*) as count FROM listings WHERE status IN ("active", "approved")',
    );

    const [reportedContent] = await pool.query(
      'SELECT COUNT(*) as count FROM reports WHERE status = "pending"',
    );

    return res.json({
      success: true,
      data: {
        users: totalUsers[0].count,
        members: totalMembers[0].count,
        service_providers: totalServiceProviders[0].count,
        total_listings: totalListings[0].count,
        pending_listings: pendingListings[0].count,
        active_listings: activeListings[0].count,
        pending_reports: reportedContent[0].count,
      },
    });
  } catch (error) {
    console.error("Get admin stats error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to retrieve statistics",
    });
  }
});

// GET /api/admin/users - Get all users
router.get("/users", async (req, res) => {
  try {
    const { role, status, search } = req.query;
    const { page, limit, offset } = pageValues(req.query);

    let query =
      "SELECT id, name, email, phone, role, location, status, created_at FROM users WHERE 1=1";
    const params = [];

    if (role) {
      query += " AND role = ?";
      params.push(role);
    }
    if (status) {
      query += " AND status = ?";
      params.push(status);
    }
    if (search) {
      query += " AND (name LIKE ? OR email LIKE ? OR phone LIKE ?)";
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    query += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    params.push(parseInt(limit), offset);

    const [users] = await pool.query(query, params);
    const countQuery = query.replace(/SELECT id, name, email, phone, role, location, status, created_at/, "SELECT COUNT(*) AS total").replace(/ ORDER BY created_at DESC LIMIT \? OFFSET \?$/, "");
    const [counts] = await pool.query(countQuery, params.slice(0, -2));

    return res.json({
      success: true,
      data: users,
      pagination: { current: page, total: Math.ceil(counts[0].total / limit), perPage: limit, totalItems: counts[0].total },
    });
  } catch (error) {
    console.error("Get users error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to retrieve users",
    });
  }
});

// PATCH /api/admin/users/:id/status - Update user status
router.patch("/users/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = ["active", "suspended"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid status",
      });
    }

    const [result] = await pool.query(
      'UPDATE users SET status = ? WHERE id = ? AND role != "admin"',
      [status, id],
    );
    if (!result.affectedRows) return res.status(404).json({ success: false, message: "User not found or cannot be modified" });

    return res.json({
      success: true,
      message: `User status updated to ${status}`,
    });
  } catch (error) {
    console.error("Update user status error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update user status",
    });
  }
});

// GET /api/admin/users/:id - administrator-only account detail
router.get("/users/:id", async (req, res) => {
  try {
    const [users] = await pool.query(
      "SELECT id, name, email, phone, role, location, profile_image, status, created_at, updated_at FROM users WHERE id = ?",
      [req.params.id],
    );
    if (!users.length) return res.status(404).json({ success: false, message: "User not found" });
    return res.json({ success: true, data: users[0] });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to retrieve user" });
  }
});

// GET /api/admin/listings - Get all listings for review
router.get("/listings", async (req, res) => {
  try {
    const { status } = req.query;
    const { page, limit, offset } = pageValues(req.query);

    let query =
      "SELECT l.id, l.title, l.species, l.price, l.status, l.created_at, u.name as seller_name FROM listings l JOIN users u ON l.seller_id = u.id WHERE 1=1";
    const params = [];

    if (status) {
      query += " AND l.status = ?";
      params.push(status);
    }

    query += ` ORDER BY l.created_at DESC LIMIT ? OFFSET ?`;
    params.push(parseInt(limit), offset);

    const [listings] = await pool.query(query, params);
    const countQuery = query.replace(/SELECT l.id, l.title, l.species, l.price, l.status, l.created_at, u.name as seller_name/, "SELECT COUNT(*) AS total").replace(/ ORDER BY l.created_at DESC LIMIT \? OFFSET \?$/, "");
    const [counts] = await pool.query(countQuery, params.slice(0, -2));

    return res.json({
      success: true,
      data: listings,
      pagination: { current: page, total: Math.ceil(counts[0].total / limit), perPage: limit, totalItems: counts[0].total },
    });
  } catch (error) {
    console.error("Get listings error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to retrieve listings",
    });
  }
});

// GET /api/admin/listings/:id - Get listing details
router.get("/listings/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const [listings] = await pool.query(
      `SELECT l.*, u.name as seller_name, u.email as seller_email FROM listings l 
       JOIN users u ON l.seller_id = u.id 
       WHERE l.id = ?`,
      [id],
    );

    if (listings.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Listing not found",
      });
    }

    const listing = listings[0];

    // Get media
    const [media] = await pool.query(
      "SELECT id, file_path FROM listing_media WHERE listing_id = ?",
      [id],
    );

    listing.media = media;

    return res.json({
      success: true,
      data: listing,
    });
  } catch (error) {
    console.error("Get listing error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to retrieve listing",
    });
  }
});

// PATCH /api/admin/listings/:id/status - moderation control: activate or
// deactivate a listing (e.g. in response to a report). Listings go live
// directly when sellers create them, so there is no approval queue here.
router.patch("/listings/:id/status", async (req, res) => {
  try {
    const { status } = req.body;
    if (!["active", "deactivated"].includes(status)) return res.status(400).json({ success: false, message: "Invalid listing status" });
    const [result] = await pool.query("UPDATE listings SET status = ? WHERE id = ?", [status, req.params.id]);
    if (!result.affectedRows) return res.status(404).json({ success: false, message: "Listing not found" });
    return res.json({ success: true, message: "Listing status updated" });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to update listing status" });
  }
});

// GET /api/admin/reports - Get all reports
router.get("/reports", async (req, res) => {
  try {
    const { status } = req.query;
    const { page, limit, offset } = pageValues(req.query);

    let query = `SELECT r.id, r.reason, r.status, r.created_at,
                 u.name as reporter_name,
                 ru.name as reported_user_name,
                 l.title as listing_title
                 FROM reports r
                 LEFT JOIN users u ON r.reporter_id = u.id
                 LEFT JOIN users ru ON r.reported_user_id = ru.id
                 LEFT JOIN listings l ON r.listing_id = l.id
                 WHERE 1=1`;
    const params = [];

    if (status) {
      query += " AND r.status = ?";
      params.push(status);
    }

    query += ` ORDER BY r.created_at DESC LIMIT ? OFFSET ?`;
    params.push(parseInt(limit), offset);

    const [reports] = await pool.query(query, params);
    const countQuery = query.replace(/SELECT r.id, r.reason, r.status, r.created_at,\s*\n\s*u.name as reporter_name,\s*\n\s*ru.name as reported_user_name,\s*\n\s*l.title as listing_title/, "SELECT COUNT(*) AS total").replace(/ ORDER BY r.created_at DESC LIMIT \? OFFSET \?$/, "");
    const [counts] = await pool.query(countQuery, params.slice(0, -2));

    return res.json({
      success: true,
      data: reports,
      pagination: { current: page, total: Math.ceil(counts[0].total / limit), perPage: limit, totalItems: counts[0].total },
    });
  } catch (error) {
    console.error("Get reports error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to retrieve reports",
    });
  }
});

// PATCH /api/admin/reports/:id - Update report status
router.patch("/reports/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = ["pending", "reviewed", "resolved"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid status",
      });
    }

    await pool.query("UPDATE reports SET status = ? WHERE id = ?", [
      status,
      id,
    ]);

    return res.json({
      success: true,
      message: `Report status updated to ${status}`,
    });
  } catch (error) {
    console.error("Update report error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update report",
    });
  }
});

module.exports = router;
