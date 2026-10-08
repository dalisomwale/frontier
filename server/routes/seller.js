// Seller accounts: farmers register, wait for an admin to approve them, then
// submit listings. Every new or edited listing goes to the admin for review
// before it is published. Customer inquiries still come to Frontier first;
// sellers only see the messages an admin forwards to them, without the
// customer's contact details.
const crypto = require("crypto");
const express = require("express");
const bcrypt = require("bcrypt");
const pool = require("../db");
const { uploadImages, deleteImageFiles } = require("../middleware/upload");
const { sendEmail, appUrl, recipients } = require("../services/mailer");
const { positiveInt, text, isEmail, isPhone, badRequest, notFound, HttpError, PROVINCES } = require("../lib/validate");
const { helpers } = require("./admin/livestock");
const { subscribe, unreadCount } = require("../services/notifications");

const router = express.Router();
const DUMMY_HASH = bcrypt.hashSync("frontier-seller-timing-guard", 12);
const MIN_PASSWORD = 8;
const RESET_HOURS = 1;

const SELLER_FIELDS = `id, name, business_name, phone, email, province, address, status,
  account_status, account_note, approved_at, created_at`;

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

// A custom header a cross-site form cannot send (see requireAdminHeader).
router.use((req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (req.get("X-Frontier-Seller") === "1") return next();
  return res.status(403).json({ success: false, message: "Request blocked (missing seller header)." });
});

async function requireSeller(req, res, next) {
  const sellerId = req.session?.sellerId;
  const signedOut = () => res.status(401).json({ success: false, message: "Please sign in to continue." });
  if (!sellerId) return signedOut();
  try {
    const [rows] = await pool.query(
      `SELECT ${SELLER_FIELDS}, password_hash IS NOT NULL AS has_password FROM sellers WHERE id = ?`,
      [sellerId],
    );
    const seller = rows[0];
    if (!seller || !seller.has_password || seller.status === "inactive") {
      req.session.destroy(() => {});
      return signedOut();
    }
    delete seller.has_password;
    req.seller = seller;
    return next();
  } catch (error) {
    return next(error);
  }
}

function requireApproved(req, res, next) {
  if (req.seller.account_status === "approved") return next();
  const message = req.seller.account_status === "rejected"
    ? "Your seller account was not approved. Please contact Frontier."
    : "Your account is waiting for approval. You can add listings once Frontier approves it.";
  return res.status(403).json({ success: false, message });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validationError(errors) {
  const error = new HttpError(422, "Please correct the highlighted fields.");
  error.errors = errors;
  return error;
}

function profilePayload(body) {
  const name = text(body.name, 120);
  const businessName = text(body.business_name, 150);
  const phone = text(body.phone, 30);
  const email = text(body.email, 255);
  const province = text(body.province, 50);
  const address = text(body.address, 255);
  const errors = {};
  if (!name) errors.name = name === undefined ? "Name must be 120 characters or fewer." : "Your name is required.";
  else if (name.length < 2) errors.name = "Please enter your full name.";
  if (businessName === undefined) errors.business_name = "Farm or business name must be 150 characters or fewer.";
  if (!phone) errors.phone = "WhatsApp number is required.";
  else if (!isPhone(phone)) errors.phone = "Please enter a valid WhatsApp number, e.g. 0977 123 456.";
  if (!email || !isEmail(email)) errors.email = "Please enter a valid email address.";
  if (!province) errors.province = "Please choose your province.";
  else if (!PROVINCES.includes(province)) errors.province = "Please choose one of Zambia's 10 provinces.";
  if (address === undefined) errors.address = "Address must be 255 characters or fewer.";
  return { errors, data: { name, business_name: businessName, phone, email: email && email.toLowerCase(), province, address } };
}

async function emailTaken(email, exceptId = 0) {
  const [rows] = await pool.query(
    "SELECT id FROM sellers WHERE LOWER(email) = ? AND password_hash IS NOT NULL AND id <> ? LIMIT 1",
    [email.toLowerCase(), exceptId],
  );
  return rows.length > 0;
}

function notifyAdmins(subject, heading, paragraphs, rows, path) {
  return sendEmail({
    to: recipients(),
    subject,
    heading,
    paragraphs,
    rows,
    button: { label: "Open admin", url: appUrl(path) },
  });
}

const sellerLabel = (s) => (s.business_name ? `${s.business_name} (${s.name})` : s.name);

function startSession(req, sellerId) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => {
      if (error) return reject(error);
      req.session.sellerId = sellerId;
      return req.session.save((saveError) => (saveError ? reject(saveError) : resolve()));
    });
  });
}

