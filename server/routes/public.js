// Public, read-only livestock API. Everything here only ever exposes
// published livestock whose animal, production purpose and breed are active.
// All filtering is done in MySQL (indexed columns), never by shipping the
// table to the browser.
//
// Taxonomy: Animal Category (animals) -> Production Purpose (categories)
//           -> Breed / Strain (breeds). A listing points at its purpose and
//           breed; the animal comes from the purpose.
const express = require("express");
const pool = require("../db");
const { positiveInt, text, notFound, PROVINCES, isAllBreedsPurpose } = require("../lib/validate");

const router = express.Router();
const MAX_PAGE_SIZE = 48;

// Visibility rule shared by every public query.
const VISIBLE = `l.status = 'published' AND c.status = 'active' AND a.status = 'active'
  AND (l.breed_id IS NULL OR b.status = 'active')`;
const FROM = `FROM livestock l
  JOIN categories c ON c.id = l.category_id
  JOIN animals a ON a.id = c.animal_id
  LEFT JOIN breeds b ON b.id = l.breed_id`;

// Cascading filter order. `upTo` limits which filters apply, so each
// dropdown's counts only depend on the selections made before it.
const FILTER_ORDER = ["animal", "purpose", "breed", "location"];

function readFilters(query) {
  return {
    animal: positiveInt(query.animal_id),
    purpose: positiveInt(query.category_id),
    breed: positiveInt(query.breed_id),
    location: text(query.location, 150) || null,
  };
}

function buildWhere(filters, upTo = "location") {
  const where = [VISIBLE];
  const params = [];
  const limit = FILTER_ORDER.indexOf(upTo);
  const active = (name) => FILTER_ORDER.indexOf(name) <= limit;

  if (active("animal") && filters.animal) {
    where.push("c.animal_id = ?");
    params.push(filters.animal);
  }
  if (active("purpose") && filters.purpose) {
    where.push("l.category_id = ?");
    params.push(filters.purpose);
  }
  if (active("breed") && filters.breed) {
    where.push("l.breed_id = ?");
    params.push(filters.breed);
  }
  if (active("location") && filters.location) {
    where.push("l.location = ?");
    params.push(filters.location);
  }
  return { sql: where.join(" AND "), params };
}

