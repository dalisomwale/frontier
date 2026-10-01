const express = require("express");
const pool = require("../../db");
const { uploadImages, saveImage, deleteImageFiles, MAX_FILES } = require("../../middleware/upload");
const { positiveInt, text, oneOf, badRequest, notFound } = require("../../lib/validate");
const { LIVESTOCK_TYPES } = require("../public");

const router = express.Router();
const STATUSES = ["published", "unpublished"];
const MAX_PAGE_SIZE = 50;

// Validates the listing fields and checks the breed really belongs to the
// chosen category (so the public Category -> Breed filter stays truthful).
async function payload(body) {
  const title = text(body.title, 200);
  const location = text(body.location, 150);
  const description = text(body.description, 5000);
  const categoryId = positiveInt(body.category_id);
  const breedId = body.breed_id === "" || body.breed_id === undefined ? null : positiveInt(body.breed_id);
  const type = body.livestock_type ? oneOf(body.livestock_type, LIVESTOCK_TYPES) : null;
  const status = oneOf(body.status || "unpublished", STATUSES);
  const quantity = body.quantity === "" || body.quantity === undefined ? 1 : positiveInt(body.quantity);
  const age = body.age_months === "" || body.age_months === undefined || body.age_months === null
    ? null
    : Number.parseInt(body.age_months, 10);

  const errors = {};
  if (!title) errors.title = title === undefined ? "Title must be 200 characters or fewer." : "Title is required.";
  if (!categoryId) errors.category_id = "Please choose a category.";
  if (body.breed_id && !breedId) errors.breed_id = "Please choose a valid breed.";
  if (!location) errors.location = location === undefined ? "Location is too long." : "Location is required.";
  if (description === undefined) errors.description = "Description must be 5000 characters or fewer.";
  if (body.livestock_type && !type) errors.livestock_type = "Please choose a valid type.";
  if (!status) errors.status = "Invalid status.";
  if (!quantity || quantity > 100000) errors.quantity = "Quantity must be a whole number from 1.";
  if (age !== null && (!Number.isSafeInteger(age) || age < 0 || age > 600))
    errors.age_months = "Age must be between 0 and 600 months.";

  if (categoryId && !errors.category_id) {
    const [cats] = await pool.query("SELECT id FROM categories WHERE id = ?", [categoryId]);
    if (!cats.length) errors.category_id = "That category does not exist.";
  }
  if (breedId && !errors.breed_id && !errors.category_id) {
    const [rows] = await pool.query("SELECT category_id FROM breeds WHERE id = ?", [breedId]);
    if (!rows.length) errors.breed_id = "That breed does not exist.";
    else if (rows[0].category_id !== categoryId)
      errors.breed_id = "That breed doesn't belong to the selected category.";
  }

  if (Object.keys(errors).length) {
    const error = badRequest("Please correct the highlighted fields.");
    error.status = 422;
    error.errors = errors;
    throw error;
  }

  return {
    title,
    category_id: categoryId,
    breed_id: breedId,
    livestock_type: type,
    quantity,
    age_months: age,
    location,
    description,
    status,
  };
}

async function storeImages(conn, livestockId, files) {
  if (!files || !files.length) return [];
  const [[{ count, max_order }]] = await conn.query(
    "SELECT COUNT(*) AS count, COALESCE(MAX(sort_order), -1) AS max_order FROM livestock_images WHERE livestock_id = ?",
    [livestockId],
  );
  if (Number(count) + files.length > MAX_FILES) {
    throw badRequest(`A listing can have at most ${MAX_FILES} photos.`);
  }
  const saved = [];
  try {
    let order = Number(max_order) + 1;
    for (const file of files) {
      const paths = await saveImage(file.buffer);
      saved.push(paths);
      await conn.query(
        "INSERT INTO livestock_images (livestock_id, image_path, thumb_path, sort_order) VALUES (?, ?, ?, ?)",
        [livestockId, paths.image_path, paths.thumb_path, order++],
      );
    }
  } catch (error) {
    saved.forEach((p) => deleteImageFiles(p.image_path, p.thumb_path));
    throw error;
  }
  return saved;
}

async function loadOne(id) {
  const [rows] = await pool.query(
    `SELECT l.*, c.name AS category_name, b.name AS breed_name
     FROM livestock l JOIN categories c ON c.id = l.category_id
     LEFT JOIN breeds b ON b.id = l.breed_id WHERE l.id = ?`,
    [id],
  );
  if (!rows.length) throw notFound("Livestock listing not found.");
  const [images] = await pool.query(
    "SELECT id, image_path, thumb_path, sort_order FROM livestock_images WHERE livestock_id = ? ORDER BY sort_order, id",
    [id],
  );
  const [[{ inquiries }]] = await pool.query(
    "SELECT COUNT(*) AS inquiries FROM inquiries WHERE livestock_id = ?",
    [id],
  );
  return { ...rows[0], images, inquiry_count: Number(inquiries) };
}

// ---------------------------------------------------------------------------

