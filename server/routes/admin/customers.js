// Admin: customers (buyer accounts). Frontier's team can do what a customer
// does when signing up: add the account (name, phone, email), and the
// customer gets a link to choose their password. Also edit, switch off and
// on, and send a new password link.
//
//   GET    /api/admin/customers?q=&status=      list
//   GET    /api/admin/customers/:id             one, with their orders
//   POST   /api/admin/customers                 add (and email a password link)
//   PUT    /api/admin/customers/:id             edit name, phone, email
//   PATCH  /api/admin/customers/:id/status      { active: true|false }
//   POST   /api/admin/customers/:id/password-link
const crypto = require("crypto");
const express = require("express");
const bcrypt = require("bcrypt");
const pool = require("../../db");
const { sendEmail, appUrl } = require("../../services/mailer");
const { positiveInt, text, isEmail, isPhone, notFound, HttpError } = require("../../lib/validate");

const router = express.Router();
const ref = (id) => `FMC-${1000 + Number(id)}`;

function invalid(errors) {
  const e = new HttpError(422, "Please correct the highlighted fields.");
  e.errors = errors;
  return e;
}

// The same checks as signing up (About You).
async function payload(body, exceptId = 0) {
  const fullName = text(body.full_name, 120);
  const email = text(body.email, 255);
  const phone = text(body.phone, 30);
  const errors = {};
  if (!fullName || fullName.length < 2) errors.full_name = "Please enter their full name.";
  if (!phone || !isPhone(phone)) errors.phone = "Please enter a valid phone number, e.g. 0977 123 456.";
  if (!email || !isEmail(email)) errors.email = "Please enter a valid email address.";
  else {
    const [[taken]] = await pool.query("SELECT id FROM buyers WHERE email = ? AND id <> ?", [email.toLowerCase(), exceptId]);
    if (taken) errors.email = "A customer account with this email already exists.";
  }
  return { errors, data: { full_name: fullName, email: email && email.toLowerCase(), phone } };
}

const COLUMNS = `b.id, b.full_name, b.email, b.phone, b.status, b.email_verified_at, b.last_login_at, b.created_at,
  (SELECT COUNT(*) FROM checkouts c WHERE c.buyer_id = b.id) AS orders,
  (SELECT COALESCE(SUM(c.total), 0) FROM checkouts c WHERE c.buyer_id = b.id AND c.payment_status = 'paid') AS spent,
  (SELECT MAX(c.created_at) FROM checkouts c WHERE c.buyer_id = b.id) AS last_order_at`;
const row = (b) => ({ ...b, orders: Number(b.orders), spent: Number(b.spent), active: b.status === "active" });

// A link to choose a password (72 hours), emailed and returned to share.
async function passwordLink(buyer, adminName) {
  const token = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  await pool.query("DELETE FROM buyer_tokens WHERE (buyer_id = ? AND purpose = 'reset') OR expires_at < NOW()", [buyer.id]);
  await pool.query("INSERT INTO buyer_tokens (buyer_id, purpose, token_hash, expires_at) VALUES (?, 'reset', ?, DATE_ADD(NOW(), INTERVAL 72 HOUR))", [buyer.id, hash]);
  const link = appUrl(`/account/reset?token=${token}`);
  let mail;
  try {
    mail = await sendEmail({
      to: buyer.email,
      subject: "Your Frontier Marketplace account",
      heading: "Choose your password",
      paragraphs: [`Hi ${String(buyer.full_name).split(/\s+/)[0]},`, `${adminName ? `${adminName} at Frontier` : "Frontier"} has set up your customer account. Use the button below to choose your password, then sign in to order and track your deliveries. The link works for 3 days.`],
      button: { label: "Choose your password", url: link },
    });
  } catch (error) {
    mail = { sent: false, error: error.message };
  }
  const sent = Boolean(mail && mail.sent !== false);
  return { link, sent, error: sent ? null : (mail && mail.error) || "not sent" };
}

