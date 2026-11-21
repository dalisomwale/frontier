// Buyer accounts. A buyer needs an account to check out. Their account pages
// (/account/) show their orders, and let them confirm with photos once the
// seller has handed an order over.
//
// Past orders made without an account are added to it once the buyer has
// proved they own the email address (the confirmation link, or a password
// reset), never just because the same email was typed at sign-up.
const crypto = require("crypto");
const express = require("express");
const bcrypt = require("bcrypt");
const pool = require("../db");
const { uploadImages } = require("../middleware/upload");
const { sendEmail, appUrl } = require("../services/mailer");
const { text, isEmail, isPhone, positiveInt, badRequest, notFound, HttpError } = require("../lib/validate");
const { subscribeBuyer, buyerUnreadCount, broadcastAdmin } = require("../services/notifications");
const { orderRef, headCount } = require("../lib/orders");
const handover = require("../lib/handover");
const checkout = require("../lib/checkout");
const { uploadTransportPhotos } = require("../middleware/upload");
const transportCore = require("../lib/transport/core");
const transport = require("../lib/transport/bookings");
const transportViews = require("../lib/transport/views");
const passwordRules = require("../../public/js/password-rules");

const router = express.Router();
const DUMMY_HASH = bcrypt.hashSync("frontier-buyer-timing-guard", 12);
const REMEMBER_MS = 30 * 24 * 60 * 60 * 1000;
const RESET_HOURS = 1;
const VERIFY_DAYS = 7;
const BUYER_FIELDS = "id, full_name, email, phone, status, email_verified_at, created_at";

// A custom header a cross-site form cannot send.
router.use((req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (req.get("X-Frontier-Buyer") === "1") return next();
  return res.status(403).json({ success: false, message: "Request blocked (missing buyer header)." });
});

async function loadBuyer(id) {
  const [[row]] = await pool.query(`SELECT ${BUYER_FIELDS} FROM buyers WHERE id = ?`, [id]);
  return row ? { ...row, verified: Boolean(row.email_verified_at) } : null;
}

// Also used by the checkout routes.
async function currentBuyer(req) {
  const id = req.session && req.session.buyerId;
  if (!id) return null;
  const buyer = await loadBuyer(id);
  if (!buyer || buyer.status !== "active") return null;
  return buyer;
}

async function requireBuyer(req, res, next) {
  try {
    const buyer = await currentBuyer(req);
    if (!buyer) {
      if (req.session) req.session.destroy(() => {});
      return res.status(401).json({ success: false, message: "Please log in to continue." });
    }
    req.buyer = buyer;
    return next();
  } catch (error) {
    return next(error);
  }
}

function validationError(errors) {
  const error = new HttpError(422, "Please correct the highlighted fields.");
  error.errors = errors;
  return error;
}

function startSession(req, buyerId, { remember = true } = {}) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => {
      if (error) return reject(error);
      req.session.buyerId = buyerId;
      req.session.cookie.maxAge = remember ? REMEMBER_MS : null;
      return req.session.save((saveError) => (saveError ? reject(saveError) : resolve()));
    });
  });
}

function profilePayload(body) {
  const fullName = text(body.full_name, 120);
  const email = text(body.email, 255);
  const phone = text(body.phone, 30);
  const errors = {};
  if (!fullName || fullName.length < 2) errors.full_name = "Please enter your full name.";
  if (!email || !isEmail(email)) errors.email = "Please enter a valid email address.";
  if (!phone || !isPhone(phone)) errors.phone = "Please enter a valid phone number, e.g. 0977 123 456.";
  return { errors, data: { full_name: fullName, email: email && email.toLowerCase(), phone } };
}

async function emailTaken(email, exceptId = 0) {
  const [rows] = await pool.query("SELECT id FROM buyers WHERE email = ? AND id <> ? LIMIT 1", [email.toLowerCase(), exceptId]);
  return rows.length > 0;
}

async function newToken(buyerId, purpose, hours) {
  const token = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  await pool.query("DELETE FROM buyer_tokens WHERE (buyer_id = ? AND purpose = ?) OR expires_at < NOW()", [buyerId, purpose]);
  await pool.query(
    "INSERT INTO buyer_tokens (buyer_id, purpose, token_hash, expires_at) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? HOUR))",
    [buyerId, purpose, hash, hours],
  );
  return token;
}

async function useToken(token, purpose) {
  if (!/^[a-f0-9]{64}$/.test(String(token || ""))) return null;
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  const [[row]] = await pool.query(
    "SELECT id, buyer_id FROM buyer_tokens WHERE token_hash = ? AND purpose = ? AND expires_at > NOW()",
    [hash, purpose],
  );
  return row || null;
}

