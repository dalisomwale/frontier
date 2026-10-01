const express = require("express");
const pool = require("../../db");
const { positiveInt, text, oneOf, badRequest, notFound } = require("../../lib/validate");

const STATUSES = ["active", "disabled"];

// Admin CRUD for categories and breeds. They share the same shape, so one
// factory builds both routers.
function isDuplicate(error) {
  return error && error.code === "ER_DUP_ENTRY";
}
function isInUse(error) {
  return error && (error.code === "ER_ROW_IS_REFERENCED_2" || error.code === "ER_ROW_IS_REFERENCED");
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------
const categories = express.Router();

categories.get("/", async (req, res, next) => {
  try {
    const [rows] = await pool.query(`
      SELECT c.*,
        (SELECT COUNT(*) FROM breeds b WHERE b.category_id = c.id) AS breed_count,
        (SELECT COUNT(*) FROM livestock l WHERE l.category_id = c.id) AS livestock_count
      FROM categories c ORDER BY c.sort_order ASC, c.name ASC`);
    res.json({ success: true, data: rows });
  } catch (error) {
    next(error);
  }
});

function categoryPayload(body, partial) {
  const name = text(body.name, 100);
  const description = text(body.description, 2000);
  const status = body.status === undefined ? undefined : oneOf(body.status, STATUSES);
  if (!partial && !name) throw badRequest("Category name is required.");
  if (name === undefined || (body.name !== undefined && !name))
    throw badRequest("Category name must be 1-100 characters.");
  if (description === undefined) throw badRequest("Description is too long.");
  if (status === null) throw badRequest("Invalid status.");
  const sortOrder = body.sort_order === undefined || body.sort_order === ""
    ? undefined
    : Number.parseInt(body.sort_order, 10);
  if (sortOrder !== undefined && !Number.isSafeInteger(sortOrder))
    throw badRequest("Sort order must be a whole number.");
  return { name, description, status, sort_order: sortOrder };
}

categories.post("/", async (req, res, next) => {
  try {
    const p = categoryPayload(req.body, false);
    const [result] = await pool.query(
      "INSERT INTO categories (name, description, status, sort_order) VALUES (?, ?, ?, ?)",
      [p.name, p.description, p.status || "active", p.sort_order ?? 0],
    );
    res.status(201).json({ success: true, data: { id: result.insertId } });
  } catch (error) {
    if (isDuplicate(error)) return next(badRequest("A category with that name already exists."));
    next(error);
  }
});

categories.put("/:id", async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id);
    const p = categoryPayload(req.body, true);
    const fields = [];
    const params = [];
    for (const key of ["name", "description", "status", "sort_order"]) {
      if (req.body[key] !== undefined) {
        fields.push(`${key} = ?`);
        params.push(p[key] ?? null);
      }
    }
    if (!fields.length) throw badRequest("Nothing to update.");
    const [result] = await pool.query(`UPDATE categories SET ${fields.join(", ")} WHERE id = ?`, [...params, id]);
    if (!result.affectedRows) throw notFound("Category not found.");
    res.json({ success: true });
  } catch (error) {
    if (isDuplicate(error)) return next(badRequest("A category with that name already exists."));
    next(error);
  }
});

categories.delete("/:id", async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id);
    const [result] = await pool.query("DELETE FROM categories WHERE id = ?", [id]);
    if (!result.affectedRows) throw notFound("Category not found.");
    res.json({ success: true });
  } catch (error) {
    if (isInUse(error)) {
      return next(badRequest(
        "This category still has breeds or livestock. Move or delete them first, or disable the category instead.",
      ));
    }
    next(error);
  }
});

// ---------------------------------------------------------------------------
// Breeds
// ---------------------------------------------------------------------------
const breeds = express.Router();

breeds.get("/", async (req, res, next) => {
  try {
    const categoryId = positiveInt(req.query.category_id);
    const [rows] = await pool.query(
      `SELECT b.*, c.name AS category_name,
         (SELECT COUNT(*) FROM livestock l WHERE l.breed_id = b.id) AS livestock_count
       FROM breeds b JOIN categories c ON c.id = b.category_id
       ${categoryId ? "WHERE b.category_id = ?" : ""}
       ORDER BY c.sort_order ASC, c.name ASC, b.name ASC`,
      categoryId ? [categoryId] : [],
    );
    res.json({ success: true, data: rows });
  } catch (error) {
    next(error);
  }
});

async function breedPayload(body, partial) {
  const name = text(body.name, 120);
  const description = text(body.description, 2000);
  const status = body.status === undefined ? undefined : oneOf(body.status, STATUSES);
  const categoryId = body.category_id === undefined ? undefined : positiveInt(body.category_id);
  if (!partial && (!name || !categoryId)) throw badRequest("Breed name and category are required.");
  if (name === undefined || (body.name !== undefined && !name))
    throw badRequest("Breed name must be 1-120 characters.");
  if (description === undefined) throw badRequest("Description is too long.");
  if (status === null) throw badRequest("Invalid status.");
  if (categoryId === null) throw badRequest("Please choose a category.");
  if (categoryId) {
    const [rows] = await pool.query("SELECT id FROM categories WHERE id = ?", [categoryId]);
    if (!rows.length) throw badRequest("That category does not exist.");
  }
  return { name, description, status, category_id: categoryId };
}

breeds.post("/", async (req, res, next) => {
  try {
    const p = await breedPayload(req.body, false);
    const [result] = await pool.query(
      "INSERT INTO breeds (category_id, name, description, status) VALUES (?, ?, ?, ?)",
      [p.category_id, p.name, p.description, p.status || "active"],
    );
    res.status(201).json({ success: true, data: { id: result.insertId } });
  } catch (error) {
    if (isDuplicate(error)) return next(badRequest("That breed already exists in this category."));
    next(error);
  }
});

breeds.put("/:id", async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id);
    const p = await breedPayload(req.body, true);

    // A breed's livestock must stay in the breed's category. Moving a breed
    // that is in use would silently break that, so block it.
    if (p.category_id) {
      const [[current]] = await pool.query(
        `SELECT b.category_id, (SELECT COUNT(*) FROM livestock l WHERE l.breed_id = b.id) AS used
         FROM breeds b WHERE b.id = ?`,
        [id],
      );
      if (!current) throw notFound("Breed not found.");
      if (current.category_id !== p.category_id && Number(current.used) > 0) {
        throw badRequest("This breed is used by livestock listings, so its category can't be changed.");
      }
    }

    const fields = [];
    const params = [];
    for (const key of ["name", "description", "status", "category_id"]) {
      if (req.body[key] !== undefined) {
        fields.push(`${key} = ?`);
        params.push(p[key] ?? null);
      }
    }
    if (!fields.length) throw badRequest("Nothing to update.");
    const [result] = await pool.query(`UPDATE breeds SET ${fields.join(", ")} WHERE id = ?`, [...params, id]);
    if (!result.affectedRows) throw notFound("Breed not found.");
    res.json({ success: true });
  } catch (error) {
    if (isDuplicate(error)) return next(badRequest("That breed already exists in this category."));
    next(error);
  }
});

breeds.delete("/:id", async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id);
    const [result] = await pool.query("DELETE FROM breeds WHERE id = ?", [id]);
    if (!result.affectedRows) throw notFound("Breed not found.");
    res.json({ success: true });
  } catch (error) {
    if (isInUse(error)) {
      return next(badRequest(
        "This breed is used by livestock listings. Change those listings first, or disable the breed instead.",
      ));
    }
    next(error);
  }
});

module.exports = { categories, breeds };
