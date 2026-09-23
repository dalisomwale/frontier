const express = require("express");
const fs = require("fs");
const path = require("path");
const pool = require("../db");
const { isAuthenticated, isMember, isAdmin } = require("../middleware/auth");
const { uploadDocument } = require("../middleware/upload");

const router = express.Router();

const DOCUMENT_TYPES = ["permit", "certificate", "health_record", "other"];
const MAX_TITLE_LENGTH = 255;

const positiveId = (value) => {
  const id = Number.parseInt(value, 10);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

function safeUnlink(filePath) {
  if (!filePath) return;
  const absolute = path.resolve("public", `.${filePath}`);
  const allowed = path.resolve("public/uploads/documents") + path.sep;
  if (absolute.startsWith(allowed)) fs.unlink(absolute, () => {});
}

async function ownedListing(req, res, next) {
  try {
    const listingId = positiveId(req.params.listingId);
    if (!listingId)
      return res
        .status(404)
        .json({ success: false, message: "Listing not found" });
    const [rows] = await pool.query(
      "SELECT id, seller_id FROM listings WHERE id = ? AND seller_id = ?",
      [listingId, req.session.userId],
    );
    if (!rows.length) {
      return res
        .status(404)
        .json({
          success: false,
          message: "Listing not found or access is not permitted",
        });
    }
    req.listing = rows[0];
    return next();
  } catch (error) {
    return next(error);
  }
}

// Public: approved documents only. Signed-out visitors and buyers see this.
router.get("/listing/:listingId/public", async (req, res, next) => {
  try {
    const listingId = positiveId(req.params.listingId);
    if (!listingId)
      return res
        .status(404)
        .json({ success: false, message: "Listing not found" });
    const [docs] = await pool.query(
      "SELECT id, document_type, title, file_path, created_at FROM listing_documents " +
        "WHERE listing_id = ? AND status = 'approved' ORDER BY created_at DESC",
      [listingId],
    );
    return res.json({ success: true, data: docs });
  } catch (error) {
    return next(error);
  }
});

// Seller or admin: all documents for a listing, including pending/rejected
// with review notes.
router.get("/listing/:listingId", isAuthenticated, async (req, res, next) => {
  try {
    const listingId = positiveId(req.params.listingId);
    if (!listingId)
      return res
        .status(404)
        .json({ success: false, message: "Listing not found" });

    const [listings] = await pool.query(
      "SELECT seller_id FROM listings WHERE id = ?",
      [listingId],
    );
    if (!listings.length)
      return res
        .status(404)
        .json({ success: false, message: "Listing not found" });

    const isOwner = listings[0].seller_id === req.session.userId;
    const isAdminUser = req.session.userRole === "admin";
    if (!isOwner && !isAdminUser) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    const [docs] = await pool.query(
      "SELECT d.id, d.document_type, d.title, d.file_path, d.mime_type, d.file_size, d.status, " +
        "d.review_notes, d.reviewed_at, d.created_at, r.name AS reviewer_name " +
        "FROM listing_documents d LEFT JOIN users r ON d.reviewed_by = r.id " +
        "WHERE d.listing_id = ? ORDER BY d.created_at DESC",
      [listingId],
    );
    return res.json({ success: true, data: docs });
  } catch (error) {
    return next(error);
  }
});

// Seller uploads a PDF to their own listing.
router.post(
  "/listing/:listingId",
  isAuthenticated,
  isMember,
  ownedListing,
  uploadDocument.single("document"),
  async (req, res, next) => {
    try {
      if (!req.file) {
        return res
          .status(400)
          .json({ success: false, message: "Choose a PDF to upload" });
      }
      const title = String(req.body.title || "").trim();
      const documentType = String(req.body.document_type || "other").trim();
      if (!title || title.length > MAX_TITLE_LENGTH) {
        safeUnlink(`/uploads/documents/${req.file.filename}`);
        return res
          .status(400)
          .json({
            success: false,
            message: `A title of up to ${MAX_TITLE_LENGTH} characters is required`,
          });
      }
      if (!DOCUMENT_TYPES.includes(documentType)) {
        safeUnlink(`/uploads/documents/${req.file.filename}`);
        return res
          .status(400)
          .json({ success: false, message: "Invalid document type" });
      }

      const filePath = `/uploads/documents/${req.file.filename}`;
      const [result] = await pool.query(
        "INSERT INTO listing_documents " +
          "(listing_id, uploaded_by, document_type, title, file_path, mime_type, file_size, status) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')",
        [
          req.listing.id,
          req.session.userId,
          documentType,
          title,
          filePath,
          req.file.mimetype,
          req.file.size,
        ],
      );
      return res.status(201).json({
        success: true,
        message: "Document uploaded - awaiting review",
        data: { id: result.insertId, status: "pending" },
      });
    } catch (error) {
      if (req.file) safeUnlink(`/uploads/documents/${req.file.filename}`);
      return next(error);
    }
  },
);

// Seller can delete their own doc if it's still pending or was rejected.
// Approved documents can only be removed by an admin.
router.delete("/:id", isAuthenticated, async (req, res, next) => {
  try {
    const id = positiveId(req.params.id);
    if (!id)
      return res
        .status(404)
        .json({ success: false, message: "Document not found" });

    const [docs] = await pool.query(
      "SELECT d.id, d.file_path, d.status, d.uploaded_by, l.seller_id " +
        "FROM listing_documents d JOIN listings l ON d.listing_id = l.id WHERE d.id = ?",
      [id],
    );
    if (!docs.length)
      return res
        .status(404)
        .json({ success: false, message: "Document not found" });

    const doc = docs[0];
    const isOwner = doc.seller_id === req.session.userId;
    const isAdminUser = req.session.userRole === "admin";
    if (!isOwner && !isAdminUser) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }
    if (isOwner && !isAdminUser && doc.status === "approved") {
      return res
        .status(403)
        .json({
          success: false,
          message: "Approved documents can only be removed by an administrator",
        });
    }

    await pool.query("DELETE FROM listing_documents WHERE id = ?", [id]);
    safeUnlink(doc.file_path);
    return res.json({ success: true, message: "Document removed" });
  } catch (error) {
    return next(error);
  }
});