function sendVerifyEmail(buyer, token) {
  return sendEmail({
    to: buyer.email,
    subject: "Confirm your email for Frontier Marketplace",
    heading: "Confirm your email",
    paragraphs: [
      `Hi ${String(buyer.full_name).split(/\s+/)[0]},`,
      "Welcome to Frontier Marketplace. Please confirm this is your email address. Any orders you placed before with this email will then appear in your account.",
    ],
    button: { label: "Confirm my email", url: appUrl(`/account/verify?token=${token}`) },
    after: [`The link works for ${VERIFY_DAYS} days. If you didn't create an account, you can ignore this email.`],
  });
}

// The email is proven: mark it and add past orders made with it.
async function emailProven(buyerId) {
  const buyer = await loadBuyer(buyerId);
  if (!buyer) return 0;
  await pool.query("UPDATE buyers SET email_verified_at = COALESCE(email_verified_at, NOW()) WHERE id = ?", [buyerId]);
  await pool.query("UPDATE checkouts SET buyer_id = ? WHERE buyer_id IS NULL AND LOWER(email) = ?", [buyerId, buyer.email]);
  const [linked] = await pool.query("UPDATE orders SET buyer_id = ? WHERE buyer_id IS NULL AND LOWER(email) = ?", [buyerId, buyer.email]);
  return linked.affectedRows;
}

// ---------------------------------------------------------------------------
// Sign up, log in, passwords
// ---------------------------------------------------------------------------

router.post("/auth/register", async (req, res, next) => {
  try {
    const { errors, data } = profilePayload(req.body);
    const password = typeof req.body.password === "string" ? req.body.password : "";
    const problem = passwordRules.problem(password, { email: data.email, phone: data.phone });
    if (problem) errors.password = problem;
    const accepted = req.body.accept_terms === true || req.body.accept_terms === "1" || req.body.accept_terms === "on";
    if (!accepted) errors.accept_terms = "Please tick the box to accept the terms and policies.";
    if (!errors.email && (await emailTaken(data.email))) {
      errors.email = "An account with this email already exists. Log in, or reset your password.";
    }
    if (Object.keys(errors).length) throw validationError(errors);
    const [result] = await pool.query(
      "INSERT INTO buyers (full_name, email, phone, password_hash) VALUES (?, ?, ?, ?)",
      [data.full_name, data.email, data.phone, await bcrypt.hash(password, 12)],
    );
    await startSession(req, result.insertId);
    await pool.query("UPDATE buyers SET last_login_at = NOW() WHERE id = ?", [result.insertId]);
    sendVerifyEmail(data, await newToken(result.insertId, "verify", VERIFY_DAYS * 24));
    broadcastAdmin("buyer", { id: result.insertId });
    res.status(201).json({ success: true, data: await loadBuyer(result.insertId) });
  } catch (error) {
    next(error);
  }
});

router.post("/auth/login", async (req, res, next) => {
  try {
    const email = text(req.body.email, 255);
    const password = typeof req.body.password === "string" ? req.body.password : "";
    if (!email || !password) throw badRequest("Email and password are required.");
    const [[row]] = await pool.query("SELECT id, status, password_hash FROM buyers WHERE email = ?", [email.toLowerCase()]);
    const valid = await bcrypt.compare(password, row ? row.password_hash : DUMMY_HASH);
    if (!row || !valid) return res.status(401).json({ success: false, message: "Incorrect email or password." });
    if (row.status !== "active") return res.status(403).json({ success: false, message: "This account has been suspended. Please contact Frontier." });
    await startSession(req, row.id, { remember: req.body.remember !== false && req.body.remember !== "false" });
    await pool.query("UPDATE buyers SET last_login_at = NOW() WHERE id = ?", [row.id]);
    res.json({ success: true, data: await loadBuyer(row.id) });
  } catch (error) {
    next(error);
  }
});

router.post("/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie(req.app.get("buyerCookieName"), { path: "/api" });
    res.json({ success: true });
  });
});