async function loadSeller(id) {
  const [[row]] = await pool.query(`SELECT ${SELLER_FIELDS} FROM sellers WHERE id = ?`, [id]);
  return row;
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

router.post("/auth/register", async (req, res, next) => {
  try {
    const { errors, data } = profilePayload(req.body);
    const password = typeof req.body.password === "string" ? req.body.password : "";
    if (password.length < MIN_PASSWORD) errors.password = `Password must be at least ${MIN_PASSWORD} characters.`;
    else if (password.length > 200) errors.password = "Password is too long.";
    if (!errors.email && (await emailTaken(data.email))) {
      errors.email = "An account with this email already exists. Sign in instead.";
    }
    if (Object.keys(errors).length) throw validationError(errors);

    const hash = await bcrypt.hash(password, 12);
    const [result] = await pool.query(
      `INSERT INTO sellers (name, business_name, phone, email, province, address, status, password_hash, account_status)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, 'pending')`,
      [data.name, data.business_name, data.phone, data.email, data.province, data.address, hash],
    );
    await startSession(req, result.insertId);
    notifyAdmins(
      `New seller registration: ${data.business_name || data.name}`,
      "New seller waiting for approval",
      ["A seller has registered on Frontier Marketplace and is waiting for approval."],
      [["Name", data.name], ["Farm / business", data.business_name || "-"], ["Phone", data.phone], ["Email", data.email], ["Province", data.province]],
      `/admin/sellers.html?id=${result.insertId}`,
    );
    res.status(201).json({ success: true, data: await loadSeller(result.insertId) });
  } catch (error) {
    next(error);
  }
});

router.post("/auth/login", async (req, res, next) => {
  try {
    const email = text(req.body.email, 255);
    const password = typeof req.body.password === "string" ? req.body.password : "";
    if (!email || !password) throw badRequest("Email and password are required.");
    const [rows] = await pool.query(
      "SELECT id, status, password_hash FROM sellers WHERE LOWER(email) = ? AND password_hash IS NOT NULL ORDER BY id LIMIT 1",
      [email.toLowerCase()],
    );
    const seller = rows[0];
    const valid = await bcrypt.compare(password, seller ? seller.password_hash : DUMMY_HASH);
    if (!seller || !valid) {
      return res.status(401).json({ success: false, message: "Incorrect email or password." });
    }
    if (seller.status === "inactive") {
      return res.status(403).json({ success: false, message: "This account has been suspended. Please contact Frontier." });
    }
    await startSession(req, seller.id);
    await pool.query("UPDATE sellers SET last_login_at = NOW() WHERE id = ?", [seller.id]);
    res.json({ success: true, data: await loadSeller(seller.id) });
  } catch (error) {
    next(error);
  }
});

router.post("/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie(req.app.get("sellerCookieName"), { path: "/api/seller" });
    res.json({ success: true });
  });
});

