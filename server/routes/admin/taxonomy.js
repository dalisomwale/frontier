const express = require("express");
const pool = require("../../db");
const { positiveInt, text, oneOf, badRequest, notFound } = require("../../lib/validate");
const { uploadSingleImage, saveTaxonomyImage, deleteTaxonomyImage } = require("../../middleware/upload");

const STATUSES = ["active", "disabled"];

// Admin CRUD for the taxonomy:
//   animals     Animal Category (Cattle, Goats, ...)
//   categories  Production Purpose, each belonging to one animal
//   breeds      Breed / Strain, each belonging to one production purpose
function isDuplicate(error) {
  return error && error.code === "ER_DUP_ENTRY";
}
function isInUse(error) {
  return error && (error.code === "ER_ROW_IS_REFERENCED_2" || error.code === "ER_ROW_IS_REFERENCED");
}

// Display order isn't edited in the admin; new items simply go last.
async function nextSortOrder(table, where = "1 = 1", params = []) {
  const [[{ next }]] = await pool.query(
    `SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM ${table} WHERE ${where}`,
    params,
  );
  return Number(next);
}

// Photo routes shared by animals and production purposes:
//   POST   /:id/photo   multipart field "image" - adds or replaces the photo
//   DELETE /:id/photo   removes it
// The website tile falls back to a listing photo or a stock photo when none.
function photoRoutes(router, table, prefix, label) {
  router.post("/:id/photo", uploadSingleImage, async (req, res, next) => {
    try {
      const id = positiveInt(req.params.id);
      if (!req.file) throw badRequest("Please choose a photo to upload.");
      const [[row]] = await pool.query(`SELECT image_path FROM ${table} WHERE id = ?`, [id]);
      if (!row) throw notFound(`${label} not found.`);
      const imagePath = await saveTaxonomyImage(req.file.buffer, prefix);
      await pool.query(`UPDATE ${table} SET image_path = ? WHERE id = ?`, [imagePath, id]);
      deleteTaxonomyImage(row.image_path);
      res.json({ success: true, data: { image_path: imagePath } });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/:id/photo", async (req, res, next) => {
    try {
      const id = positiveInt(req.params.id);
      const [[row]] = await pool.query(`SELECT image_path FROM ${table} WHERE id = ?`, [id]);
      if (!row) throw notFound(`${label} not found.`);
      await pool.query(`UPDATE ${table} SET image_path = NULL WHERE id = ?`, [id]);
      deleteTaxonomyImage(row.image_path);
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  });
}

// ---------------------------------------------------------------------------
// Animals
// ---------------------------------------------------------------------------
const animals = express.Router();

animals.get("/", async (req, res, next) => {
  try {
    const [rows] = await pool.query(`
      SELECT an.*,
        (SELECT COUNT(*) FROM categories c WHERE c.animal_id = an.id) AS purpose_count,
        (SELECT COUNT(*) FROM breeds b JOIN categories c ON c.id = b.category_id WHERE c.animal_id = an.id) AS breed_count,
        (SELECT COUNT(*) FROM livestock l JOIN categories c ON c.id = l.category_id WHERE c.animal_id = an.id) AS livestock_count
      FROM animals an ORDER BY an.sort_order ASC, an.name ASC`);
    res.json({ success: true, data: rows });
  } catch (error) {
    next(error);
  }
});

function animalPayload(body, partial) {
  const name = text(body.name, 100);
  const description = text(body.description, 2000);
  const status = body.status === undefined ? undefined : oneOf(body.status, STATUSES);
  if (!partial && !name) throw badRequest("Animal name is required.");
  if (name === undefined || (body.name !== undefined && !name))
    throw badRequest("Animal name must be 1-100 characters.");
  if (description === undefined) throw badRequest("Description is too long.");
  if (status === null) throw badRequest("Invalid status.");
  return { name, description, status };
}

animals.post("/", async (req, res, next) => {
  try {
    const p = animalPayload(req.body, false);
    const [result] = await pool.query(
      "INSERT INTO animals (name, description, status, sort_order) VALUES (?, ?, ?, ?)",
      [p.name, p.description, p.status || "active", await nextSortOrder("animals")],
    );
    res.status(201).json({ success: true, data: { id: result.insertId } });
  } catch (error) {
    if (isDuplicate(error)) return next(badRequest("An animal with that name already exists."));
    next(error);
  }
});

animals.put("/:id", async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id);
    const p = animalPayload(req.body, true);
    const fields = [];
    const params = [];
    for (const key of ["name", "description", "status"]) {
      if (req.body[key] !== undefined) {
        fields.push(`${key} = ?`);
        params.push(p[key] ?? null);
      }
    }
    if (!fields.length) throw badRequest("Nothing to update.");
    const [result] = await pool.query(`UPDATE animals SET ${fields.join(", ")} WHERE id = ?`, [...params, id]);
    if (!result.affectedRows) throw notFound("Animal not found.");
    res.json({ success: true });
  } catch (error) {
    if (isDuplicate(error)) return next(badRequest("An animal with that name already exists."));
    next(error);
  }
});