router.post("/auth/forgot", async (req, res, next) => {
  try {
    const email = text(req.body.email, 255);
    if (!email || !isEmail(email)) throw badRequest("Please enter a valid email address.");
    const [[buyer]] = await pool.query("SELECT id, full_name, email FROM buyers WHERE email = ? AND status = 'active'", [email.toLowerCase()]);
    if (buyer) {
      const token = await newToken(buyer.id, "reset", RESET_HOURS);
      await sendEmail({
        to: buyer.email,
        subject: "Reset your Frontier Marketplace password",
        heading: "Reset your password",
        paragraphs: [
          `Hi ${String(buyer.full_name).split(/\s+/)[0]},`,
          `Use the button below to choose a new password. The link works for ${RESET_HOURS} hour.`,
          "If you didn't ask for this, you can ignore this email.",
        ],
        button: { label: "Choose a new password", url: appUrl(`/account/reset?token=${token}`) },
      });
    }
    res.json({ success: true, message: "If that email has an account, we've sent a link to reset the password." });
  } catch (error) {
    next(error);
  }
});

router.post("/auth/reset", async (req, res, next) => {
  try {
    const row = await useToken(req.body.token, "reset");
    if (!row) throw badRequest("This reset link is invalid or has expired.");
    const buyer = await loadBuyer(row.buyer_id);
    const password = typeof req.body.password === "string" ? req.body.password : "";
    const problem = passwordRules.problem(password, { email: buyer.email, phone: buyer.phone });
    if (problem) throw validationError({ password: problem });
    await pool.query("UPDATE buyers SET password_hash = ? WHERE id = ?", [await bcrypt.hash(password, 12), buyer.id]);
    await pool.query("DELETE FROM buyer_tokens WHERE buyer_id = ? AND purpose = 'reset'", [buyer.id]);
    // The reset link came to their inbox, so the email is theirs.
    await emailProven(buyer.id);
    res.json({ success: true, message: "Password updated. You can now log in." });
  } catch (error) {
    next(error);
  }
});

router.post("/auth/verify", async (req, res, next) => {
  try {
    const row = await useToken(req.body.token, "verify");
    if (!row) throw badRequest("This confirmation link is invalid or has expired. Log in and ask for a new one.");
    const linked = await emailProven(row.buyer_id);
    await pool.query("DELETE FROM buyer_tokens WHERE buyer_id = ? AND purpose = 'verify'", [row.buyer_id]);
    res.json({ success: true, data: { linked } });
  } catch (error) {
    next(error);
  }
});

router.post("/auth/resend", requireBuyer, async (req, res, next) => {
  try {
    if (req.buyer.verified) return res.json({ success: true, message: "Your email is already confirmed." });
    await sendVerifyEmail(req.buyer, await newToken(req.buyer.id, "verify", VERIFY_DAYS * 24));
    res.json({ success: true, message: `We've sent a new link to ${req.buyer.email}.` });
  } catch (error) {
    next(error);
  }
});

router.get("/auth/me", requireBuyer, async (req, res) => {
  res.json({ success: true, data: { ...req.buyer, unread: await buyerUnreadCount(req.buyer.id) } });
});

router.put("/me", requireBuyer, async (req, res, next) => {
  try {
    const { errors, data } = profilePayload(req.body);
    if (!errors.email && (await emailTaken(data.email, req.buyer.id))) errors.email = "Another account already uses this email.";
    if (Object.keys(errors).length) throw validationError(errors);
    const emailChanged = data.email !== req.buyer.email;
    await pool.query(
      `UPDATE buyers SET full_name = ?, email = ?, phone = ?${emailChanged ? ", email_verified_at = NULL" : ""} WHERE id = ?`,
      [data.full_name, data.email, data.phone, req.buyer.id],
    );
    if (emailChanged) sendVerifyEmail(data, await newToken(req.buyer.id, "verify", VERIFY_DAYS * 24));
    res.json({ success: true, data: await loadBuyer(req.buyer.id), message: emailChanged ? `Saved. Please confirm ${data.email} using the link we've sent.` : "Saved." });
  } catch (error) {
    next(error);
  }
});