router.get("/", async (req, res, next) => {
  try {
    const page = positiveInt(req.query.page, 1);
    const limit = Math.min(positiveInt(req.query.limit, 20), MAX_PAGE_SIZE);
    const where = ["1 = 1"];
    const params = [];

    const status = oneOf(req.query.status, STATUSES);
    const categoryId = positiveInt(req.query.category_id);
    const q = text(req.query.q, 100);
    if (status) {
      where.push("l.status = ?");
      params.push(status);
    }
    if (categoryId) {
      where.push("l.category_id = ?");
      params.push(categoryId);
    }
    if (q) {
      where.push("(l.title LIKE ? OR l.location LIKE ? OR b.name LIKE ?)");
      const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
      params.push(like, like, like);
    }
    const condition = where.join(" AND ");

    const [rows] = await pool.query(
      `SELECT l.id, l.title, l.status, l.location, l.livestock_type, l.quantity,
         l.created_at, l.updated_at, c.name AS category_name, b.name AS breed_name,
         (SELECT li.thumb_path FROM livestock_images li WHERE li.livestock_id = l.id
            ORDER BY li.sort_order, li.id LIMIT 1) AS thumb_path,
         (SELECT COUNT(*) FROM livestock_images li WHERE li.livestock_id = l.id) AS image_count,
         (SELECT COUNT(*) FROM inquiries i WHERE i.livestock_id = l.id) AS inquiry_count
       FROM livestock l JOIN categories c ON c.id = l.category_id
       LEFT JOIN breeds b ON b.id = l.breed_id
       WHERE ${condition}
       ORDER BY l.created_at DESC, l.id DESC LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit],
    );
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM livestock l LEFT JOIN breeds b ON b.id = l.breed_id WHERE ${condition}`,
      params,
    );
    res.json({
      success: true,
      data: rows,
      pagination: { current: page, total: Math.max(1, Math.ceil(total / limit)), totalItems: Number(total) },
    });
  } catch (error) {
    next(error);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    res.json({ success: true, data: await loadOne(positiveInt(req.params.id)) });
  } catch (error) {
    next(error);
  }
});

router.post("/", uploadImages, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const p = await payload(req.body);
    await conn.beginTransaction();
    const [result] = await conn.query(
      `INSERT INTO livestock
         (title, category_id, breed_id, livestock_type, quantity, age_months, location, description, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [p.title, p.category_id, p.breed_id, p.livestock_type, p.quantity, p.age_months,
        p.location, p.description, p.status, req.admin.id],
    );
    await storeImages(conn, result.insertId, req.files);
    await conn.commit();
    res.status(201).json({ success: true, data: await loadOne(result.insertId) });
  } catch (error) {
    await conn.rollback().catch(() => {});
    next(error);
  } finally {
    conn.release();
  }
});

// Full edit. Accepts new photos (multipart "images"), photos to remove
// ("remove_image_ids", JSON array) and a new photo order ("image_order",
// JSON array of image ids - the first becomes the cover photo).
router.put("/:id", uploadImages, async (req, res, next) => {
  const conn = await pool.getConnection();
  const filesToDelete = [];
  try {
    const id = positiveInt(req.params.id);
    const [exists] = await conn.query("SELECT id FROM livestock WHERE id = ?", [id]);
    if (!exists.length) throw notFound("Livestock listing not found.");
    const p = await payload(req.body);

    let removeIds = [];
    let order = [];
    try {
      removeIds = JSON.parse(req.body.remove_image_ids || "[]").map(Number).filter(Number.isSafeInteger);
      order = JSON.parse(req.body.image_order || "[]").map(Number).filter(Number.isSafeInteger);
    } catch {
      throw badRequest("Invalid photo changes.");
    }

    await conn.beginTransaction();
    await conn.query(
      `UPDATE livestock SET title = ?, category_id = ?, breed_id = ?, livestock_type = ?, quantity = ?,
         age_months = ?, location = ?, description = ?, status = ? WHERE id = ?`,
      [p.title, p.category_id, p.breed_id, p.livestock_type, p.quantity, p.age_months,
        p.location, p.description, p.status, id],
    );

    if (removeIds.length) {
      const [old] = await conn.query(
        "SELECT id, image_path, thumb_path FROM livestock_images WHERE livestock_id = ? AND id IN (?)",
        [id, removeIds],
      );
      if (old.length) {
        await conn.query("DELETE FROM livestock_images WHERE livestock_id = ? AND id IN (?)", [
          id,
          old.map((row) => row.id),
        ]);
        old.forEach((row) => filesToDelete.push(row.image_path, row.thumb_path));
      }
    }
    for (const [index, imageId] of order.entries()) {
      await conn.query(
        "UPDATE livestock_images SET sort_order = ? WHERE id = ? AND livestock_id = ?",
        [index, imageId, id],
      );
    }
    await storeImages(conn, id, req.files);
    await conn.commit();
    deleteImageFiles(...filesToDelete);
    res.json({ success: true, data: await loadOne(id) });
  } catch (error) {
    await conn.rollback().catch(() => {});
    next(error);
  } finally {
    conn.release();
  }
});

router.patch("/:id/status", async (req, res, next) => {
  try {
    const status = oneOf(req.body.status, STATUSES);
    if (!status) throw badRequest("Status must be published or unpublished.");
    const [result] = await pool.query("UPDATE livestock SET status = ? WHERE id = ?", [
      status,
      positiveInt(req.params.id),
    ]);
    if (!result.affectedRows) throw notFound("Livestock listing not found.");
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id);
    const [images] = await pool.query(
      "SELECT image_path, thumb_path FROM livestock_images WHERE livestock_id = ?",
      [id],
    );
    // Images cascade in the DB; inquiries keep their copied title (FK SET NULL).
    const [result] = await pool.query("DELETE FROM livestock WHERE id = ?", [id]);
    if (!result.affectedRows) throw notFound("Livestock listing not found.");
    images.forEach((row) => deleteImageFiles(row.image_path, row.thumb_path));
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
