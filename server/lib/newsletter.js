// Newsletter: sign-ups from the bottom of the site, unsubscribing, and
// sending a newsletter to everyone subscribed.
//
// Every email carries the reader's own unsubscribe link (and the
// List-Unsubscribe header, so mail apps can show their own button).
// A newsletter is sent one email at a time in the background, paced for the
// SMTP account's limits; what's left resumes after a restart (scheduler).
const crypto = require("crypto");
const pool = require("../db");
const { sendEmail, appUrl, emailConfig } = require("../services/mailer");
const { isEmail, HttpError } = require("./validate");

const PACE_MS = Number(process.env.NEWSLETTER_PACE_MS) || 1500;

function validationError(errors) {
  const e = new HttpError(422, "Please correct the highlighted fields.");
  e.errors = errors;
  return e;
}

const normalEmail = (value) => String(value || "").trim().toLowerCase();
const unsubscribeLink = (token) => appUrl(`/newsletter/unsubscribe?token=${token}`);

// Mail apps' own "Unsubscribe" button: only with a full https address.
function unsubscribeHeaders(token) {
  const url = appUrl(`/api/newsletter/unsubscribe?token=${token}`);
  if (!/^https?:\/\//.test(url)) return undefined;
  return { "List-Unsubscribe": `<${url}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
}

function welcome(sub) {
  return sendEmail({
    to: sub.email,
    subject: "You're subscribed to Frontier Marketplace news",
    heading: "Welcome to Frontier Marketplace news",
    paragraphs: [
      "Thank you for subscribing. You'll be among the first to hear about new livestock and feed, promotions and offers, and other useful news from Frontier Farms & Consult.",
      "We only send what's worth your time, and you can unsubscribe at any moment with the link at the bottom of every email.",
    ],
    button: { label: "Visit the marketplace", url: appUrl("/") },
    unsubscribeUrl: unsubscribeLink(sub.token),
    headers: unsubscribeHeaders(sub.token),
  });
}

// Signs an address up (or back up). The answer is the same whether or not it
// was already on the list, so the form doesn't reveal who has subscribed.
async function subscribe(rawEmail, source = "footer") {
  const email = normalEmail(rawEmail);
  if (!isEmail(email)) throw validationError({ email: "Please enter a valid email address." });
  const [[had]] = await pool.query("SELECT * FROM newsletter_subscribers WHERE email = ?", [email]);
  if (had && had.status === "subscribed") return { created: false };
  let sub;
  if (had) {
    await pool.query("UPDATE newsletter_subscribers SET status = 'subscribed', subscribed_at = NOW(), unsubscribed_at = NULL, source = ? WHERE id = ?", [source, had.id]);
    sub = had;
  } else {
    const token = crypto.randomBytes(16).toString("hex");
    try {
      await pool.query("INSERT INTO newsletter_subscribers (email, source, token, subscribed_at) VALUES (?, ?, ?, NOW())", [email, source, token]);
    } catch (error) {
      if (error.code === "ER_DUP_ENTRY") return { created: false };
      throw error;
    }
    sub = { email, token };
  }
  welcome(sub).catch(() => {});
  return { created: true };
}

async function byToken(token) {
  if (!/^[a-f0-9]{32}$/.test(String(token || ""))) return null;
  const [[sub]] = await pool.query("SELECT * FROM newsletter_subscribers WHERE token = ?", [token]);
  return sub || null;
}

async function unsubscribe(token) {
  const sub = await byToken(token);
  if (!sub) throw new HttpError(404, "This unsubscribe link isn't valid. It may be incomplete: please use the link from the email.");
  if (sub.status !== "unsubscribed") {
    await pool.query("UPDATE newsletter_subscribers SET status = 'unsubscribed', unsubscribed_at = NOW() WHERE id = ?", [sub.id]);
    await pool.query("UPDATE newsletter_sends SET status = 'skipped' WHERE subscriber_id = ? AND status = 'pending'", [sub.id]);
  }
  return sub;
}

async function resubscribe(token) {
  const sub = await byToken(token);
  if (!sub) throw new HttpError(404, "This link isn't valid. Please subscribe again at the bottom of the site.");
  if (sub.status !== "subscribed") {
    await pool.query("UPDATE newsletter_subscribers SET status = 'subscribed', subscribed_at = NOW(), unsubscribed_at = NULL WHERE id = ?", [sub.id]);
  }
  return sub;
}

// ------------------------------------------------------------- newsletters
// The admin's message: paragraphs split on blank lines, optional button.
function readCampaign(body = {}) {
  const clean = (v, max) => String(v || "").trim().slice(0, max);
  const c = {
    subject: clean(body.subject, 200),
    heading: clean(body.heading, 200),
    body: String(body.body || "").replace(/\r\n/g, "\n").trim().slice(0, 20000),
    button_label: clean(body.button_label, 60) || null,
    button_url: clean(body.button_url, 500) || null,
  };
  if (!c.heading) c.heading = c.subject;
  const errors = {};
  if (c.subject.length < 3) errors.subject = "Enter a subject line.";
  if (c.body.length < 10) errors.body = "Write the message.";
  if (c.button_label && !c.button_url) errors.button_url = "Enter the link for the button.";
  if (c.button_url && !/^(https?:\/\/|\/)/.test(c.button_url)) errors.button_url = "Use a full link (https://...) or a page on the site (/...).";
  if (c.button_url && !c.button_label) errors.button_label = "Enter the button's text.";
  if (Object.keys(errors).length) throw validationError(errors);
  return c;
}

function campaignEmail(c, sub) {
  return {
    to: sub.email,
    subject: c.subject,
    heading: c.heading,
    paragraphs: c.body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean),
    button: c.button_url ? { label: c.button_label, url: c.button_url.startsWith("/") ? appUrl(c.button_url) : c.button_url } : null,
    unsubscribeUrl: unsubscribeLink(sub.token),
    headers: unsubscribeHeaders(sub.token),
  };
}

// A test copy to one address (the admin), with a sample unsubscribe link.
async function sendTest(body, to) {
  const c = readCampaign(body);
  const res = await sendEmail({ ...campaignEmail(c, { email: to, token: "0".repeat(32) }), subject: `[Test] ${c.subject}` });
  if (!res.sent) throw new HttpError(409, `The test email wasn't sent: ${res.error}`);
}

async function createCampaign(body, admin) {
  const c = readCampaign(body);
  const mail = emailConfig();
  if (!mail.configured) throw new HttpError(409, `Email isn't set up on the server (${mail.problems.join("; ")}), so nothing was sent.`);
  const conn = await pool.getConnection();
  let id;
  let recipients;
  try {
    await conn.beginTransaction();
    const [r] = await conn.query(
      "INSERT INTO newsletter_campaigns (subject, heading, body, button_label, button_url, sent_by) VALUES (?, ?, ?, ?, ?, ?)",
      [c.subject, c.heading, c.body, c.button_label, c.button_url, admin ? admin.name : null],
    );
    id = r.insertId;
    const [added] = await conn.query(
      "INSERT INTO newsletter_sends (campaign_id, subscriber_id) SELECT ?, id FROM newsletter_subscribers WHERE status = 'subscribed'",
      [id],
    );
    recipients = added.affectedRows;
    if (!recipients) {
      await conn.rollback();
      throw new HttpError(409, "There are no subscribers to send to yet.");
    }
    await conn.query("UPDATE newsletter_campaigns SET recipients = ? WHERE id = ?", [recipients, id]);
    await conn.commit();
  } catch (error) {
    await conn.rollback().catch(() => {});
    throw error;
  } finally {
    conn.release();
  }
  run();
  return { id, recipients };
}

// The background sender. One at a time in this process; safe to call often.
let running = false;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function run() {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const [[next]] = await pool.query(
        `SELECT s.id, s.campaign_id, n.email, n.token, n.status AS sub_status, c.subject, c.heading, c.body, c.button_label, c.button_url
         FROM newsletter_sends s
         JOIN newsletter_subscribers n ON n.id = s.subscriber_id
         JOIN newsletter_campaigns c ON c.id = s.campaign_id
         WHERE s.status = 'pending' AND c.status = 'sending'
         ORDER BY s.id LIMIT 1`,
      );
      if (!next) break;
      if (next.sub_status !== "subscribed") {
        await pool.query("UPDATE newsletter_sends SET status = 'skipped' WHERE id = ?", [next.id]);
      } else {
        const res = await sendEmail(campaignEmail(next, next));
        await pool.query("UPDATE newsletter_sends SET status = ?, error = ?, sent_at = NOW() WHERE id = ?", [res.sent ? "sent" : "failed", res.sent ? null : String(res.error || "").slice(0, 255), next.id]);
        await pause(PACE_MS);
      }
    }
    // Campaigns with nothing left to send are finished.
    await pool.query(
      `UPDATE newsletter_campaigns c SET status = 'sent', finished_at = NOW()
       WHERE c.status = 'sending' AND NOT EXISTS (SELECT 1 FROM newsletter_sends s WHERE s.campaign_id = c.id AND s.status = 'pending')`,
    );
  } catch (error) {
    console.error(`Newsletter sending: ${error.message}`);
  } finally {
    running = false;
  }
}

module.exports = { subscribe, unsubscribe, resubscribe, byToken, readCampaign, sendTest, createCampaign, run };
