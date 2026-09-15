const express = require("express");
const fs = require("fs");
const path = require("path");
const pool = require("../db");
const { isAuthenticated, isSeller } = require("../middleware/auth");
const { uploadMedia, uploadDocument } = require("../middleware/upload");

const router = express.Router();
const SPECIES = ["Cattle", "Goats", "Sheep", "Pigs", "Poultry", "Other"];
const MAX_PAGE_SIZE = 50;

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function finiteNumber(value) {
  if (value === "" || value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value, maxLength) {
  if (value === undefined || value === null) return null;
  const output = String(value).trim();
  return output && output.length <= maxLength ? output : null;
}

function listingPayload(body, { partial = false } = {}) {
  const title = text(body.title, 255);
  const species = text(body.species, 100);
  const breed = text(body.breed, 100);
  const age = text(body.age, 50);
  const location = text(body.location, 255);
  const healthStatus = text(body.healthStatus ?? body.health_status, 100);
  const description = text(body.description, 20000);
  const price = finiteNumber(body.price);
  const weight = finiteNumber(body.weight);

  if (!partial && (!title || !species || !breed || !age || !location || !healthStatus || !description || price === null || weight === null)) {
    return { error: "Title, species, breed, age, weight, location, health status, price, and description are required" };
  }
  if (species && !SPECIES.includes(species)) return { error: "Please select a valid livestock category" };
  if (price !== null && price <= 0) return { error: "Price must be greater than zero" };
  if (weight !== null && weight <= 0) return { error: "Weight must be greater than zero" };
  if ((body.title !== undefined && !title) || (body.species !== undefined && (!species || !SPECIES.includes(species))) || (body.breed !== undefined && !breed) ||
      (body.age !== undefined && !age) || (body.location !== undefined && !location) ||
      ((body.healthStatus !== undefined || body.health_status !== undefined) && !healthStatus) ||
      (body.description !== undefined && !description) || (body.price !== undefined && price === null) ||
      (body.weight !== undefined && weight === null)) {
    return { error: "One or more listing fields are invalid" };
  }
  return { title, species, breed, age, weight, location, healthStatus, price, description };
}

async function ownedListing(req, res, next) {
  try {
    const [rows] = await pool.query(
      "SELECT id, seller_id, status FROM listings WHERE id = ? AND seller_id = ?",
      [req.params.id, req.session.userId],
    );
    if (!rows.length) return res.status(404).json({ success: false, message: "Listing not found or access is not permitted" });
    req.listing = rows[0];
    return next();
  } catch (error) {
    return next(error);
  }
}

function cleanupFiles(files) {
  for (const file of files || []) fs.unlink(file.path, () => {});
}

// Public marketplace data only exposes listings that completed moderation and
// remain active. Filtering occurs in MySQL, not in the browser.
router.get("/", async (req, res, next) => {
  try {
    const page = positiveInteger(req.query.page, 1);
    const limit = Math.min(positiveInteger(req.query.limit, 12), MAX_PAGE_SIZE);
    const offset = (page - 1) * limit;
    const where = ["l.status = 'active'", "u.status = 'active'"];
    const params = [];
    const keyword = text(req.query.keyword, 120);
    const species = text(req.query.species, 100);
    const breed = text(req.query.breed, 100);
    const location = text(req.query.location, 120);
    if (keyword) {
      where.push("(l.title LIKE ? OR l.description LIKE ? OR l.breed LIKE ?)");
      params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
    }
    if (species && SPECIES.includes(species)) { where.push("l.species = ?"); params.push(species); }
    if (breed) { where.push("l.breed LIKE ?"); params.push(`%${breed}%`); }
    if (location) { where.push("l.location LIKE ?"); params.push(`%${location}%`); }
    for (const [queryName, column, direction] of [["minPrice", "l.price", ">="], ["maxPrice", "l.price", "<="], ["minWeight", "l.weight", ">="], ["maxWeight", "l.weight", "<="]]) {
      if (req.query[queryName] !== undefined) {
        const value = finiteNumber(req.query[queryName]);
        if (value === null || value < 0) return res.status(400).json({ success: false, message: `${queryName} must be a valid positive number` });
        where.push(`${column} ${direction} ?`);
        params.push(value);
      }
    }
    const age = text(req.query.age, 50);
    if (age) { where.push("l.age LIKE ?"); params.push(`%${age}%`); }
    const condition = where.join(" AND ");
    const order = {
      "price-low": "l.price ASC",
      "price-high": "l.price DESC",
      location: "l.location ASC, l.created_at DESC",
      newest: "l.created_at DESC",
    }[req.query.sort] || "l.created_at DESC";
    const [listings] = await pool.query(
      `SELECT l.*, u.name AS seller_name, u.location AS seller_location,
       (SELECT file_path FROM listing_media WHERE listing_id = l.id AND file_type = 'image' ORDER BY id ASC LIMIT 1) AS main_image
       FROM listings l JOIN users u ON u.id = l.seller_id WHERE ${condition} ORDER BY ${order} LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    const [counts] = await pool.query(
      `SELECT COUNT(*) AS total FROM listings l JOIN users u ON u.id = l.seller_id WHERE ${condition}`,
      params,
    );
    const total = counts[0].total;
    return res.json({ success: true, data: listings, pagination: { current: page, total: Math.ceil(total / limit), perPage: limit, totalItems: total } });
  } catch (error) { return next(error); }
});

// Seller-only index, placed before /:id to avoid treating "mine" as an id.
router.get("/mine", isAuthenticated, isSeller, async (req, res, next) => {
  try {
    const page = positiveInteger(req.query.page, 1);
    const limit = Math.min(positiveInteger(req.query.limit, 20), MAX_PAGE_SIZE);
    const offset = (page - 1) * limit;
    const status = text(req.query.status, 20);
    const where = ["l.seller_id = ?"];
    const params = [req.session.userId];
    if (status && ["pending", "approved", "rejected", "active", "paused", "deactivated", "sold"].includes(status)) {
      where.push("l.status = ?"); params.push(status);
    }
    const condition = where.join(" AND ");
    const [rows] = await pool.query(
      `SELECT l.*, (SELECT file_path FROM listing_media WHERE listing_id = l.id AND file_type = 'image' ORDER BY id ASC LIMIT 1) AS main_image
       FROM listings l WHERE ${condition} ORDER BY l.created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    const [counts] = await pool.query(`SELECT COUNT(*) AS total FROM listings l WHERE ${condition}`, params);
    const [statusCounts] = await pool.query(
      "SELECT status, COUNT(*) AS count FROM listings WHERE seller_id = ? GROUP BY status",
      [req.session.userId],
    );
    const summary = { total: 0, active: 0, pending: 0, paused: 0, deactivated: 0, sold: 0, rejected: 0 };
    statusCounts.forEach((row) => { summary[row.status] = row.count; summary.total += row.count; });
    return res.json({ success: true, data: rows, summary, pagination: { current: page, total: Math.ceil(counts[0].total / limit), perPage: limit, totalItems: counts[0].total } });
  } catch (error) { return next(error); }
});

router.get("/mine/:id", isAuthenticated, isSeller, async (req, res, next) => {
  try {
    const id = positiveInteger(req.params.id, 0);
    const [listings] = await pool.query("SELECT * FROM listings WHERE id = ? AND seller_id = ?", [id, req.session.userId]);
    if (!listings.length) return res.status(404).json({ success: false, message: "Listing not found" });
    const listing = listings[0];
    const [media] = await pool.query("SELECT id, file_path, file_type, created_at FROM listing_media WHERE listing_id = ? ORDER BY id ASC", [id]);
    const [documents] = await pool.query("SELECT id, file_path, document_type, status, uploaded_at FROM listing_documents WHERE listing_id = ? ORDER BY id ASC", [id]);
    return res.json({ success: true, data: { ...listing, media, documents } });
  } catch (error) { return next(error); }
});

router.get("/:id", async (req, res, next) => {
  try {
    const id = positiveInteger(req.params.id, 0);
    if (!id) return res.status(404).json({ success: false, message: "Listing not found" });
    const [listings] = await pool.query(
      `SELECT l.*, u.name AS seller_name, u.location AS seller_location
       FROM listings l JOIN users u ON l.seller_id = u.id
       WHERE l.id = ? AND l.status = 'active' AND u.status = 'active'`, [id],
    );
    if (!listings.length) return res.status(404).json({ success: false, message: "Listing not found" });
    const listing = listings[0];
    const [media] = await pool.query("SELECT id, file_path, file_type, created_at FROM listing_media WHERE listing_id = ? ORDER BY id ASC", [id]);
    // Documents are informational only. Do not expose document links to
    // visitors; this prevents broad access to a seller's supporting files.
    const [documents] = await pool.query("SELECT id, document_type, status, uploaded_at FROM listing_documents WHERE listing_id = ? ORDER BY id ASC", [id]);
    return res.json({ success: true, data: { ...listing, media, documents } });
  } catch (error) { return next(error); }
});

router.post("/", isAuthenticated, isSeller, async (req, res, next) => {
  try {
    const data = listingPayload(req.body);
    if (data.error) return res.status(400).json({ success: false, message: data.error });
    const [result] = await pool.query(
      `INSERT INTO listings (seller_id, title, species, breed, age, weight, location, health_status, price, description, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [req.session.userId, data.title, data.species, data.breed, data.age, data.weight, data.location, data.healthStatus, data.price, data.description],
    );
    return res.status(201).json({ success: true, message: "Listing created and sent for review", data: { id: result.insertId, status: "pending" } });
  } catch (error) { return next(error); }
});

router.put("/:id", isAuthenticated, isSeller, ownedListing, async (req, res, next) => {
  try {
    const data = listingPayload(req.body, { partial: true });
    if (data.error) return res.status(400).json({ success: false, message: data.error });
    const mappings = [["title", "title"], ["species", "species"], ["breed", "breed"], ["age", "age"], ["weight", "weight"], ["location", "location"], ["healthStatus", "health_status"], ["price", "price"], ["description", "description"]];
    const fields = [];
    const values = [];
    for (const [key, column] of mappings) {
      if (req.body[key] !== undefined || (key === "healthStatus" && req.body.health_status !== undefined)) {
        fields.push(`${column} = ?`); values.push(data[key]);
      }
    }
    if (!fields.length) return res.status(400).json({ success: false, message: "Provide at least one listing field to update" });
    // Any edits after a rejection are returned to moderation. Active listings
    // remain active for ordinary content corrections.
    if (req.listing.status === "rejected") fields.push("status = 'pending'");
    await pool.query(`UPDATE listings SET ${fields.join(", ")} WHERE id = ?`, [...values, req.listing.id]);
    return res.json({ success: true, message: req.listing.status === "rejected" ? "Listing updated and resubmitted for review" : "Listing updated successfully" });
  } catch (error) { return next(error); }
});

router.patch("/:id/status", isAuthenticated, isSeller, ownedListing, async (req, res, next) => {
  try {
    const status = text(req.body.status, 20);
    const allowed = {
      active: ["paused", "deactivated", "sold"],
      paused: ["active", "deactivated", "sold"],
      deactivated: [],
      sold: [],
      pending: ["deactivated"],
      rejected: ["deactivated"],
    };
    if (!allowed[req.listing.status] || !allowed[req.listing.status].includes(status)) {
      return res.status(400).json({ success: false, message: "That status change is not available for this listing" });
    }
    await pool.query("UPDATE listings SET status = ? WHERE id = ?", [status, req.listing.id]);
    return res.json({ success: true, message: `Listing marked ${status}` });
  } catch (error) { return next(error); }
});

router.delete("/:id", isAuthenticated, isSeller, ownedListing, async (req, res, next) => {
  try {
    const [files] = await pool.query(
      `SELECT file_path FROM listing_media WHERE listing_id = ? UNION ALL SELECT file_path FROM listing_documents WHERE listing_id = ?`,
      [req.listing.id, req.listing.id],
    );
    await pool.query("DELETE FROM listings WHERE id = ?", [req.listing.id]);
    files.forEach(({ file_path }) => {
      const absolute = path.resolve("public", `.${file_path}`);
      if (absolute.startsWith(path.resolve("public/uploads") + path.sep)) fs.unlink(absolute, () => {});
    });
    return res.json({ success: true, message: "Listing deleted successfully" });
  } catch (error) { return next(error); }
});

router.post("/:id/media", isAuthenticated, isSeller, ownedListing,
  uploadMedia.fields([{ name: "files", maxCount: 10 }, { name: "file", maxCount: 1 }, { name: "images", maxCount: 8 }, { name: "videos", maxCount: 2 }]),
  async (req, res, next) => {
    try {
      const files = Object.values(req.files || {}).flat();
      if (!files.length) return res.status(400).json({ success: false, message: "Choose at least one image or video" });
      const values = files.map((file) => [req.listing.id, `/uploads/${file.mimetype.startsWith("video/") ? "videos" : "livestock"}/${file.filename}`, file.mimetype.startsWith("video/") ? "video" : "image"]);
      const [result] = await pool.query("INSERT INTO listing_media (listing_id, file_path, file_type) VALUES ?", [values]);
      return res.status(201).json({ success: true, message: "Media uploaded successfully", data: { count: result.affectedRows } });
    } catch (error) { cleanupFiles(Object.values(req.files || {}).flat()); return next(error); }
  },
);

router.post("/:id/documents", isAuthenticated, isSeller, ownedListing, uploadDocument.array("documents", 5), async (req, res, next) => {
  try {
    if (!req.files?.length) return res.status(400).json({ success: false, message: "Choose at least one PDF document" });
    const rawTypes = Array.isArray(req.body.document_type) ? req.body.document_type : [req.body.document_type];
    const values = req.files.map((file, index) => [req.listing.id, req.session.userId, `/uploads/documents/${file.filename}`, text(rawTypes[index] || rawTypes[0], 100) || "Supporting document"]);
    const [result] = await pool.query("INSERT INTO listing_documents (listing_id, seller_id, file_path, document_type) VALUES ?", [values]);
    return res.status(201).json({ success: true, message: "Document uploaded. Verification: Pending", data: { count: result.affectedRows, status: "pending" } });
  } catch (error) { cleanupFiles(req.files); return next(error); }
});

module.exports = router;
