const express = require("express");
const pool = require("../../db");
const { positiveInt, text, oneOf, badRequest, notFound } = require("../../lib/validate");
const { sendInquiryNotification, sendEmail, appUrl } = require("../../services/mailer");
const { notifySeller } = require("../../services/notifications");

const router = express.Router();
const STATUSES = ["new", "contacted", "in_progress", "resolved"];
const MAX_PAGE_SIZE = 50;

router.get("/", async (req, res, next) => {
  try {
    const page = positiveInt(req.query.page, 1);
    const limit = Math.min(positiveInt(req.query.limit, 20), MAX_PAGE_SIZE);
    const archived = req.query.archived === "1" ? 1 : 0;
    const where = ["i.is_archived = ?"];
    const params = [archived];

    const status = oneOf(req.query.status, STATUSES);
    if (status) {
      where.push("i.status = ?");
      params.push(status);
    }
    const sellerId = req.query.seller_id === "none" ? "none" : positiveInt(req.query.seller_id);
    if (sellerId === "none") where.push("i.seller_id IS NULL");
    else if (sellerId) {
      where.push("i.seller_id = ?");
      params.push(sellerId);
    }
    const q = text(req.query.q, 100);
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
      where.push("(i.full_name LIKE ? OR i.email LIKE ? OR i.phone LIKE ? OR i.livestock_title LIKE ? OR i.seller_name LIKE ?)");
      params.push(like, like, like, like, like);
    }
    const condition = where.join(" AND ");

    const [rows] = await pool.query(
      `SELECT i.*, s.name AS seller_current_name, s.business_name AS seller_business_name,
         s.phone AS seller_phone, s.email AS seller_email, s.status AS seller_status,
         s.account_status AS seller_account_status
       FROM inquiries i LEFT JOIN sellers s ON s.id = i.seller_id WHERE ${condition}
       ORDER BY i.created_at DESC, i.id DESC LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit],
    );
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM inquiries i WHERE ${condition}`,
      params,
    );
    const [counts] = await pool.query(
      "SELECT status, COUNT(*) AS count FROM inquiries WHERE is_archived = 0 GROUP BY status",
    );
    const [[{ archivedCount }]] = await pool.query(
      "SELECT COUNT(*) AS archivedCount FROM inquiries WHERE is_archived = 1",
    );
    const summary = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    counts.forEach((row) => (summary[row.status] = Number(row.count)));
    summary.archived = Number(archivedCount);

    res.json({
      success: true,
      data: rows,
      summary,
      pagination: { current: page, total: Math.max(1, Math.ceil(total / limit)), totalItems: Number(total) },
    });
  } catch (error) {
    next(error);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT i.*, s.name AS seller_current_name, s.business_name AS seller_business_name,
         s.phone AS seller_phone, s.email AS seller_email, s.status AS seller_status,
         s.account_status AS seller_account_status, l.status AS livestock_status FROM inquiries i
       LEFT JOIN livestock l ON l.id = i.livestock_id
       LEFT JOIN sellers s ON s.id = i.seller_id WHERE i.id = ?`,
      [positiveInt(req.params.id)],
    );
    if (!rows.length) throw notFound("Inquiry not found.");
    const [messages] = await pool.query(
      `SELECT id, sender, body, to_customer, to_seller, customer_emailed, seller_emailed, created_at
       FROM inquiry_messages WHERE inquiry_id = ? ORDER BY created_at, id`,
      [rows[0].id],
    );
    res.json({ success: true, data: { ...rows[0], messages } });
  } catch (error) {
    next(error);
  }
});

router.patch("/:id", async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id);
    const fields = [];
    const params = [];
    if (req.body.status !== undefined) {
      const status = oneOf(req.body.status, STATUSES);
      if (!status) throw badRequest("Invalid inquiry status.");
      fields.push("status = ?");
      params.push(status);
    }
    if (req.body.is_archived !== undefined) {
      fields.push("is_archived = ?");
      params.push(req.body.is_archived ? 1 : 0);
    }
    if (!fields.length) throw badRequest("Nothing to update.");
    const [result] = await pool.query(`UPDATE inquiries SET ${fields.join(", ")} WHERE id = ?`, [...params, id]);
    if (!result.affectedRows) throw notFound("Inquiry not found.");
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

// Frontier's reply in the conversation. It goes to the customer by email and,
// when the listing has a seller, to the seller's dashboard and email. The
// seller never receives the customer's name, phone or email. Replying marks
// the inquiry as contacted.
router.post("/:id/reply", async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id);
    const message = text(req.body.message, 3000);
    if (!message) throw badRequest(message === undefined ? "The message must be 3000 characters or fewer." : "Please write a reply.");
    const [[row]] = await pool.query(
      `SELECT i.id, i.full_name, i.email AS customer_email, i.livestock_id, i.livestock_title, i.seller_id,
         l.status AS livestock_status, s.name, s.email, s.status,
         s.password_hash IS NOT NULL AND s.account_status = 'approved' AS has_account
       FROM inquiries i LEFT JOIN sellers s ON s.id = i.seller_id
       LEFT JOIN livestock l ON l.id = i.livestock_id WHERE i.id = ?`,
      [id],
    );
    if (!row) throw notFound("Inquiry not found.");
    const hasSeller = Boolean(row.seller_id && row.name);
    const sellerAccount = hasSeller && Boolean(row.has_account) && row.status === "active";
    const toSeller = hasSeller && (sellerAccount || Boolean(row.email));

    const listingUrl = row.livestock_id && row.livestock_status === "published" ? appUrl(`/listing.html?id=${row.livestock_id}`) : null;
    const customer = await sendEmail({
      to: row.customer_email,
      subject: `Re: your inquiry about ${row.livestock_title}`,
      heading: "A reply to your inquiry",
      paragraphs: [`Hi ${row.full_name},`, message, "Frontier Marketplace"],
      rows: [["Listing", row.livestock_title]],
      button: listingUrl ? { label: "View the listing", url: listingUrl } : null,
    });
    let seller = { sent: false };
    if (toSeller && row.email) {
      seller = await sendEmail({
        to: row.email,
        subject: `Message from Frontier: ${row.livestock_title}`,
        heading: "A message about your livestock",
        paragraphs: [`Hi ${row.name},`, `Frontier has a message for you about "${row.livestock_title}":`, message],
        button: sellerAccount ? { label: "Reply in your dashboard", url: appUrl("/seller/?tab=messages") } : null,
      });
    }

    await pool.query(
      `INSERT INTO inquiry_messages (inquiry_id, sender, body, to_customer, to_seller, customer_emailed, seller_emailed)
       VALUES (?, 'admin', ?, 1, ?, ?, ?)`,
      [id, message, toSeller ? 1 : 0, customer.sent ? 1 : 0, seller.sent ? 1 : 0],
    );
    await pool.query(
      `UPDATE inquiries SET status = IF(status = 'resolved', status, 'contacted'),
         forwarded_at = IF(?, COALESCE(forwarded_at, NOW()), forwarded_at),
         forward_message = IF(?, ?, forward_message),
         seller_seen_at = IF(?, NULL, seller_seen_at)
       WHERE id = ?`,
      [toSeller ? 1 : 0, toSeller ? 1 : 0, message, toSeller ? 1 : 0, id],
    );
    if (sellerAccount) {
      await notifySeller(row.seller_id, { type: "message", title: `New message about ${row.livestock_title}`, body: message, link: "/seller/?tab=messages" });
    }
    res.json({
      success: true,
      customer_emailed: customer.sent,
      customer_error: customer.sent ? null : customer.error,
      to_seller: toSeller,
      seller_in_dashboard: sellerAccount,
      seller_emailed: seller.sent,
    });
  } catch (error) {
    next(error);
  }
});

// Retry the notification email for an inquiry whose email failed.
router.post("/:id/resend-email", async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id);
    const [rows] = await pool.query(
      `SELECT i.*, s.name AS seller_current_name, s.business_name AS seller_business_name,
         s.phone AS seller_phone, s.email AS seller_email, s.status AS seller_status FROM inquiries i LEFT JOIN sellers s ON s.id = i.seller_id WHERE i.id = ?`,
      [id],
    );
    if (!rows.length) throw notFound("Inquiry not found.");
    try {
      await sendInquiryNotification({ ...rows[0], created_at: new Date(rows[0].created_at) });
      await pool.query("UPDATE inquiries SET email_status = 'sent', email_error = NULL WHERE id = ?", [id]);
      res.json({ success: true, message: "Notification email sent." });
    } catch (mailError) {
      await pool.query("UPDATE inquiries SET email_status = 'failed', email_error = ? WHERE id = ?", [
        String(mailError.message).slice(0, 500),
        id,
      ]);
      throw badRequest(`Email could not be sent: ${mailError.message}`);
    }
  } catch (error) {
    next(error);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    const [result] = await pool.query("DELETE FROM inquiries WHERE id = ?", [positiveInt(req.params.id)]);
    if (!result.affectedRows) throw notFound("Inquiry not found.");
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