router.patch("/me/password", requireBuyer, async (req, res, next) => {
  try {
    const current = String(req.body.current_password || "");
    const fresh = String(req.body.new_password || "");
    const problem = passwordRules.problem(fresh, { email: req.buyer.email, phone: req.buyer.phone });
    if (problem) throw validationError({ new_password: problem });
    const [[row]] = await pool.query("SELECT password_hash FROM buyers WHERE id = ?", [req.buyer.id]);
    if (!(await bcrypt.compare(current, row.password_hash))) throw validationError({ current_password: "Your current password is incorrect." });
    await pool.query("UPDATE buyers SET password_hash = ? WHERE id = ?", [await bcrypt.hash(fresh, 12), req.buyer.id]);
    res.json({ success: true, message: "Password updated." });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

// ordered -> paid -> sent (seller delivered / buyer collected) -> received
// (buyer confirmed) -> completed (seller handed over, or completed by the
// team), or unpaid / cancelled.
function stageOf(o) {
  if (o.status === "cancelled") return "cancelled";
  if (o.status === "completed") return "completed";
  if (o.received_at) return "received";
  if (o.sent_at) return "sent";
  if (o.payment_status === "paid" || ["paid", "confirmed"].includes(o.status)) return "paid";
  return "unpaid";
}

const ORDER_SQL = `
  SELECT o.*, a.name AS animal_name, a.kind AS animal_kind, l.location,
         c.public_token AS checkout_token, c.payment_status AS checkout_payment, c.payment_method AS checkout_method,
         c.mobile_operator AS checkout_operator, c.delivery_option AS checkout_delivery,
         tb.status AS transport_status, tb.fee AS transport_fee,
         (SELECT pr.stars FROM platform_ratings pr WHERE pr.checkout_id = o.checkout_id) AS platform_stars,
         (SELECT li.thumb_path FROM livestock_images li WHERE li.livestock_id = o.livestock_id ORDER BY li.sort_order, li.id LIMIT 1) AS thumb_path
  FROM orders o
  LEFT JOIN checkouts c ON c.id = o.checkout_id
  LEFT JOIN transport_bookings tb ON tb.id = o.transport_booking_id
  LEFT JOIN livestock l ON l.id = o.livestock_id
  LEFT JOIN categories cat ON cat.id = l.category_id
  LEFT JOIN animals a ON a.id = cat.animal_id`;

const OPERATORS = { airtel: "Airtel Money", mtn: "MTN MoMo", zamtel: "Zamtel Kwacha" };

function orderView(o, photos = []) {
  const stage = stageOf(o);
  const payable = stage === "unpaid" && o.checkout_id && o.checkout_token && o.checkout_payment !== "paid";
  return {
    id: o.id,
    reference: orderRef(o.id),
    checkout_reference: o.checkout_id ? checkout.checkoutRef(o.checkout_id) : null,
    checkout_id: o.checkout_id,
    title: o.livestock_title,
    livestock_id: o.livestock_id,
    thumb_path: o.thumb_path,
    location: o.location,
    quantity: o.quantity,
    units: headCount(o.quantity, o.animal_name, o.animal_kind),
    price_unit: o.price_unit,
    unit_price: Number(o.unit_price),
    total: Number(o.total),
    stage,
    paid: o.payment_status === "paid",
    paid_with: o.payment_method === "card" ? "Visa / Mastercard" : OPERATORS[o.mobile_operator || o.checkout_operator] || "Mobile money",
    ordered_at: o.created_at,
    paid_at: o.paid_at,
    handover_method: o.handover_method,
    handed_over_at: o.handed_over_at,
    sent_method: o.sent_method,
    sent_at: o.sent_at,
    received_at: o.received_at,
    received_note: o.received_note,
    pay_url: payable ? `/pay?checkout=${o.checkout_id}&token=${o.checkout_token}` : null,
    photos,
    delivery_option: o.checkout_delivery || "collect",
    // Include transport: the delivery this order travels in.
    transport: o.transport_booking_id ? {
      id: o.transport_booking_id,
      reference: transportCore.bookingRef(o.transport_booking_id),
      status: o.transport_status,
      status_label: transportCore.STATUS_LABELS[o.transport_status] || o.transport_status,
      group: transportViews.groupOf(o.transport_status),
      fee: Number(o.transport_fee),
    } : null,
    // Rating Frontier: once per purchase, after delivery or confirmed collection.
    platform_rating: o.checkout_id ? { rated: o.platform_stars !== null && o.platform_stars !== undefined, stars: o.platform_stars === null ? null : Number(o.platform_stars) } : null,
  };
}

router.get("/orders", requireBuyer, async (req, res, next) => {
  try {
    const [rows] = await pool.query(`${ORDER_SQL} WHERE o.buyer_id = ? ORDER BY o.id DESC LIMIT 500`, [req.buyer.id]);
    const photos = await handover.photosOf(rows.map((r) => r.id));
    res.json({ success: true, data: rows.map((o) => orderView(o, photos.get(o.id) || [])) });
  } catch (error) {
    next(error);
  }
});

router.get("/orders/:id", requireBuyer, async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id);
    const [[o]] = await pool.query(`${ORDER_SQL} WHERE o.id = ? AND o.buyer_id = ?`, [id || 0, req.buyer.id]);
    if (!o) throw notFound("Order not found.");
    const photos = await handover.photosOf([o.id]);
    res.json({ success: true, data: orderView(o, photos.get(o.id) || []) });
  } catch (error) {
    next(error);
  }
});