// Always answers the same way, so it can't be used to find out who has an
// account.
router.post("/auth/forgot", async (req, res, next) => {
  try {
    const email = text(req.body.email, 255);
    if (!email || !isEmail(email)) throw badRequest("Please enter a valid email address.");
    const [[seller]] = await pool.query(
      "SELECT id, name, email FROM sellers WHERE LOWER(email) = ? AND password_hash IS NOT NULL AND status = 'active' ORDER BY id LIMIT 1",
      [email.toLowerCase()],
    );
    if (seller) {
      const token = crypto.randomBytes(32).toString("hex");
      const hash = crypto.createHash("sha256").update(token).digest("hex");
      await pool.query("DELETE FROM seller_password_resets WHERE seller_id = ? OR expires_at < NOW()", [seller.id]);
      await pool.query(
        `INSERT INTO seller_password_resets (seller_id, token_hash, expires_at)
         VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ${RESET_HOURS} HOUR))`,
        [seller.id, hash],
      );
      await sendEmail({
        to: seller.email,
        subject: "Reset your Frontier Marketplace password",
        heading: "Reset your password",
        paragraphs: [
          `Hi ${seller.name},`,
          `Use the button below to choose a new password. The link works for ${RESET_HOURS} hour.`,
          "If you didn't ask for this, you can ignore this email.",
        ],
        button: { label: "Choose a new password", url: appUrl(`/seller/reset.html?token=${token}`) },
      });
    }
    res.json({ success: true, message: "If that email has a seller account, we've sent a link to reset the password." });
  } catch (error) {
    next(error);
  }
});

router.post("/auth/reset", async (req, res, next) => {
  try {
    const token = typeof req.body.token === "string" ? req.body.token : "";
    const password = typeof req.body.password === "string" ? req.body.password : "";
    if (!/^[a-f0-9]{64}$/.test(token)) throw badRequest("This reset link is invalid or has expired.");
    if (password.length < MIN_PASSWORD || password.length > 200) {
      throw badRequest(`Password must be at least ${MIN_PASSWORD} characters.`);
    }
    const hash = crypto.createHash("sha256").update(token).digest("hex");
    const [[row]] = await pool.query(
      "SELECT id, seller_id FROM seller_password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW()",
      [hash],
    );
    if (!row) throw badRequest("This reset link is invalid or has expired.");
    await pool.query("UPDATE sellers SET password_hash = ? WHERE id = ?", [await bcrypt.hash(password, 12), row.seller_id]);
    await pool.query("DELETE FROM seller_password_resets WHERE seller_id = ?", [row.seller_id]);
    res.json({ success: true, message: "Password updated. You can now sign in." });
  } catch (error) {
    next(error);
  }
});

router.get("/auth/me", requireSeller, (req, res) => {
  res.json({ success: true, data: req.seller });
});

router.put("/me", requireSeller, async (req, res, next) => {
  try {
    const { errors, data } = profilePayload(req.body);
    if (!errors.email && (await emailTaken(data.email, req.seller.id))) {
      errors.email = "Another account already uses this email.";
    }
    if (Object.keys(errors).length) throw validationError(errors);
    await pool.query(
      "UPDATE sellers SET name = ?, business_name = ?, phone = ?, email = ?, province = ?, address = ? WHERE id = ?",
      [data.name, data.business_name, data.phone, data.email, data.province, data.address, req.seller.id],
    );
    res.json({ success: true, data: await loadSeller(req.seller.id) });
  } catch (error) {
    next(error);
  }
});

