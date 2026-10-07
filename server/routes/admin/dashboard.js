const express = require("express");
const pool = require("../../db");

const router = express.Router();

router.get("/", async (req, res, next) => {
  try {
    const [[counts]] = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM livestock) AS total_livestock,
        (SELECT COUNT(*) FROM livestock WHERE status = 'published') AS published_livestock,
        (SELECT COUNT(*) FROM livestock WHERE status = 'unpublished') AS unpublished_livestock,
        (SELECT COUNT(*) FROM animals) AS animals,
        (SELECT COUNT(*) FROM categories) AS purposes,
        (SELECT COUNT(*) FROM breeds) AS breeds,
        (SELECT COUNT(*) FROM inquiries WHERE is_archived = 0) AS total_inquiries,
        (SELECT COUNT(*) FROM inquiries WHERE is_archived = 0 AND status = 'new') AS new_inquiries,
        (SELECT COUNT(*) FROM inquiries WHERE is_archived = 0 AND email_status = 'failed') AS failed_emails,
        (SELECT COUNT(*) FROM livestock WHERE review_status = 'pending') AS pending_listings,
        (SELECT COUNT(*) FROM sellers WHERE account_status = 'pending') AS pending_sellers
    `);

    const [recentLivestock] = await pool.query(`
      SELECT l.id, l.title, l.status, l.location, l.created_at,
        a.name AS animal_name, c.name AS category_name, b.name AS breed_name,
        (SELECT li.thumb_path FROM livestock_images li WHERE li.livestock_id = l.id
           ORDER BY li.sort_order, li.id LIMIT 1) AS thumb_path
      FROM livestock l
      JOIN categories c ON c.id = l.category_id
      JOIN animals a ON a.id = c.animal_id
      LEFT JOIN breeds b ON b.id = l.breed_id
      ORDER BY l.created_at DESC, l.id DESC LIMIT 5`);

    const [recentInquiries] = await pool.query(`
      SELECT id, full_name, livestock_title, status, email_status, created_at
      FROM inquiries WHERE is_archived = 0
      ORDER BY created_at DESC, id DESC LIMIT 5`);

    const stats = Object.fromEntries(
      Object.entries(counts).map(([key, value]) => [key, Number(value)]),
    );
    res.json({ success: true, data: { stats, recentLivestock, recentInquiries } });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