router.post("/orders/:id/confirm", requireBuyer, uploadImages, async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id);
    if (!id) throw notFound("Order not found.");
    const agreed = ["1", "true", "on"].includes(String(req.body.agree));
    if (!agreed) throw validationError({ agree: "Please tick the box to confirm you've received it." });
    await handover.confirmReceipt(id, req.buyer, String(req.body.method || ""), req.files, text(req.body.note, 500) || null, req.ip);
    const [[o]] = await pool.query(`${ORDER_SQL} WHERE o.id = ?`, [id]);
    const photos = await handover.photosOf([id]);
    res.json({ success: true, message: "Thank you! Your order is complete.", data: orderView(o, photos.get(id) || []) });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// Transport deliveries: follow, confirm with photos or report a problem, rate
// ---------------------------------------------------------------------------
async function buyerBooking(req) {
  const id = positiveInt(req.params.id);
  const b = id ? await transport.loadBooking(id) : null;
  if (!b || Number(b.buyer_id) !== Number(req.buyer.id)) throw notFound("Delivery not found.");
  return b;
}

router.get("/deliveries/:id", requireBuyer, async (req, res, next) => {
  try {
    const b = await buyerBooking(req);
    const data = await transportViews.detail(b, "customer");
    data.can = {
      confirm: b.status === "awaiting_confirmation",
      dispute: b.status === "awaiting_confirmation",
      rate_provider: b.status === "completed" && Boolean(b.provider_id) && !data.rating,
    };
    data.platform = await transport.platformRatingState(req.buyer.id, b.checkout_id);
    data.dispute_reasons = transport.DISPUTE_REASONS;
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

router.get("/deliveries/:id/track", requireBuyer, async (req, res, next) => {
  try {
    const b = await buyerBooking(req);
    res.json({ success: true, data: await transportViews.track(b.id, req.query.after) });
  } catch (error) {
    next(error);
  }
});

router.post("/deliveries/:id/confirm", requireBuyer, uploadTransportPhotos, async (req, res, next) => {
  try {
    const b = await buyerBooking(req);
    await transport.confirmDelivery(req.buyer, b.id, req.files, req.body);
    res.json({ success: true, message: "Thank you! Your delivery is complete." });
  } catch (error) {
    next(error);
  }
});

router.post("/deliveries/:id/dispute", requireBuyer, uploadTransportPhotos, async (req, res, next) => {
  try {
    const b = await buyerBooking(req);
    await transport.dispute(req.buyer, b.id, req.files, req.body);
    res.json({ success: true, message: "Thank you. We've received your report and will contact you." });
  } catch (error) {
    next(error);
  }
});

router.post("/deliveries/:id/rating", requireBuyer, async (req, res, next) => {
  try {
    const b = await buyerBooking(req);
    await transport.rateProvider(req.buyer, b.id, req.body);
    res.json({ success: true, message: "Thank you for rating the transport provider." });
  } catch (error) {
    next(error);
  }
});

// Rating Frontier Marketplace for a purchase (self-collection or transport).
router.get("/checkouts/:id/rating", requireBuyer, async (req, res, next) => {
  try {
    const state = await transport.platformRatingState(req.buyer.id, positiveInt(req.params.id) || 0);
    if (!state) throw notFound("Order not found.");
    res.json({ success: true, data: state });
  } catch (error) {
    next(error);
  }
});

router.post("/checkouts/:id/rating", requireBuyer, async (req, res, next) => {
  try {
    await transport.ratePlatform(req.buyer, positiveInt(req.params.id) || 0, req.body);
    res.json({ success: true, message: "Thank you for rating Frontier Marketplace." });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// Notifications and live updates
// ---------------------------------------------------------------------------

router.get("/notifications", requireBuyer, async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, type, title, body, link, read_at, created_at FROM buyer_notifications WHERE buyer_id = ? ORDER BY id DESC LIMIT 100",
      [req.buyer.id],
    );
    res.json({ success: true, data: rows, unread: await buyerUnreadCount(req.buyer.id) });
  } catch (error) {
    next(error);
  }
});

router.post("/notifications/read", requireBuyer, async (req, res, next) => {
  try {
    await pool.query("UPDATE buyer_notifications SET read_at = NOW() WHERE buyer_id = ? AND read_at IS NULL", [req.buyer.id]);
    res.json({ success: true, unread: 0 });
  } catch (error) {
    next(error);
  }
});

router.get("/events", requireBuyer, (req, res) => subscribeBuyer(req.buyer.id, req, res));

module.exports = router;
module.exports.currentBuyer = currentBuyer;
module.exports.emailProven = emailProven;