// Animal categories for the homepage tiles, chips and first dropdown, with
// live counts. Tiles use the photo uploaded in the admin (image_path), else
// a cover photo taken from a real listing (cover_image).
// The outer table is aliased `an` because FROM/VISIBLE already use `a`.
router.get("/animals", async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT an.id, an.name, an.description, an.image_path,
         (SELECT COUNT(*) FROM categories cc
            WHERE cc.animal_id = an.id AND cc.status = 'active') AS purpose_count,
         (SELECT COUNT(*) ${FROM} WHERE ${VISIBLE} AND c.animal_id = an.id) AS livestock_count,
         (SELECT li.thumb_path ${FROM}
            JOIN livestock_images li ON li.livestock_id = l.id
            WHERE ${VISIBLE} AND c.animal_id = an.id
            ORDER BY l.created_at DESC, li.sort_order ASC, li.id ASC LIMIT 1) AS cover_image
       FROM animals an
       WHERE an.status = 'active'
       ORDER BY an.sort_order ASC, an.name ASC`,
    );
    res.json({ success: true, data: rows });
  } catch (error) {
    next(error);
  }
});

// Production purposes (optionally for one animal) - the homepage shows them
// as photo tiles once an animal is chosen, each sliding through `photos`
// (uploaded in the admin). `listing_photos` are recent photos from that
// purpose's listings, used when no photos have been uploaded yet.
const LISTING_PHOTOS_PER_PURPOSE = 4;

router.get("/categories", async (req, res, next) => {
  try {
    const animalId = positiveInt(req.query.animal_id);
    const [rows] = await pool.query(
      `SELECT cat.id, cat.name, cat.description, cat.animal_id,
         an.name AS animal_name, an.image_path AS animal_image_path,
         (SELECT COUNT(*) FROM breeds bb WHERE bb.category_id = cat.id AND bb.status = 'active') AS breed_count,
         (SELECT COUNT(*) ${FROM} WHERE ${VISIBLE} AND l.category_id = cat.id) AS livestock_count
       FROM categories cat JOIN animals an ON an.id = cat.animal_id
       WHERE cat.status = 'active' AND an.status = 'active' ${animalId ? "AND cat.animal_id = ?" : ""}
       ORDER BY an.sort_order ASC, cat.sort_order ASC, cat.name ASC`,
      animalId ? [animalId] : [],
    );

    const ids = rows.map((row) => row.id);
    const photos = new Map(ids.map((id) => [id, []]));
    const listingPhotos = new Map(ids.map((id) => [id, []]));
    if (ids.length) {
      const [uploaded] = await pool.query(
        `SELECT category_id, image_path FROM category_images
         WHERE category_id IN (?) ORDER BY sort_order ASC, id ASC`,
        [ids],
      );
      uploaded.forEach((row) => photos.get(row.category_id).push(row.image_path));

      // The cover photo of each published listing, newest first.
      const [fromListings] = await pool.query(
        `SELECT l.category_id, li.thumb_path ${FROM}
         JOIN livestock_images li ON li.id = (
           SELECT li2.id FROM livestock_images li2 WHERE li2.livestock_id = l.id
           ORDER BY li2.sort_order ASC, li2.id ASC LIMIT 1)
         WHERE ${VISIBLE} AND l.category_id IN (?)
         ORDER BY l.created_at DESC, l.id DESC`,
        [ids],
      );
      fromListings.forEach((row) => {
        const list = listingPhotos.get(row.category_id);
        if (list.length < LISTING_PHOTOS_PER_PURPOSE) list.push(row.thumb_path);
      });
    }

    res.json({
      success: true,
      data: rows.map((row) => ({ ...row, photos: photos.get(row.id), listing_photos: listingPhotos.get(row.id) })),
    });
  } catch (error) {
    next(error);
  }
});

// Options for the dependent dropdowns:
//  - purposes:  active production purposes of the chosen animal (none until
//               an animal is chosen), with published-listing counts
//  - breeds:    active breeds of the chosen purpose (none until a purpose is
//               chosen), with counts - so visitors never see a breed that
//               doesn't belong to the animal and purpose they picked
//  - locations: all 10 provinces, with counts for the choices made so far
router.get("/livestock/filters", async (req, res, next) => {
  try {
    const filters = readFilters(req.query);

    let purposes = [];
    if (filters.animal) {
      [purposes] = await pool.query(
        `SELECT cat.id, cat.name,
           (SELECT COUNT(*) ${FROM} WHERE ${VISIBLE} AND l.category_id = cat.id) AS count
         FROM categories cat JOIN animals an ON an.id = cat.animal_id
         WHERE cat.animal_id = ? AND cat.status = 'active' AND an.status = 'active'
         ORDER BY cat.sort_order ASC, cat.name ASC`,
        [filters.animal],
      );
    }

    // Only list breeds when the chosen purpose really belongs to the chosen
    // animal, so a stale or hand-edited URL can't mix them up.
    //
    // Dual-Purpose lists every active breed of the animal, grouped by the
    // purpose each breed belongs to (its own breeds first). Counts are always
    // listings in the chosen purpose with that breed.
    let breeds = [];
    const purpose = filters.animal && filters.purpose && purposes.find((p) => p.id === filters.purpose);
    if (purpose && isAllBreedsPurpose(purpose.name)) {
      [breeds] = await pool.query(
        `SELECT bb.id, bb.name, cc.name AS group_name,
           (SELECT COUNT(*) ${FROM} WHERE ${VISIBLE} AND l.breed_id = bb.id AND l.category_id = ?) AS count
         FROM breeds bb JOIN categories cc ON cc.id = bb.category_id
         WHERE cc.animal_id = ? AND bb.status = 'active' AND cc.status = 'active'
         ORDER BY (cc.id = ?) DESC, cc.sort_order ASC, cc.name ASC, bb.name ASC`,
        [purpose.id, filters.animal, purpose.id],
      );
    } else if (purpose) {
      [breeds] = await pool.query(
        `SELECT bb.id, bb.name,
           (SELECT COUNT(*) ${FROM} WHERE ${VISIBLE} AND l.breed_id = bb.id AND l.category_id = ?) AS count
         FROM breeds bb
         WHERE bb.category_id = ? AND bb.status = 'active'
         ORDER BY bb.name ASC`,
        [purpose.id, purpose.id],
      );
    }

    const locationWhere = buildWhere(filters, "breed");
    const [locationCounts] = await pool.query(
      `SELECT l.location AS value, COUNT(*) AS count ${FROM}
       WHERE ${locationWhere.sql}
       GROUP BY l.location`,
      locationWhere.params,
    );
    const counts = new Map(locationCounts.map((row) => [row.value, Number(row.count)]));
    const locations = PROVINCES.map((value) => ({ value, count: counts.get(value) || 0 }));

    const num = (rows) => rows.map((row) => ({ ...row, count: Number(row.count) }));
    res.json({ success: true, data: { purposes: num(purposes), breeds: num(breeds), locations } });
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
         c.animal_id, a.name AS animal_name,
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
         l.description, c.animal_id, a.name AS animal_name,
         l.category_id, c.name AS category_name,
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