router.patch("/me/password", requireSeller, async (req, res, next) => {
  try {
    const current = String(req.body.current_password || "");
    const fresh = String(req.body.new_password || "");
    if (fresh.length < MIN_PASSWORD || fresh.length > 200) {
      throw badRequest(`New password must be at least ${MIN_PASSWORD} characters.`);
    }
    const [[row]] = await pool.query("SELECT password_hash FROM sellers WHERE id = ?", [req.seller.id]);
    if (!(await bcrypt.compare(current, row.password_hash))) throw badRequest("Your current password is incorrect.");
    await pool.query("UPDATE sellers SET password_hash = ? WHERE id = ?", [await bcrypt.hash(fresh, 12), req.seller.id]);
    res.json({ success: true, message: "Password updated." });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// Dashboard summary and the category / purpose / breed lists for the form
// ---------------------------------------------------------------------------

router.get("/summary", requireSeller, async (req, res, next) => {
  try {
    const [[counts]] = await pool.query(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(review_status = 'approved' AND status = 'published'), 0) AS live,
         COALESCE(SUM(review_status = 'pending'), 0) AS in_review,
         COALESCE(SUM(review_status = 'rejected'), 0) AS changes_needed,
         COALESCE(SUM(review_status = 'approved' AND status = 'unpublished'), 0) AS hidden
       FROM livestock WHERE seller_id = ?`,
      [req.seller.id],
    );
    const [[messages]] = await pool.query(
      `SELECT COUNT(*) AS total, COALESCE(SUM(seller_seen_at IS NULL), 0) AS unread
       FROM inquiries WHERE seller_id = ? AND forwarded_at IS NOT NULL`,
      [req.seller.id],
    );
    const stats = Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Number(v)]));
    res.json({ success: true, data: { listings: stats, messages: { total: Number(messages.total), unread: Number(messages.unread) } } });
  } catch (error) {
    next(error);
  }
});

router.get("/taxonomy", requireSeller, async (req, res, next) => {
  try {
    const [animals] = await pool.query("SELECT id, name FROM animals WHERE status = 'active' ORDER BY sort_order, name");
    const [purposes] = await pool.query(
      `SELECT c.id, c.animal_id, c.name FROM categories c JOIN animals a ON a.id = c.animal_id
       WHERE c.status = 'active' AND a.status = 'active' ORDER BY c.sort_order, c.name`,
    );
    const [breeds] = await pool.query(
      `SELECT b.id, b.category_id, c.animal_id, c.name AS category_name, b.name FROM breeds b
       JOIN categories c ON c.id = b.category_id
       WHERE b.status = 'active' AND c.status = 'active' ORDER BY b.name`,
    );
    res.json({ success: true, data: { animals, purposes, breeds } });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// Listings
// ---------------------------------------------------------------------------

// Sellers cannot set the status, verification or seller themselves.
function listingBody(body) {
  const { status, verification, seller_id: sellerId, ...rest } = body;
  return rest;
}

async function ownListing(conn, id, sellerId) {
  const [rows] = await conn.query("SELECT id, title, status, review_status FROM livestock WHERE id = ? AND seller_id = ?", [id, sellerId]);
  if (!rows.length) throw notFound("Listing not found.");
  return rows[0];
}

function sellerView(listing) {
  const { created_by, seller_phone, seller_status, ...rest } = listing;
  return rest;
}

router.get("/listings", requireSeller, async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT l.id, l.title, l.status, l.review_status, l.review_note, l.verification, l.published_at, l.submitted_at,
         l.location, l.livestock_type, l.quantity, l.created_at, l.updated_at,
         a.name AS animal_name, c.name AS category_name, b.name AS breed_name,
         (SELECT li.thumb_path FROM livestock_images li WHERE li.livestock_id = l.id
            ORDER BY li.sort_order, li.id LIMIT 1) AS thumb_path
       FROM livestock l JOIN categories c ON c.id = l.category_id
       JOIN animals a ON a.id = c.animal_id
       LEFT JOIN breeds b ON b.id = l.breed_id
       WHERE l.seller_id = ? ORDER BY l.updated_at DESC, l.id DESC`,
      [req.seller.id],
    );
    res.json({ success: true, data: rows });
  } catch (error) {
    next(error);
  }
});

router.get("/listings/:id", requireSeller, async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id);
    await ownListing(pool, id, req.seller.id);
    res.json({ success: true, data: sellerView(await helpers.loadOne(id)) });
  } catch (error) {
    next(error);
  }
});

function listingNotice(seller, listing, edited) {
  return notifyAdmins(
    `${edited ? "Listing updated" : "New listing"} for review: ${listing.title}`,
    edited ? "A seller updated a listing" : "New listing waiting for review",
    [`${sellerLabel(seller)} ${edited ? "changed" : "submitted"} a listing. It is hidden from the website until you approve it.`],
    [["Listing", listing.title], ["Seller", sellerLabel(seller)], ["Phone", seller.phone]],
    "/admin/livestock.html?review=pending",
  );
}