animals.delete("/:id", async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id);
    const [[row]] = await pool.query("SELECT image_path FROM animals WHERE id = ?", [id]);
    const [result] = await pool.query("DELETE FROM animals WHERE id = ?", [id]);
    if (!result.affectedRows) throw notFound("Animal not found.");
    deleteTaxonomyImage(row?.image_path);
    res.json({ success: true });
  } catch (error) {
    if (isInUse(error)) {
      return next(badRequest(
        "This animal still has production purposes. Delete or move them first, or disable the animal instead.",
      ));
    }
    next(error);
  }
});

photoRoutes(animals, "animals", "animal", "Animal");

// ---------------------------------------------------------------------------
// Production purposes (table: categories)
// ---------------------------------------------------------------------------
const categories = express.Router();

categories.get("/", async (req, res, next) => {
  try {
    const animalId = positiveInt(req.query.animal_id);
    const [rows] = await pool.query(
      `SELECT c.*, an.name AS animal_name,
        (SELECT COUNT(*) FROM breeds b WHERE b.category_id = c.id) AS breed_count,
        (SELECT COUNT(*) FROM livestock l WHERE l.category_id = c.id) AS livestock_count
      FROM categories c JOIN animals an ON an.id = c.animal_id
      ${animalId ? "WHERE c.animal_id = ?" : ""}
      ORDER BY an.sort_order ASC, an.name ASC, c.sort_order ASC, c.name ASC`,
      animalId ? [animalId] : [],
    );
    res.json({ success: true, data: rows });
  } catch (error) {
    next(error);
  }
});

async function categoryPayload(body, partial) {
  const name = text(body.name, 100);
  const description = text(body.description, 2000);
  const status = body.status === undefined ? undefined : oneOf(body.status, STATUSES);
  const animalId = body.animal_id === undefined ? undefined : positiveInt(body.animal_id);
  if (!partial && (!name || !animalId)) throw badRequest("Purpose name and animal are required.");
  if (name === undefined || (body.name !== undefined && !name))
    throw badRequest("Purpose name must be 1-100 characters.");
  if (description === undefined) throw badRequest("Description is too long.");
  if (status === null) throw badRequest("Invalid status.");
  if (animalId === null) throw badRequest("Please choose an animal.");
  if (animalId) {
    const [rows] = await pool.query("SELECT id FROM animals WHERE id = ?", [animalId]);
    if (!rows.length) throw badRequest("That animal does not exist.");
  }
  return { name, description, status, animal_id: animalId };
}

categories.post("/", async (req, res, next) => {
  try {
    const p = await categoryPayload(req.body, false);
    const [result] = await pool.query(
      "INSERT INTO categories (animal_id, name, description, status, sort_order) VALUES (?, ?, ?, ?, ?)",
      [p.animal_id, p.name, p.description, p.status || "active", await nextSortOrder("categories", "animal_id = ?", [p.animal_id])],
    );
    res.status(201).json({ success: true, data: { id: result.insertId } });
  } catch (error) {
    if (isDuplicate(error)) return next(badRequest("That animal already has a purpose with this name."));
    next(error);
  }
});

