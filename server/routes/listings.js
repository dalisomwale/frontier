const express = require("express");
const fs = require("fs");
const path = require("path");
const pool = require("../db");
const { isAuthenticated, isMember } = require("../middleware/auth");
const { uploadMedia } = require("../middleware/upload");

const router = express.Router();
const SPECIES = ["Cattle", "Goats", "Sheep", "Pigs", "Poultry"];
const HEALTH_STATUSES = ["healthy", "treated", "under_treatment", "unknown"];
const MAX_PAGE_SIZE = 50;
const MAX_AGE_MONTHS = 600;
const MAX_WEIGHT_KG = 100000;

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
  const location = text(body.location, 255);
  const price = finiteNumber(body.price);
  const description = text(body.description, 20000);
  const ageMonths = positiveInteger(body.age_months, null);
  const weightKg = finiteNumber(body.weight_kg);
  const healthStatus = text(body.health_status, 32);

  if (!partial && (!title || !species || !location || price === null)) {
    return { error: "Title, species, location, and price are required" };
  }
  if (species && !SPECIES.includes(species)) {
    return { error: "Please select a valid livestock category" };
  }
  if (price !== null && price <= 0) {
    return { error: "Price must be greater than zero" };
  }
  if (healthStatus && !HEALTH_STATUSES.includes(healthStatus)) {
    return { error: "Please select a valid health status" };
  }
  if (ageMonths !== null && ageMonths > MAX_AGE_MONTHS) {
    return { error: `Age must be ${MAX_AGE_MONTHS} months or less` };
  }
  if (weightKg !== null && (weightKg <= 0 || weightKg > MAX_WEIGHT_KG)) {
    return {
      error: `Weight must be between 0 and ${MAX_WEIGHT_KG.toLocaleString()} kg`,
    };
  }
  // On partial updates, a field that is explicitly present must be valid if
  // the client sent a non-empty value for it. Fields the client omitted are
  // simply not touched.
  if (
    (body.title !== undefined && !title) ||
    (body.species !== undefined && (!species || !SPECIES.includes(species))) ||
    (body.location !== undefined && !location) ||
    (body.price !== undefined && price === null) ||
    (body.breed !== undefined && body.breed !== "" && !breed) ||
    (body.age_months !== undefined &&
      body.age_months !== "" &&
      ageMonths === null) ||
    (body.weight_kg !== undefined &&
      body.weight_kg !== "" &&
      weightKg === null) ||
    (body.health_status !== undefined &&
      body.health_status !== "" &&
      !HEALTH_STATUSES.includes(healthStatus))
  ) {
    return { error: "One or more listing fields are invalid" };
  }
  return {
    title,
    species,
    breed,
    location,
    price,
    description,
    age_months: ageMonths,
    weight_kg: weightKg,
    health_status: healthStatus || "unknown",
  };
}