router.post("/listings", requireSeller, requireApproved, uploadImages, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const p = await helpers.payload(listingBody(req.body));
    if (!req.files || !req.files.length) {
      throw validationError({ images: "Please add at least one photo of the animals." });
    }
    await conn.beginTransaction();
    const [result] = await conn.query(
      `INSERT INTO livestock
         (title, category_id, breed_id, livestock_type, quantity, age_months, location, description, status,
          verification, seller_id, review_status, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unpublished', 'unverified', ?, 'pending', NOW())`,
      [p.title, p.category_id, p.breed_id, p.livestock_type, p.quantity, p.age_months,
        p.location, p.description, req.seller.id],
    );
    await helpers.storeImages(conn, result.insertId, req.files);
    await conn.commit();
    listingNotice(req.seller, p, false);
    res.status(201).json({ success: true, data: sellerView(await helpers.loadOne(result.insertId)) });
  } catch (error) {
    await conn.rollback().catch(() => {});
    next(error);
  } finally {
    conn.release();
  }
});

// Any edit hides the listing again until an admin re-approves it.
router.put("/listings/:id", requireSeller, requireApproved, uploadImages, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const id = positiveInt(req.params.id);
    await ownListing(conn, id, req.seller.id);
    const p = await helpers.payload(listingBody(req.body));
    const photoChanges = helpers.parsePhotoChanges(req.body);

    await conn.beginTransaction();
    await conn.query(
      `UPDATE livestock SET title = ?, category_id = ?, breed_id = ?, livestock_type = ?, quantity = ?,
         age_months = ?, location = ?, description = ?, status = 'unpublished', published_at = NULL,
         review_status = 'pending', review_note = NULL, submitted_at = NOW()
       WHERE id = ? AND seller_id = ?`,
      [p.title, p.category_id, p.breed_id, p.livestock_type, p.quantity, p.age_months,
        p.location, p.description, id, req.seller.id],
    );
    const filesToDelete = await helpers.applyPhotoChanges(conn, id, photoChanges, req.files);
    const [[{ photos }]] = await conn.query("SELECT COUNT(*) AS photos FROM livestock_images WHERE livestock_id = ?", [id]);
    if (!Number(photos)) throw validationError({ images: "Please keep at least one photo of the animals." });
    await conn.commit();
    deleteImageFiles(...filesToDelete);
    listingNotice(req.seller, p, true);
    res.json({ success: true, data: sellerView(await helpers.loadOne(id)) });
  } catch (error) {
    await conn.rollback().catch(() => {});
    next(error);
  } finally {
    conn.release();
  }
});

router.post("/listings/:id/resubmit", requireSeller, requireApproved, async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id);
    const listing = await ownListing(pool, id, req.seller.id);
    if (listing.review_status === "pending") throw badRequest("This listing is already waiting for review.");
    if (listing.status === "published") throw badRequest("This listing is already live.");
    await pool.query(
      `UPDATE livestock SET review_status = 'pending', review_note = NULL, submitted_at = NOW()
       WHERE id = ? AND seller_id = ?`,
      [id, req.seller.id],
    );
    listingNotice(req.seller, listing, true);
    res.json({ success: true, data: sellerView(await helpers.loadOne(id)) });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// Messages forwarded by Frontier. The customer's name, phone, email and
// original message are never included.
// ---------------------------------------------------------------------------

const MESSAGE_FIELDS = `i.id, i.livestock_id, i.livestock_title, i.forwarded_at, i.forward_message,
  i.seller_reply, i.seller_replied_at, i.seller_seen_at,
  (SELECT li.thumb_path FROM livestock_images li WHERE li.livestock_id = i.livestock_id
     ORDER BY li.sort_order, li.id LIMIT 1) AS cover_thumb`;