categories.put("/:id", async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id);
    const p = await categoryPayload(req.body, true);

    // Moving a purpose that has listings to another animal would mislabel
    // those listings, so block it.
    if (p.animal_id) {
      const [[current]] = await pool.query(
        `SELECT c.animal_id, (SELECT COUNT(*) FROM livestock l WHERE l.category_id = c.id) AS used
         FROM categories c WHERE c.id = ?`,
        [id],
      );
      if (!current) throw notFound("Production purpose not found.");
      if (current.animal_id !== p.animal_id && Number(current.used) > 0) {
        throw badRequest("This purpose is used by livestock listings, so its animal can't be changed.");
      }
    }

    const fields = [];
    const params = [];
    for (const key of ["animal_id", "name", "description", "status"]) {
      if (req.body[key] !== undefined) {
        fields.push(`${key} = ?`);
        params.push(p[key] ?? null);
      }
    }
    if (!fields.length) throw badRequest("Nothing to update.");
    const [result] = await pool.query(`UPDATE categories SET ${fields.join(", ")} WHERE id = ?`, [...params, id]);
    if (!result.affectedRows) throw notFound("Production purpose not found.");
    res.json({ success: true });
  } catch (error) {
    if (isDuplicate(error)) return next(badRequest("That animal already has a purpose with this name."));
    next(error);
  }
});

categories.delete("/:id", async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id);
    const [[row]] = await pool.query("SELECT image_path FROM categories WHERE id = ?", [id]);
    const [result] = await pool.query("DELETE FROM categories WHERE id = ?", [id]);
    if (!result.affectedRows) throw notFound("Production purpose not found.");
    deleteTaxonomyImage(row?.image_path);
    res.json({ success: true });
  } catch (error) {
    if (isInUse(error)) {
      return next(badRequest(
        "This purpose still has breeds or livestock. Move or delete them first, or disable the purpose instead.",
      ));
    }
    next(error);
  }
});

photoRoutes(categories, "categories", "purpose", "Production purpose");

// ---------------------------------------------------------------------------
// Breeds
// ---------------------------------------------------------------------------
const breeds = express.Router();

breeds.get("/", async (req, res, next) => {
  try {
    const categoryId = positiveInt(req.query.category_id);
    const animalId = positiveInt(req.query.animal_id);
    const where = [];
    const params = [];
    if (categoryId) {
      where.push("b.category_id = ?");
      params.push(categoryId);
    }
    if (animalId) {
      where.push("c.animal_id = ?");
      params.push(animalId);
    }
    const [rows] = await pool.query(
      `SELECT b.*, c.name AS category_name, c.animal_id, an.name AS animal_name,
         (SELECT COUNT(*) FROM livestock l WHERE l.breed_id = b.id) AS livestock_count
       FROM breeds b JOIN categories c ON c.id = b.category_id
       JOIN animals an ON an.id = c.animal_id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY an.sort_order ASC, an.name ASC, c.sort_order ASC, c.name ASC, b.name ASC`,
      params,
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
  if (!partial && (!name || !categoryId)) throw badRequest("Breed name and production purpose are required.");
  if (name === undefined || (body.name !== undefined && !name))
    throw badRequest("Breed name must be 1-120 characters.");
  if (description === undefined) throw badRequest("Description is too long.");
  if (status === null) throw badRequest("Invalid status.");
  if (categoryId === null) throw badRequest("Please choose a production purpose.");
  if (categoryId) {
    const [rows] = await pool.query("SELECT id FROM categories WHERE id = ?", [categoryId]);
    if (!rows.length) throw badRequest("That production purpose does not exist.");
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
    if (isDuplicate(error)) return next(badRequest("That breed already exists for this production purpose."));
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
        throw badRequest("This breed is used by livestock listings, so its production purpose can't be changed.");
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
    if (isDuplicate(error)) return next(badRequest("That breed already exists for this production purpose."));
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

module.exports = { animals, categories, breeds };