async function ownedListing(req, res, next) {
  try {
    const [rows] = await pool.query(
      "SELECT id, seller_id, status FROM listings WHERE id = ? AND seller_id = ?",
      [req.params.id, req.session.userId],
    );
    if (!rows.length) {
      return res.status(404).json({
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

function cleanupFiles(files) {
  for (const file of files || []) fs.unlink(file.path, () => {});
}

// Public marketplace data only exposes listings the seller has marked
// active. Filtering occurs in MySQL, not in the browser.
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
    const healthStatus = text(req.query.health_status, 32);
    const sellerId = positiveInteger(req.query.sellerId, null);

    if (keyword) {
      // MATCH AGAINST uses the FULLTEXT index on (title, description, breed,
      // location). Falls back gracefully to zero rows on very short terms,
      // which MySQL's default minimum word length rejects.
      where.push(
        "MATCH (l.title, l.description, l.breed, l.location) AGAINST (? IN NATURAL LANGUAGE MODE)",
      );
      params.push(keyword);
    }
    if (species && SPECIES.includes(species)) {
      where.push("l.species = ?");
      params.push(species);
    }
    if (breed) {
      where.push("l.breed LIKE ?");
      params.push(`%${breed}%`);
    }
    if (location) {
      where.push("l.location LIKE ?");
      params.push(`%${location}%`);
    }
    if (healthStatus && HEALTH_STATUSES.includes(healthStatus)) {
      where.push("l.health_status = ?");
      params.push(healthStatus);
    }
    if (sellerId) {
      where.push("l.seller_id = ?");
      params.push(sellerId);
    }

    for (const [queryName, column, direction] of [
      ["minPrice", "l.price", ">="],
      ["maxPrice", "l.price", "<="],
      ["minAge", "l.age_months", ">="],
      ["maxAge", "l.age_months", "<="],
      ["minWeight", "l.weight_kg", ">="],
      ["maxWeight", "l.weight_kg", "<="],
    ]) {
      if (req.query[queryName] !== undefined) {
        const value = finiteNumber(req.query[queryName]);
        if (value === null || value < 0) {
          return res.status(400).json({
            success: false,
            message: `${queryName} must be a valid positive number`,
          });
        }
        where.push(`${column} ${direction} ?`);
        params.push(value);
      }
    }

    const condition = where.join(" AND ");
    const order =
      {
        "price-low": "l.price ASC",
        "price-high": "l.price DESC",
        location: "l.location ASC, l.created_at DESC",
        newest: "l.created_at DESC",
      }[req.query.sort] || "l.created_at DESC";

    const [listings] = await pool.query(
      `SELECT l.*, u.name AS seller_name, u.location AS seller_location,
       (SELECT file_path FROM listing_media WHERE listing_id = l.id ORDER BY id ASC LIMIT 1) AS main_image
       FROM listings l JOIN users u ON u.id = l.seller_id
       WHERE ${condition} ORDER BY ${order} LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    const [counts] = await pool.query(
      `SELECT COUNT(*) AS total FROM listings l JOIN users u ON u.id = l.seller_id WHERE ${condition}`,
      params,
    );
    const total = counts[0].total;
    return res.json({
      success: true,
      data: listings,
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

// Seller-only index, placed before /:id to avoid treating "mine" as an id.
router.get("/mine", isAuthenticated, isMember, async (req, res, next) => {
  try {
    const page = positiveInteger(req.query.page, 1);
    const limit = Math.min(positiveInteger(req.query.limit, 20), MAX_PAGE_SIZE);
    const offset = (page - 1) * limit;
    const status = text(req.query.status, 20);
    const where = ["l.seller_id = ?"];
    const params = [req.session.userId];
    if (
      status &&
      ["active", "paused", "deactivated", "sold"].includes(status)
    ) {
      where.push("l.status = ?");
      params.push(status);
    }
    const condition = where.join(" AND ");
    const [rows] = await pool.query(
      `SELECT l.*, (SELECT file_path FROM listing_media WHERE listing_id = l.id ORDER BY id ASC LIMIT 1) AS main_image
       FROM listings l WHERE ${condition} ORDER BY l.created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    const [counts] = await pool.query(
      `SELECT COUNT(*) AS total FROM listings l WHERE ${condition}`,
      params,
    );
    const [statusCounts] = await pool.query(
      "SELECT status, COUNT(*) AS count FROM listings WHERE seller_id = ? GROUP BY status",
      [req.session.userId],
    );
    const summary = { total: 0, active: 0, paused: 0, deactivated: 0, sold: 0 };
    statusCounts.forEach((row) => {
      summary[row.status] = row.count;
      summary.total += row.count;
    });
    return res.json({
      success: true,
      data: rows,
      summary,
      pagination: {
        current: page,
        total: Math.ceil(counts[0].total / limit),
        perPage: limit,
        totalItems: counts[0].total,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/mine/:id", isAuthenticated, isMember, async (req, res, next) => {
  try {
    const id = positiveInteger(req.params.id, 0);
    const [listings] = await pool.query(
      "SELECT * FROM listings WHERE id = ? AND seller_id = ?",
      [id, req.session.userId],
    );
    if (!listings.length)
      return res
        .status(404)
        .json({ success: false, message: "Listing not found" });
    const listing = listings[0];
    const [media] = await pool.query(
      "SELECT id, file_path, created_at FROM listing_media WHERE listing_id = ? ORDER BY id ASC",
      [id],
    );
    return res.json({ success: true, data: { ...listing, media } });
  } catch (error) {
    return next(error);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const id = positiveInteger(req.params.id, 0);
    if (!id)
      return res
        .status(404)
        .json({ success: false, message: "Listing not found" });
    const [listings] = await pool.query(
      `SELECT l.*, u.name AS seller_name, u.location AS seller_location
       FROM listings l JOIN users u ON l.seller_id = u.id
       WHERE l.id = ? AND l.status = 'active' AND u.status = 'active'`,
      [id],
    );
    if (!listings.length)
      return res
        .status(404)
        .json({ success: false, message: "Listing not found" });
    const listing = listings[0];
    const [media] = await pool.query(
      "SELECT id, file_path, created_at FROM listing_media WHERE listing_id = ? ORDER BY id ASC",
      [id],
    );
    return res.json({ success: true, data: { ...listing, media } });
  } catch (error) {
    return next(error);
  }
});

router.post("/", isAuthenticated, isMember, async (req, res, next) => {
  try {
    const data = listingPayload(req.body);
    if (data.error)
      return res.status(400).json({ success: false, message: data.error });
    const [result] = await pool.query(
      `INSERT INTO listings
        (seller_id, title, species, breed, location, price, description, age_months, weight_kg, health_status, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
      [
        req.session.userId,
        data.title,
        data.species,
        data.breed,
        data.location,
        data.price,
        data.description,
        data.age_months,
        data.weight_kg,
        data.health_status,
      ],
    );
    return res.status(201).json({
      success: true,
      message: "Listing created successfully",
      data: { id: result.insertId, status: "active" },
    });
  } catch (error) {
    return next(error);
  }
});

router.put(
  "/:id",
  isAuthenticated,
  isMember,
  ownedListing,
  async (req, res, next) => {
    try {
      const data = listingPayload(req.body, { partial: true });
      if (data.error)
        return res.status(400).json({ success: false, message: data.error });

      const columns = [
        "title",
        "species",
        "breed",
        "location",
        "price",
        "description",
        "age_months",
        "weight_kg",
        "health_status",
      ];
      const fields = [];
      const values = [];
      for (const column of columns) {
        if (req.body[column] !== undefined) {
          fields.push(`${column} = ?`);
          values.push(data[column]);
        }
      }
      if (!fields.length) {
        return res.status(400).json({
          success: false,
          message: "Provide at least one listing field to update",
        });
      }
      await pool.query(
        `UPDATE listings SET ${fields.join(", ")} WHERE id = ?`,
        [...values, req.listing.id],
      );
      return res.json({
        success: true,
        message: "Listing updated successfully",
      });
    } catch (error) {
      return next(error);
    }
  },
);

router.patch(
  "/:id/status",
  isAuthenticated,
  isMember,
  ownedListing,
  async (req, res, next) => {
    try {
      const status = text(req.body.status, 20);
      const allowed = {
        active: ["paused", "deactivated", "sold"],
        paused: ["active", "deactivated", "sold"],
        deactivated: [],
        sold: [],
      };
      if (
        !allowed[req.listing.status] ||
        !allowed[req.listing.status].includes(status)
      ) {
        return res.status(400).json({
          success: false,
          message: "That status change is not available for this listing",
        });
      }
      await pool.query("UPDATE listings SET status = ? WHERE id = ?", [
        status,
        req.listing.id,
      ]);
      return res.json({ success: true, message: `Listing marked ${status}` });
    } catch (error) {
      return next(error);
    }
  },
);

router.delete(
  "/:id",
  isAuthenticated,
  isMember,
  ownedListing,
  async (req, res, next) => {
    try {
      const [files] = await pool.query(
        "SELECT file_path FROM listing_media WHERE listing_id = ?",
        [req.listing.id],
      );
      await pool.query("DELETE FROM listings WHERE id = ?", [req.listing.id]);
      files.forEach(({ file_path }) => {
        const absolute = path.resolve("public", `.${file_path}`);
        if (absolute.startsWith(path.resolve("public/uploads") + path.sep))
          fs.unlink(absolute, () => {});
      });
      return res.json({
        success: true,
        message: "Listing deleted successfully",
      });
    } catch (error) {
      return next(error);
    }
  },
);

router.post(
  "/:id/media",
  isAuthenticated,
  isMember,
  ownedListing,
  uploadMedia.array("files", 10),
  async (req, res, next) => {
    try {
      const files = req.files || [];
      if (!files.length)
        return res
          .status(400)
          .json({ success: false, message: "Choose at least one image" });
      const values = files.map((file) => [
        req.listing.id,
        `/uploads/livestock/${file.filename}`,
      ]);
      const [result] = await pool.query(
        "INSERT INTO listing_media (listing_id, file_path) VALUES ?",
        [values],
      );
      return res.status(201).json({
        success: true,
        message: "Media uploaded successfully",
        data: { count: result.affectedRows },
      });
    } catch (error) {
      cleanupFiles(req.files);
      return next(error);
    }
  },
);

module.exports = router;