async function withThreads(rows) {
  if (!rows.length) return rows;
  const [messages] = await pool.query(
    `SELECT id, inquiry_id, sender, body, created_at FROM inquiry_messages
     WHERE inquiry_id IN (?) AND (to_seller = 1 OR sender = 'seller') ORDER BY created_at, id`,
    [rows.map((r) => r.id)],
  );
  return rows.map((r) => ({ ...r, messages: messages.filter((m) => m.inquiry_id === r.id).map(({ inquiry_id, ...m }) => m) }));
}

router.get("/messages", requireSeller, async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT ${MESSAGE_FIELDS} FROM inquiries i
       WHERE i.seller_id = ? AND i.forwarded_at IS NOT NULL
       ORDER BY GREATEST(COALESCE((SELECT MAX(m.created_at) FROM inquiry_messages m WHERE m.inquiry_id = i.id), i.forwarded_at), i.forwarded_at) DESC, i.id DESC
       LIMIT 200`,
      [req.seller.id],
    );
    res.json({ success: true, data: await withThreads(rows) });
  } catch (error) {
    next(error);
  }
});

async function ownMessage(id, sellerId) {
  const [[row]] = await pool.query(
    `SELECT ${MESSAGE_FIELDS} FROM inquiries i WHERE i.id = ? AND i.seller_id = ? AND i.forwarded_at IS NOT NULL`,
    [id, sellerId],
  );
  if (!row) throw notFound("Message not found.");
  return row;
}

router.post("/messages/:id/seen", requireSeller, async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id);
    await ownMessage(id, req.seller.id);
    await pool.query("UPDATE inquiries SET seller_seen_at = NOW() WHERE id = ?", [id]);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

router.post("/messages/:id/reply", requireSeller, async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id);
    const message = await ownMessage(id, req.seller.id);
    const reply = text(req.body.reply, 2000);
    if (!reply) throw badRequest(reply === undefined ? "Your reply must be 2000 characters or fewer." : "Please write a reply.");
    await pool.query("INSERT INTO inquiry_messages (inquiry_id, sender, body) VALUES (?, 'seller', ?)", [id, reply]);
    await pool.query(
      `UPDATE inquiries SET seller_reply = ?, seller_replied_at = NOW(), seller_seen_at = COALESCE(seller_seen_at, NOW())
       WHERE id = ?`,
      [reply, id],
    );
    notifyAdmins(
      `Seller replied: ${message.livestock_title}`,
      "A seller replied",
      [`${sellerLabel(req.seller)} replied about "${message.livestock_title}":`, reply],
      [["Seller phone", req.seller.phone]],
      `/admin/inquiries.html?id=${id}`,
    );
    res.json({ success: true, data: (await withThreads([await ownMessage(id, req.seller.id)]))[0] });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

router.get("/notifications", requireSeller, async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, type, title, body, link, read_at, created_at FROM seller_notifications
       WHERE seller_id = ? ORDER BY created_at DESC, id DESC LIMIT 30`,
      [req.seller.id],
    );
    res.json({ success: true, data: rows, unread: await unreadCount(req.seller.id) });
  } catch (error) {
    next(error);
  }
});

router.post("/notifications/read", requireSeller, async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map((v) => positiveInt(v)).filter(Boolean).slice(0, 100) : null;
    if (ids && ids.length) {
      await pool.query("UPDATE seller_notifications SET read_at = NOW() WHERE seller_id = ? AND read_at IS NULL AND id IN (?)", [req.seller.id, ids]);
    } else {
      await pool.query("UPDATE seller_notifications SET read_at = NOW() WHERE seller_id = ? AND read_at IS NULL", [req.seller.id]);
    }
    res.json({ success: true, unread: await unreadCount(req.seller.id) });
  } catch (error) {
    next(error);
  }
});

// Live updates for an open dashboard (Server-Sent Events).
router.get("/notifications/stream", requireSeller, (req, res) => {
  subscribe(req.seller.id, req, res);
});

module.exports = router;
