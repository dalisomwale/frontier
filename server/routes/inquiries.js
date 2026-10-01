// Public inquiry submission. Visitors need no account: the inquiry is tied to
// the listing they were viewing, saved to the database, and then emailed to
// the marketplace team.
const express = require("express");
const pool = require("../db");
const { sendInquiryNotification } = require("../services/mailer");
const {
  positiveInt,
  text,
  isEmail,
  isPhone,
  badRequest,
  notFound,
} = require("../lib/validate");

const router = express.Router();

const LIMITS = {
  name: { min: 2, max: 120 },
  message: { min: 10, max: 2000 },
};

function validate(body) {
  const errors = {};
  const fullName = text(body.full_name, LIMITS.name.max);
  const phone = text(body.phone, 30);
  const email = text(body.email, 255);
  const message = text(body.message, LIMITS.message.max);

  if (fullName === null) errors.full_name = "Full name is required.";
  else if (fullName === undefined || fullName.length < LIMITS.name.min)
    errors.full_name = `Please enter your full name (${LIMITS.name.min}-${LIMITS.name.max} characters).`;

  if (phone === null) errors.phone = "Phone number is required.";
  else if (phone === undefined || !isPhone(phone))
    errors.phone = "Please enter a valid phone number, e.g. 0977 123 456 or +260 977 123 456.";

  if (email === null) errors.email = "Email is required.";
  else if (email === undefined || !isEmail(email))
    errors.email = "Please enter a valid email address.";

  if (message === null) errors.message = "Message is required.";
  else if (message === undefined)
    errors.message = `Message must be ${LIMITS.message.max} characters or fewer.`;
  else if (message.length < LIMITS.message.min)
    errors.message = `Message must be at least ${LIMITS.message.min} characters.`;

  return {
    errors,
    values: {
      full_name: fullName,
      phone,
      email: email ? email.toLowerCase() : email,
      message,
    },
  };
}

function adminUrl(req, id) {
  const base = (process.env.APP_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
  return `${base}/admin/inquiries.html?id=${id}`;
}

router.post("/", async (req, res, next) => {
  try {
    // Honeypot: real visitors never see or fill this field.
    if (req.body.website) {
      return res.json({ success: true, message: "Your inquiry has been sent successfully." });
    }

    const livestockId = positiveInt(req.body.livestock_id);
    if (!livestockId) throw badRequest("Please choose a livestock listing to inquire about.");

    const { errors, values } = validate(req.body);
    if (Object.keys(errors).length) {
      return res.status(422).json({
        success: false,
        message: "Please correct the highlighted fields.",
        errors,
      });
    }

    const [listing] = await pool.query(
      `SELECT l.id, l.title, c.name AS category_name, b.name AS breed_name
       FROM livestock l
       JOIN categories c ON c.id = l.category_id
       LEFT JOIN breeds b ON b.id = l.breed_id
       WHERE l.id = ? AND l.status = 'published' AND c.status = 'active'`,
      [livestockId],
    );
    if (!listing.length) throw notFound("This listing is no longer available.");
    const item = listing[0];

    const [result] = await pool.query(
      `INSERT INTO inquiries
         (livestock_id, livestock_title, category_name, breed_name,
          full_name, phone, email, message, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        item.id,
        item.title,
        item.category_name,
        item.breed_name,
        values.full_name,
        values.phone,
        values.email,
        values.message,
        req.ip,
      ],
    );
    const inquiryId = result.insertId;

    // The inquiry is already safely stored. If email delivery fails the team
    // still sees it in the dashboard (flagged), so the visitor is not asked
    // to resubmit.
    try {
      await sendInquiryNotification({
        ...values,
        livestock_title: item.title,
        category_name: item.category_name,
        breed_name: item.breed_name,
        created_at: new Date(),
        admin_url: adminUrl(req, inquiryId),
      });
      await pool.query(
        "UPDATE inquiries SET email_status = 'sent', email_error = NULL WHERE id = ?",
        [inquiryId],
      );
    } catch (mailError) {
      console.error(`Inquiry #${inquiryId} email failed:`, mailError.message);
      await pool.query(
        "UPDATE inquiries SET email_status = 'failed', email_error = ? WHERE id = ?",
        [String(mailError.message).slice(0, 500), inquiryId],
      );
    }

    return res.status(201).json({
      success: true,
      message: "Your inquiry has been sent successfully.",
      data: { id: inquiryId },
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
module.exports.validateInquiry = validate;