router.get("/", async (req, res, next) => {
  try {
    const where = ["1 = 1"];
    const params = [];
    if (req.query.status === "active" || req.query.status === "inactive") {
      where.push("b.status = ?");
      params.push(req.query.status);
    }
    const q = text(req.query.q, 100);
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
      where.push("(b.full_name LIKE ? OR b.email LIKE ? OR b.phone LIKE ?)");
      params.push(like, like, like);
    }
    const [rows] = await pool.query(`SELECT ${COLUMNS} FROM buyers b WHERE ${where.join(" AND ")} ORDER BY b.created_at DESC, b.id DESC LIMIT 1000`, params);
    const [[sum]] = await pool.query("SELECT COUNT(*) AS all_, COALESCE(SUM(status = 'active'), 0) AS active, COALESCE(SUM(status = 'inactive'), 0) AS inactive FROM buyers");
    res.json({ success: true, data: rows.map(row), summary: { all: Number(sum.all_), active: Number(sum.active), inactive: Number(sum.inactive) } });
  } catch (error) {
    next(error);
  }
});

async function loadOne(id) {
  const [[b]] = await pool.query(`SELECT ${COLUMNS} FROM buyers b WHERE b.id = ?`, [id || 0]);
  if (!b) throw notFound("Customer not found.");
  const [orders] = await pool.query(
    "SELECT id, total, payment_status, delivery_option, created_at FROM checkouts WHERE buyer_id = ? ORDER BY id DESC LIMIT 100",
    [b.id],
  );
  return { ...row(b), order_list: orders.map((o) => ({ ...o, reference: ref(o.id), total: Number(o.total) })) };
}

router.get("/:id", async (req, res, next) => {
  try {
    res.json({ success: true, data: await loadOne(positiveInt(req.params.id)) });
  } catch (error) {
    next(error);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const { errors, data } = await payload(req.body);
    if (Object.keys(errors).length) throw invalid(errors);
    // Nobody can sign in with this until the customer chooses a password.
    const unusable = await bcrypt.hash(crypto.randomBytes(24).toString("hex"), 12);
    const [r] = await pool.query("INSERT INTO buyers (full_name, email, phone, password_hash, status) VALUES (?, ?, ?, ?, 'active')", [data.full_name, data.email, data.phone, unusable]);
    const send = !["0", "false", ""].includes(String(req.body.send_link ?? "1"));
    const link = send ? await passwordLink({ id: r.insertId, ...data }, req.admin && req.admin.name) : null;
    res.status(201).json({
      success: true,
      message: !link ? `${data.full_name} added.` : link.sent ? `${data.full_name} added. We've emailed them a link to choose their password.` : `${data.full_name} added. The email didn't go (${link.error}): share the link with them yourself.`,
      data: await loadOne(r.insertId),
      ...(link ? { setup_link: link.link, emailed: link.sent } : {}),
    });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") return next(invalid({ email: "A customer account with this email already exists." }));
    next(error);
  }
});

router.put("/:id", async (req, res, next) => {
  try {
    const current = await loadOne(positiveInt(req.params.id));
    const { errors, data } = await payload(req.body, current.id);
    if (Object.keys(errors).length) throw invalid(errors);
    // A new email isn't confirmed yet (MySQL sets columns left to right: check it before changing it).
    await pool.query("UPDATE buyers SET email_verified_at = IF(email = ?, email_verified_at, NULL), full_name = ?, email = ?, phone = ? WHERE id = ?", [data.email, data.full_name, data.email, data.phone, current.id]);
    res.json({ success: true, message: "Customer saved.", data: await loadOne(current.id) });
  } catch (error) {
    next(error);
  }
});

router.patch("/:id/status", async (req, res, next) => {
  try {
    const b = await loadOne(positiveInt(req.params.id));
    const active = req.body.active === true || req.body.active === "1" || req.body.active === "true";
    await pool.query("UPDATE buyers SET status = ? WHERE id = ?", [active ? "active" : "inactive", b.id]);
    res.json({ success: true, message: active ? `${b.full_name} can sign in again.` : `${b.full_name} is switched off and can't sign in.`, data: await loadOne(b.id) });
  } catch (error) {
    next(error);
  }
});

router.post("/:id/password-link", async (req, res, next) => {
  try {
    const b = await loadOne(positiveInt(req.params.id));
    const link = await passwordLink(b, req.admin && req.admin.name);
    res.json({ success: true, message: link.sent ? `We've emailed ${b.full_name} a link to choose a password.` : `The email didn't go (${link.error}): share the link with ${b.full_name} yourself.`, setup_link: link.link, emailed: link.sent });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
