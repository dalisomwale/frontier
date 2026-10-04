// Sellers: the farmers and suppliers whose livestock Frontier lists. Admin
// only. Visitors never see sellers - every inquiry comes to Frontier, and the
// listing it was sent from tells the team which seller it is for.
const express = require("express");
const pool = require("../../db");
const { positiveInt, text, isEmail, isPhone, oneOf, badRequest, notFound, HttpError, PROVINCES } = require("../../lib/validate");

const router = express.Router();
const STATUSES = ["active", "inactive"];

function payload(body) {
  const name = text(body.name, 120);
  const businessName = text(body.business_name, 150);
  const phone = text(body.phone, 30);
  const email = text(body.email, 255);
  const province = text(body.province, 50);
  const address = text(body.address, 255);
  const notes = text(body.notes, 2000);
  const status = oneOf(body.status || "active", STATUSES);

  const errors = {};
  if (!name) errors.name = name === undefined ? "Name must be 120 characters or fewer." : "Name is required.";
  else if (name.length < 2) errors.name = "Please enter the seller's full name.";
  if (businessName === undefined) errors.business_name = "Business name must be 150 characters or fewer.";
  if (!phone) errors.phone = "Phone number is required.";
  else if (!isPhone(phone)) errors.phone = "Please enter a valid phone number, e.g. 0977 123 456 or +260 977 123 456.";
  if (email === undefined || (email && !isEmail(email))) errors.email = "Please enter a valid email address.";
  if (province === undefined || (province && !PROVINCES.includes(province)))
    errors.province = "Please choose one of Zambia's 10 provinces.";
  if (address === undefined) errors.address = "Address must be 255 characters or fewer.";
  if (notes === undefined) errors.notes = "Notes must be 2000 characters or fewer.";
  if (!status) errors.status = "Invalid status.";

  if (Object.keys(errors).length) {
    const error = new HttpError(422, "Please correct the highlighted fields.");
    error.errors = errors;
    throw error;
  }
  return { name, business_name: businessName, phone, email, province, address, notes, status };
}

const COUNTS = `
  (SELECT COUNT(*) FROM livestock l WHERE l.seller_id = s.id) AS listing_count,
  (SELECT COUNT(*) FROM livestock l WHERE l.seller_id = s.id AND l.status = 'published') AS published_count,
  (SELECT COUNT(*) FROM inquiries i WHERE i.seller_id = s.id) AS inquiry_count,
  (SELECT COUNT(*) FROM inquiries i WHERE i.seller_id = s.id AND i.status = 'new' AND i.is_archived = 0) AS new_inquiry_count`;

router.get("/", async (req, res, next) => {
  try {
    const where = ["1 = 1"];
    const params = [];
    const status = oneOf(req.query.status, STATUSES);
    if (status) {
      where.push("s.status = ?");
      params.push(status);
    }
    const q = text(req.query.q, 100);
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
      where.push("(s.name LIKE ? OR s.business_name LIKE ? OR s.phone LIKE ? OR s.email LIKE ? OR s.province LIKE ?)");
      params.push(like, like, like, like, like);
    }
    const [rows] = await pool.query(
      `SELECT s.*, ${COUNTS} FROM sellers s WHERE ${where.join(" AND ")} ORDER BY s.name, s.id`,
      params,
    );
    const [[summary]] = await pool.query(
      `SELECT COUNT(*) AS total, COALESCE(SUM(status = 'active'), 0) AS active, COALESCE(SUM(status = 'inactive'), 0) AS inactive
       FROM sellers`,
    );
    res.json({
      success: true,
      data: rows,
      summary: { all: Number(summary.total), active: Number(summary.active), inactive: Number(summary.inactive) },
    });
  } catch (error) {
    next(error);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id);
    const [rows] = await pool.query(`SELECT s.*, ${COUNTS} FROM sellers s WHERE s.id = ?`, [id]);
    if (!rows.length) throw notFound("Seller not found.");
    const [listings] = await pool.query(
      `SELECT l.id, l.title, l.status, l.verification, l.published_at, l.location, l.livestock_type, l.quantity,
         a.name AS animal_name, c.name AS category_name, b.name AS breed_name,
         (SELECT li.thumb_path FROM livestock_images li WHERE li.livestock_id = l.id
            ORDER BY li.sort_order, li.id LIMIT 1) AS thumb_path,
         (SELECT COUNT(*) FROM inquiries i WHERE i.livestock_id = l.id) AS inquiry_count
       FROM livestock l JOIN categories c ON c.id = l.category_id
       JOIN animals a ON a.id = c.animal_id
       LEFT JOIN breeds b ON b.id = l.breed_id
       WHERE l.seller_id = ? ORDER BY l.created_at DESC, l.id DESC`,
      [id],
    );
    const [inquiries] = await pool.query(
      `SELECT i.id, i.full_name, i.phone, i.email, i.livestock_id, i.livestock_title, i.status, i.is_archived, i.created_at
       FROM inquiries i WHERE i.seller_id = ? ORDER BY i.created_at DESC, i.id DESC LIMIT 100`,
      [id],
    );
    res.json({ success: true, data: { ...rows[0], listings, inquiries } });
  } catch (error) {
    next(error);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const p = payload(req.body);
    const [result] = await pool.query(
      `INSERT INTO sellers (name, business_name, phone, email, province, address, notes, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [p.name, p.business_name, p.phone, p.email, p.province, p.address, p.notes, p.status],
    );
    const [rows] = await pool.query("SELECT * FROM sellers WHERE id = ?", [result.insertId]);
    res.status(201).json({ success: true, data: rows[0] });
  } catch (error) {
    next(error);
  }
});

router.put("/:id", async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id);
    const p = payload(req.body);
    const [result] = await pool.query(
      `UPDATE sellers SET name = ?, business_name = ?, phone = ?, email = ?, province = ?, address = ?, notes = ?, status = ?
       WHERE id = ?`,
      [p.name, p.business_name, p.phone, p.email, p.province, p.address, p.notes, p.status, id],
    );
    if (!result.affectedRows) throw notFound("Seller not found.");
    const [rows] = await pool.query("SELECT * FROM sellers WHERE id = ?", [id]);
    res.json({ success: true, data: rows[0] });
  } catch (error) {
    next(error);
  }
});

router.patch("/:id/status", async (req, res, next) => {
  try {
    const status = oneOf(req.body.status, STATUSES);
    if (!status) throw badRequest("Status must be active or inactive.");
    const [result] = await pool.query("UPDATE sellers SET status = ? WHERE id = ?", [status, positiveInt(req.params.id)]);
    if (!result.affectedRows) throw notFound("Seller not found.");
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

// A seller with listings can't be deleted, so no listing silently loses its
// seller. Their past inquiries keep the seller's name.
router.delete("/:id", async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id);
    const [[{ count }]] = await pool.query("SELECT COUNT(*) AS count FROM livestock WHERE seller_id = ?", [id]);
    if (Number(count) > 0) {
      throw new HttpError(
        409,
        `This seller has ${count} listing${Number(count) === 1 ? "" : "s"}. Move ${Number(count) === 1 ? "it" : "them"} to another seller or delete ${Number(count) === 1 ? "it" : "them"} first, or mark the seller inactive instead.`,
      );
    }
    const [result] = await pool.query("DELETE FROM sellers WHERE id = ?", [id]);
    if (!result.affectedRows) throw notFound("Seller not found.");
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
