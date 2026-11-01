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
        (SELECT COUNT(*) FROM sellers WHERE account_status = 'pending') AS pending_sellers,
        (SELECT COUNT(*) FROM orders WHERE status = 'new') AS new_orders
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

// ---------------------------------------------------------------------------
// Insights for the dashboard charts: GET /api/admin/dashboard/insights?range=30d
// range: 7d | 30d | 90d | 12m. Headline numbers come with the same-length
// period before, so the page can show the change.
// ---------------------------------------------------------------------------
const RANGES = {
  "7d": { days: 7, bucket: "day" },
  "30d": { days: 30, bucket: "day" },
  "90d": { days: 90, bucket: "week" },
  "12m": { days: 365, bucket: "month" },
};

// An order counts as a sale once it's paid (online or marked paid) and not cancelled.
const SOLD = "(o.status IN ('paid', 'completed') OR o.payment_status = 'paid') AND o.status <> 'cancelled'";

const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// Bucket keys and labels covering the range, so empty days still show as 0.
function buckets(start, end, bucket) {
  const out = [];
  const d = new Date(start);
  d.setHours(0, 0, 0, 0);
  if (bucket === "week") d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Monday
  if (bucket === "month") d.setDate(1);
  const fmt = new Intl.DateTimeFormat("en-GB", bucket === "month" ? { month: "short", year: "2-digit" } : { day: "numeric", month: "short" });
  while (d <= end) {
    out.push({ key: bucket === "month" ? ymd(d).slice(0, 7) : ymd(d), label: fmt.format(d) });
    if (bucket === "day") d.setDate(d.getDate() + 1);
    else if (bucket === "week") d.setDate(d.getDate() + 7);
    else d.setMonth(d.getMonth() + 1);
  }
  return out;
}

// SQL expression giving each row's bucket key, matching buckets() above.
function bucketSql(column, bucket) {
  if (bucket === "month") return `DATE_FORMAT(${column}, '%Y-%m')`;
  if (bucket === "week") return `DATE_FORMAT(DATE_SUB(DATE(${column}), INTERVAL WEEKDAY(${column}) DAY), '%Y-%m-%d')`;
  return `DATE_FORMAT(${column}, '%Y-%m-%d')`;
}

router.get("/insights", async (req, res, next) => {
  try {
    const rangeKey = RANGES[req.query.range] ? req.query.range : "30d";
    const { days, bucket } = RANGES[rangeKey];
    const end = new Date();
    const start = new Date(end.getTime() - days * 86400000);
    const prevStart = new Date(start.getTime() - days * 86400000);
    const q = async (sql, params = []) => (await pool.query(sql, params))[0];
    const num = (v) => Number(v) || 0;

    // Headline numbers, this period and the one before.
    const period = async (from, to) => {
      const [[o]] = await pool.query(
        `SELECT COUNT(*) AS orders,
           COALESCE(SUM(CASE WHEN ${SOLD} THEN o.total END), 0) AS sales,
           COALESCE(SUM(${SOLD}), 0) AS sold,
           COALESCE(SUM(o.status = 'cancelled'), 0) AS cancelled
         FROM orders o WHERE o.created_at >= ? AND o.created_at < ?`,
        [from, to],
      );
      const [[i]] = await pool.query("SELECT COUNT(*) AS n FROM inquiries WHERE created_at >= ? AND created_at < ?", [from, to]);
      const sold = num(o.sold);
      return {
        sales: num(o.sales),
        orders: num(o.orders),
        sold,
        avg_order: sold ? Math.round(num(o.sales) / sold) : 0,
        inquiries: num(i.n),
      };
    };
    const [current, previous] = await Promise.all([period(start, end), period(prevStart, start)]);

    // Over time: sales and orders per day / week / month.
    const keys = buckets(start, end, bucket);
    const series = (rows, field) => {
      const map = new Map(rows.map((r) => [r.k, num(r[field])]));
      return keys.map((b) => map.get(b.key) || 0);
    };
    const orderRows = await q(
      `SELECT ${bucketSql("o.created_at", bucket)} AS k, COUNT(*) AS orders,
         COALESCE(SUM(CASE WHEN ${SOLD} THEN o.total END), 0) AS sales
       FROM orders o WHERE o.created_at >= ? GROUP BY k`,
      [start],
    );

    // Breakdowns.
    const ordersByStatus = await q(
      "SELECT status AS label, COUNT(*) AS value FROM orders WHERE created_at >= ? GROUP BY status",
      [start],
    );
    const topListings = await q(
      `SELECT l.id, l.title,
         (SELECT COUNT(*) FROM inquiries i WHERE i.livestock_id = l.id AND i.created_at >= ?) AS inquiries,
         (SELECT COUNT(*) FROM orders o WHERE o.livestock_id = l.id AND o.created_at >= ? AND o.status <> 'cancelled') AS orders
       FROM livestock l
       HAVING inquiries + orders > 0
       ORDER BY orders + inquiries DESC, orders DESC LIMIT 8`,
      [start, start],
    );
    const payments = await q(
      `SELECT CASE
           WHEN payment_method = 'mobile_money' THEN COALESCE(mobile_operator, 'mobile')
           WHEN payment_method = 'card' THEN 'card'
           ELSE payment_method END AS label,
         COUNT(*) AS value
       FROM orders WHERE created_at >= ? AND status <> 'cancelled' GROUP BY label`,
      [start],
    );

    const clean = (rows) => rows.map((r) => ({ ...r, value: num(r.value) }));
    res.json({
      success: true,
      data: {
        range: rangeKey,
        bucket,
        current,
        previous,
        timeline: {
          labels: keys.map((b) => b.label),
          sales: series(orderRows, "sales"),
          orders: series(orderRows, "orders"),
        },
        orders_by_status: clean(ordersByStatus),
        top_listings: topListings.map((r) => ({ id: r.id, title: r.title, inquiries: num(r.inquiries), orders: num(r.orders) })),
        payments: clean(payments),
      },
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