// Admin: queue of all pending documents across listings.
router.get("/admin/queue", isAuthenticated, isAdmin, async (req, res, next) => {
  try {
    const status = ["pending", "approved", "rejected"].includes(
      req.query.status,
    )
      ? req.query.status
      : "pending";
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(
      50,
      Math.max(1, Number.parseInt(req.query.limit, 10) || 20),
    );
    const offset = (page - 1) * limit;

    const [docs] = await pool.query(
      "SELECT d.id, d.document_type, d.title, d.file_path, d.status, d.created_at, " +
        "l.id AS listing_id, l.title AS listing_title, u.name AS uploader_name " +
        "FROM listing_documents d " +
        "JOIN listings l ON d.listing_id = l.id " +
        "JOIN users u ON d.uploaded_by = u.id " +
        "WHERE d.status = ? ORDER BY d.created_at ASC LIMIT ? OFFSET ?",
      [status, limit, offset],
    );
    const [counts] = await pool.query(
      "SELECT COUNT(*) AS total FROM listing_documents WHERE status = ?",
      [status],
    );
    const total = counts[0].total;
    return res.json({
      success: true,
      data: docs,
      pagination: {
        current: page,
        total: Math.ceil(total / limit),
        perPage: limit,
        totalItems: total,
      },
    });
  } catch (error) {
    return next(error);
  }
});

// Admin: approve or reject a document, optionally leaving notes the seller
// will see on their edit page.
router.patch("/admin/:id", isAuthenticated, isAdmin, async (req, res, next) => {
  try {
    const id = positiveId(req.params.id);
    if (!id)
      return res
        .status(404)
        .json({ success: false, message: "Document not found" });

    const status = String(req.body.status || "").trim();
    if (!["approved", "rejected"].includes(status)) {
      return res
        .status(400)
        .json({
          success: false,
          message: "Status must be approved or rejected",
        });
    }
    const reviewNotes = req.body.review_notes
      ? String(req.body.review_notes).trim().slice(0, 500)
      : null;

    const [result] = await pool.query(
      "UPDATE listing_documents SET status = ?, reviewed_by = ?, reviewed_at = NOW(), review_notes = ? " +
        "WHERE id = ? AND status = 'pending'",
      [status, req.session.userId, reviewNotes, id],
    );
    if (!result.affectedRows) {
      return res
        .status(404)
        .json({
          success: false,
          message: "Document not found or already reviewed",
        });
    }
    return res.json({ success: true, message: `Document ${status}` });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
