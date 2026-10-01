// Public, read-only livestock API. Everything here only ever exposes
// published livestock in active categories/breeds. All filtering is done in
// MySQL (indexed columns), never by shipping the table to the browser.
const express = require("express");
const pool = require("../db");
const { positiveInt, text, oneOf, notFound } = require("../lib/validate");

const router = express.Router();

const LIVESTOCK_TYPES = ["Bull", "Cow", "Heifer", "Steer", "Calf", "Mixed"];
const MAX_PAGE_SIZE = 48;

// Visibility rule shared by every public query.
const VISIBLE = `l.status = 'published' AND c.status = 'active'
  AND (l.breed_id IS NULL OR b.status = 'active')`;
const FROM = `FROM livestock l
  JOIN categories c ON c.id = l.category_id
  LEFT JOIN breeds b ON b.id = l.breed_id`;

// Reads the cascading filter values from the query string. `upTo` limits
// which filters are applied, so each dropdown's options only depend on the
// selections made *before* it (Category -> Breed -> Type -> Location).
const FILTER_ORDER = ["category", "breed", "type", "location"];

function readFilters(query) {
  return {
    category: positiveInt(query.category_id),
    breed: positiveInt(query.breed_id),
    type: oneOf(query.type, LIVESTOCK_TYPES),
    location: text(query.location, 150) || null,
  };
}

function buildWhere(filters, upTo = "location") {
  const where = [VISIBLE];
  const params = [];
  const limit = FILTER_ORDER.indexOf(upTo);
  const active = (name) => FILTER_ORDER.indexOf(name) <= limit;

  if (active("category") && filters.category) {
    where.push("l.category_id = ?");
    params.push(filters.category);
  }
  if (active("breed") && filters.breed) {
    where.push("l.breed_id = ?");
    params.push(filters.breed);
  }
  if (active("type") && filters.type) {
    where.push("l.livestock_type = ?");
    params.push(filters.type);
  }
  if (active("location") && filters.location) {
    where.push("l.location = ?");
    params.push(filters.location);
  }
  return { sql: where.join(" AND "), params };
}

// Categories for the filter + "Explore Categories" section, with live counts
// and a cover photo taken from a real listing when one exists.
router.get("/categories", async (req, res, next) => {
  try {
    // Outer table is aliased `cat` because the shared FROM/VISIBLE snippets
    // already use `c` for the listing's own category.
    const [rows] = await pool.query(
      `SELECT cat.id, cat.name, cat.description,
         (SELECT COUNT(*) FROM breeds bb WHERE bb.category_id = cat.id AND bb.status = 'active') AS breed_count,
         (SELECT COUNT(*) ${FROM} WHERE ${VISIBLE} AND l.category_id = cat.id) AS livestock_count,
         (SELECT li.thumb_path ${FROM}
            JOIN livestock_images li ON li.livestock_id = l.id
            WHERE ${VISIBLE} AND l.category_id = cat.id
            ORDER BY l.created_at DESC, li.sort_order ASC, li.id ASC LIMIT 1) AS cover_image
       FROM categories cat
       WHERE cat.status = 'active'
       ORDER BY cat.sort_order ASC, cat.name ASC`,
    );
    res.json({ success: true, data: rows });
  } catch (error) {
    next(error);
  }
});

// Options for the dependent dropdowns.
//  - breeds:    every active breed in the chosen category (all categories if
//               none chosen), with how many published listings each has
//  - types:     livestock types present among listings matching category+breed
//  - locations: locations present among listings matching category+breed+type
router.get("/livestock/filters", async (req, res, next) => {
  try {
    const filters = readFilters(req.query);

    const breedParams = [];
    let breedWhere = "b.status = 'active' AND c.status = 'active'";
    if (filters.category) {
      breedWhere += " AND b.category_id = ?";
      breedParams.push(filters.category);
    }
    const [breeds] = await pool.query(
      `SELECT b.id, b.name, b.category_id, c.name AS category_name,
         (SELECT COUNT(*) FROM livestock l
            WHERE l.breed_id = b.id AND l.status = 'published') AS count
       FROM breeds b JOIN categories c ON c.id = b.category_id
       WHERE ${breedWhere}
       ORDER BY c.sort_order ASC, b.name ASC`,
      breedParams,
    );

    const typeWhere = buildWhere(filters, "breed");
    const [types] = await pool.query(
      `SELECT l.livestock_type AS value, COUNT(*) AS count ${FROM}
       WHERE ${typeWhere.sql} AND l.livestock_type IS NOT NULL
       GROUP BY l.livestock_type ORDER BY FIELD(l.livestock_type, ${LIVESTOCK_TYPES.map(() => "?").join(",")})`,
      [...typeWhere.params, ...LIVESTOCK_TYPES],
    );

    const locationWhere = buildWhere(filters, "type");
    const [locations] = await pool.query(
      `SELECT l.location AS value, COUNT(*) AS count ${FROM}
       WHERE ${locationWhere.sql}
       GROUP BY l.location ORDER BY l.location ASC`,
      locationWhere.params,
    );

    res.json({ success: true, data: { breeds, types, locations } });
  } catch (error) {
    next(error);
  }
});

router.get("/livestock", async (req, res, next) => {
  try {
    const page = positiveInt(req.query.page, 1);
    const limit = Math.min(positiveInt(req.query.limit, 12), MAX_PAGE_SIZE);
    const offset = (page - 1) * limit;
    const exclude = positiveInt(req.query.exclude);

    const where = buildWhere(readFilters(req.query));
    if (exclude) {
      where.sql += " AND l.id <> ?";
      where.params.push(exclude);
    }

    const [rows] = await pool.query(
      `SELECT l.id, l.title, l.location, l.livestock_type, l.quantity, l.description,
         l.category_id, c.name AS category_name, l.breed_id, b.name AS breed_name,
         l.created_at,
         img.thumb_path, img.image_path
       ${FROM}
       LEFT JOIN livestock_images img ON img.id = (
         SELECT li.id FROM livestock_images li WHERE li.livestock_id = l.id
         ORDER BY li.sort_order ASC, li.id ASC LIMIT 1)
       WHERE ${where.sql}
       ORDER BY l.created_at DESC, l.id DESC
       LIMIT ? OFFSET ?`,
      [...where.params, limit, offset],
    );
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total ${FROM} WHERE ${where.sql}`,
      where.params,
    );

    res.json({
      success: true,
      data: rows.map((row) => ({
        ...row,
        description: row.description ? row.description.slice(0, 240) : null,
      })),
      pagination: {
        current: page,
        total: Math.max(1, Math.ceil(total / limit)),
        perPage: limit,
        totalItems: Number(total),
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get("/livestock/:id", async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id);
    if (!id) throw notFound("Livestock listing not found.");

    const [rows] = await pool.query(
      `SELECT l.id, l.title, l.location, l.livestock_type, l.quantity, l.age_months,
         l.description, l.category_id, c.name AS category_name,
         l.breed_id, b.name AS breed_name, l.created_at, l.updated_at
       ${FROM} WHERE l.id = ? AND ${VISIBLE}`,
      [id],
    );
    if (!rows.length) throw notFound("This listing is not available.");

    const [images] = await pool.query(
      `SELECT id, image_path, thumb_path FROM livestock_images
       WHERE livestock_id = ? ORDER BY sort_order ASC, id ASC`,
      [id],
    );
    res.json({ success: true, data: { ...rows[0], images } });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
module.exports.LIVESTOCK_TYPES = LIVESTOCK_TYPES;
