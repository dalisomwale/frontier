const express = require("express");
const pool = require("../../db");
const { uploadImages, saveImage, deleteImageFiles, MAX_FILES } = require("../../middleware/upload");
const { sendEmail, appUrl } = require("../../services/mailer");
const { notifySeller } = require("../../services/notifications");
const { positiveInt, text, oneOf, badRequest, notFound, PROVINCES, isAllBreedsPurpose } = require("../../lib/validate");

const router = express.Router();
const STATUSES = ["published", "unpublished"];
const VERIFICATIONS = ["unverified", "verified"];

// Sets published_at when a listing becomes published (keeping the original
// date if it was already published) and clears it when unpublished. Must come
// before "status = ?" in an UPDATE, as MySQL applies assignments in order.
const PUBLISHED_AT_SQL =
  "published_at = CASE WHEN ? = 'published' THEN IF(status = 'published' AND published_at IS NOT NULL, published_at, NOW()) ELSE NULL END";
const MAX_PAGE_SIZE = 50;
const MAX_DESCRIPTION_WORDS = 50;
const countWords = (value) => (String(value).trim().match(/\S+/g) || []).length;

// Validates the listing fields and checks the hierarchy is consistent: the
// production purpose belongs to the chosen animal and the breed belongs to
// the purpose (so the public Animal -> Purpose -> Breed filter stays truthful).
async function payload(body) {
  const title = text(body.title, 200);
  const location = text(body.location, 150);
  const description = text(body.description, 5000);
  const categoryId = positiveInt(body.category_id);
  const breedId = body.breed_id === "" || body.breed_id === undefined ? null : positiveInt(body.breed_id);
  const animalId = body.animal_id === "" || body.animal_id === undefined ? null : positiveInt(body.animal_id);
  const sellerGiven = body.seller_id !== undefined;
  const sellerId = body.seller_id === "" || body.seller_id === undefined || body.seller_id === null ? null : positiveInt(body.seller_id);
  const type = text(body.livestock_type, 40);
  const status = oneOf(body.status || "unpublished", STATUSES);
  const verification = body.verification === undefined ? undefined : oneOf(body.verification, VERIFICATIONS);
  const quantity = body.quantity === "" || body.quantity === undefined ? 1 : positiveInt(body.quantity);
  const age = body.age_months === "" || body.age_months === undefined || body.age_months === null
    ? null
    : Number.parseInt(body.age_months, 10);

  const errors = {};
  let purposeRow = null;
  if (!title) errors.title = title === undefined ? "Title must be 200 characters or fewer." : "Title is required.";
  if (body.animal_id !== undefined && !animalId) errors.animal_id = "Please choose a category.";
  if (!categoryId) errors.category_id = "Please choose a production purpose.";
  if (body.breed_id && !breedId) errors.breed_id = "Please choose a valid breed.";
  if (sellerGiven && body.seller_id !== "" && body.seller_id !== null && !sellerId) errors.seller_id = "Please choose a valid seller.";
  if (!location) errors.location = "Please choose a province.";
  else if (!PROVINCES.includes(location)) errors.location = "Please choose one of Zambia's 10 provinces.";
  if (description === undefined) errors.description = "Description must be 5000 characters or fewer.";
  else if (description && countWords(description) > MAX_DESCRIPTION_WORDS)
    errors.description = `Description must be ${MAX_DESCRIPTION_WORDS} words or fewer (it has ${countWords(description)}).`;
  if (type === undefined) errors.livestock_type = "Type must be 40 characters or fewer.";
  if (!status) errors.status = "Invalid status.";
  if (verification === null || verification === "") errors.verification = "Invalid verification status.";
  if (!quantity || quantity > 100000) errors.quantity = "Quantity must be a whole number from 1.";
  if (age !== null && (!Number.isSafeInteger(age) || age < 0 || age > 600))
    errors.age_months = "Age must be between 0 and 600 months.";

  if (categoryId && !errors.category_id) {
    const [cats] = await pool.query("SELECT id, animal_id, name FROM categories WHERE id = ?", [categoryId]);
    purposeRow = cats[0];
    if (!cats.length) errors.category_id = "That production purpose does not exist.";
    else if (animalId && cats[0].animal_id !== animalId)
      errors.category_id = "That production purpose doesn't belong to the selected category.";
  }
  if (breedId && !errors.breed_id && !errors.category_id) {
    const [rows] = await pool.query(
      `SELECT b.category_id, c.animal_id FROM breeds b JOIN categories c ON c.id = b.category_id WHERE b.id = ?`,
      [breedId],
    );
    // A Dual-Purpose listing may use any breed of the same animal.
    const anyBreedOfAnimal = purposeRow && isAllBreedsPurpose(purposeRow.name);
    if (!rows.length) errors.breed_id = "That breed does not exist.";
    else if (anyBreedOfAnimal ? rows[0].animal_id !== purposeRow.animal_id : rows[0].category_id !== categoryId)
      errors.breed_id = anyBreedOfAnimal
        ? "That breed belongs to a different category."
        : "That breed doesn't belong to the selected production purpose.";
  }

  if (sellerId && !errors.seller_id) {
    const [sellers] = await pool.query("SELECT id FROM sellers WHERE id = ?", [sellerId]);
    if (!sellers.length) errors.seller_id = "That seller does not exist.";
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
    livestock_type: type || null,
    quantity,
    age_months: age,
    location,
    description,
    status,
    verification,
    seller_given: sellerGiven,
    seller_id: sellerId,
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

// Photo edits sent with a listing form: photos to remove
// ("remove_image_ids") and a new order ("image_order", the first is the cover).
function parsePhotoChanges(body) {
  try {
    return {
      removeIds: JSON.parse(body.remove_image_ids || "[]").map(Number).filter(Number.isSafeInteger),
      order: JSON.parse(body.image_order || "[]").map(Number).filter(Number.isSafeInteger),
    };
  } catch {
    throw badRequest("Invalid photo changes.");
  }
}

// Applies removals, reordering and new uploads inside the caller's
// transaction. Returns the files to delete once the transaction commits.
async function applyPhotoChanges(conn, id, { removeIds, order }, files) {
  const filesToDelete = [];
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
    await conn.query("UPDATE livestock_images SET sort_order = ? WHERE id = ? AND livestock_id = ?", [
      index,
      imageId,
      id,
    ]);
  }
  await storeImages(conn, id, files);
  return filesToDelete;
}

async function loadOne(id) {
  const [rows] = await pool.query(
    `SELECT l.*, c.animal_id, a.name AS animal_name, c.name AS category_name, b.name AS breed_name,
       s.name AS seller_name, s.business_name AS seller_business_name, s.phone AS seller_phone, s.status AS seller_status,
       s.account_status AS seller_account_status
     FROM livestock l JOIN categories c ON c.id = l.category_id
     JOIN animals a ON a.id = c.animal_id
     LEFT JOIN breeds b ON b.id = l.breed_id
     LEFT JOIN sellers s ON s.id = l.seller_id WHERE l.id = ?`,
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
    const animalId = positiveInt(req.query.animal_id);
    const categoryId = positiveInt(req.query.category_id);
    const sellerId = req.query.seller_id === "none" ? "none" : positiveInt(req.query.seller_id);
    const q = text(req.query.q, 100);
    const review = oneOf(req.query.review, ["pending", "rejected", "approved"]);
    if (review) {
      where.push("l.review_status = ?");
      params.push(review);
    }
    if (sellerId === "none") where.push("l.seller_id IS NULL");
    else if (sellerId) {
      where.push("l.seller_id = ?");
      params.push(sellerId);
    }
    if (animalId) {
      where.push("c.animal_id = ?");
      params.push(animalId);
    }
    if (status) {
      where.push("l.status = ?");
      params.push(status);
    }
    if (categoryId) {
      where.push("l.category_id = ?");
      params.push(categoryId);
    }
    if (q) {
      where.push("(l.title LIKE ? OR l.location LIKE ? OR b.name LIKE ? OR a.name LIKE ? OR c.name LIKE ? OR s.name LIKE ? OR s.business_name LIKE ?)");
      const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
      params.push(like, like, like, like, like, like, like);
    }
    const condition = where.join(" AND ");

    const [rows] = await pool.query(
      `SELECT l.id, l.title, l.status, l.published_at, l.verification, l.review_status, l.review_note, l.submitted_at,
         l.location, l.livestock_type, l.quantity,
         l.created_at, l.updated_at, a.name AS animal_name, c.name AS category_name, b.name AS breed_name,
         l.seller_id, s.name AS seller_name, s.business_name AS seller_business_name,
         (SELECT li.thumb_path FROM livestock_images li WHERE li.livestock_id = l.id
            ORDER BY li.sort_order, li.id LIMIT 1) AS thumb_path,
         (SELECT COUNT(*) FROM livestock_images li WHERE li.livestock_id = l.id) AS image_count,
         (SELECT COUNT(*) FROM inquiries i WHERE i.livestock_id = l.id) AS inquiry_count
       FROM livestock l JOIN categories c ON c.id = l.category_id
       JOIN animals a ON a.id = c.animal_id
       LEFT JOIN breeds b ON b.id = l.breed_id
       LEFT JOIN sellers s ON s.id = l.seller_id
       WHERE ${condition}
       ORDER BY l.created_at DESC, l.id DESC LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit],
    );
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM livestock l JOIN categories c ON c.id = l.category_id
       JOIN animals a ON a.id = c.animal_id LEFT JOIN breeds b ON b.id = l.breed_id
       LEFT JOIN sellers s ON s.id = l.seller_id WHERE ${condition}`,
      params,
    );
    const [[{ pending }]] = await pool.query("SELECT COUNT(*) AS pending FROM livestock WHERE review_status = 'pending'");
    res.json({
      success: true,
      data: rows,
      summary: { pending: Number(pending) },
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
         (title, category_id, breed_id, livestock_type, quantity, age_months, location, description, status,
          published_at, verification, seller_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, IF(? = 'published', NOW(), NULL), ?, ?, ?)`,
      [p.title, p.category_id, p.breed_id, p.livestock_type, p.quantity, p.age_months,
        p.location, p.description, p.status, p.status, p.verification || "unverified", p.seller_id, req.admin.id],
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
    const photoChanges = parsePhotoChanges(req.body);

    await conn.beginTransaction();
    await conn.query(
      `UPDATE livestock SET title = ?, category_id = ?, breed_id = ?, livestock_type = ?, quantity = ?,
         age_months = ?, location = ?, description = ?, ${PUBLISHED_AT_SQL}, status = ?,
         verification = COALESCE(?, verification),
         seller_id = IF(?, ?, seller_id),
         review_status = IF(? = 'published', 'approved', review_status),
         review_note = IF(? = 'published', NULL, review_note) WHERE id = ?`,
      [p.title, p.category_id, p.breed_id, p.livestock_type, p.quantity, p.age_months,
        p.location, p.description, p.status, p.status, p.verification ?? null,
        p.seller_given ? 1 : 0, p.seller_id, p.status, p.status, id],
    );
    filesToDelete.push(...(await applyPhotoChanges(conn, id, photoChanges, req.files)));
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
    const id = positiveInt(req.params.id);
    const [[before]] = await pool.query("SELECT title, status, seller_id FROM livestock WHERE id = ?", [id]);
    if (!before) throw notFound("Livestock listing not found.");
    // Choosing a status is the admin's decision, so it also settles any review.
    await pool.query(
      `UPDATE livestock SET ${PUBLISHED_AT_SQL}, status = ?, review_status = 'approved', review_note = NULL WHERE id = ?`,
      [status, status, id],
    );
    if (before.status !== status) {
      await notifySeller(before.seller_id, status === "published"
        ? { type: "listing", title: `Your listing is live: ${before.title}`, link: "/seller/" }
        : { type: "listing", title: `Your listing was taken off the website: ${before.title}`, body: "Contact Frontier if you have questions.", link: "/seller/" });
    }
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

router.patch("/:id/verification", async (req, res, next) => {
  try {
    const verification = oneOf(req.body.verification, VERIFICATIONS);
    if (!verification) throw badRequest("Verification must be verified or unverified.");
    const [result] = await pool.query("UPDATE livestock SET verification = ? WHERE id = ?", [
      verification,
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
    const [[listing]] = await pool.query("SELECT title, seller_id FROM livestock WHERE id = ?", [id]);
    // Images cascade in the DB; inquiries keep their copied title (FK SET NULL).
    const [result] = await pool.query("DELETE FROM livestock WHERE id = ?", [id]);
    if (!result.affectedRows) throw notFound("Livestock listing not found.");
    await notifySeller(listing.seller_id, { type: "listing", title: `Your listing was removed: ${listing.title}`, body: "Contact Frontier if you have questions.", link: "/seller/" });
    images.forEach((row) => deleteImageFiles(row.image_path, row.thumb_path));
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

// Review of listings submitted by sellers: approve (verified and published)
// or send back with a note. The seller is emailed either way.
router.post("/:id/review", async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id);
    const action = oneOf(req.body.action, ["approve", "reject"]);
    if (!action) throw badRequest("Choose approve or reject.");
    const note = text(req.body.note, 500);
    if (note === undefined) throw badRequest("The note must be 500 characters or fewer.");
    if (action === "reject" && !note) throw badRequest("Please say what the seller needs to change.");
    const [[row]] = await pool.query(
      `SELECT l.id, l.title, l.seller_id, s.email AS seller_email, s.name AS seller_name, s.password_hash IS NOT NULL AS has_account
       FROM livestock l LEFT JOIN sellers s ON s.id = l.seller_id WHERE l.id = ?`,
      [id],
    );
    if (!row) throw notFound("Livestock listing not found.");
    if (action === "approve") {
      await pool.query(
        `UPDATE livestock SET ${PUBLISHED_AT_SQL}, status = 'published', verification = 'verified',
           review_status = 'approved', review_note = NULL WHERE id = ?`,
        ["published", id],
      );
    } else {
      await pool.query(
        `UPDATE livestock SET published_at = NULL, status = 'unpublished',
           review_status = 'rejected', review_note = ? WHERE id = ?`,
        [note, id],
      );
    }
    await notifySeller(row.seller_id, action === "approve"
      ? { type: "listing", title: `Your listing is live: ${row.title}`, body: note || null, link: "/seller/" }
      : { type: "listing", title: `Changes needed: ${row.title}`, body: note, link: "/seller/" });
    let emailed = false;
    if (row.seller_email && row.has_account) {
      const result = await sendEmail({
        to: row.seller_email,
        subject: action === "approve" ? `Your listing is live: ${row.title}` : `Changes needed: ${row.title}`,
        heading: action === "approve" ? "Your listing is live" : "Your listing needs changes",
        paragraphs: action === "approve"
          ? [`Hi ${row.seller_name},`, `"${row.title}" has been approved and is now live on Frontier Marketplace.`, ...(note ? [note] : [])]
          : [`Hi ${row.seller_name},`, `"${row.title}" was not approved yet. Please update it and submit it again.`, note],
        button: { label: "Open my dashboard", url: appUrl("/seller/") },
      });
      emailed = result.sent;
    }
    res.json({ success: true, data: await loadOne(id), emailed });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
module.exports.helpers = { payload, parsePhotoChanges, applyPhotoChanges, storeImages, loadOne, PUBLISHED_AT_SQL };
