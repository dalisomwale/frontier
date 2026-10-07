// Inquiry notification email.
//
// All SMTP settings come from environment variables (see .env.example) and
// are only ever used here, on the server. Nothing about email is exposed to
// the browser.
const nodemailer = require("nodemailer");

const DEFAULT_RECIPIENTS = [
  "mpimpa.miyoba@gmail.com",
  "dalisomwale003@gmail.com",
];

function recipients() {
  const configured = (process.env.INQUIRY_NOTIFY_EMAILS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return configured.length ? configured : DEFAULT_RECIPIENTS;
}

// Placeholder values from .env.example that mean "not filled in yet".
const PLACEHOLDERS = [
  "PASTE_APP_PASSWORD_HERE",
  "your-16-character-app-password",
  "sending-account@gmail.com",
];

/**
 * What the app knows about its email settings, without the password.
 * `problems` lists what's missing or still a placeholder in .env.
 */
function emailConfig() {
  const host = (process.env.SMTP_HOST || "").trim();
  const port = Number(process.env.SMTP_PORT) || 587;
  const secure =
    process.env.SMTP_SECURE !== undefined && process.env.SMTP_SECURE !== ""
      ? process.env.SMTP_SECURE === "true"
      : port === 465;
  const user = (process.env.SMTP_USER || "").trim();
  let pass = process.env.SMTP_PASS || "";
  // Google shows App Passwords in four groups ("abcd efgh ijkl mnop");
  // the spaces aren't part of the password.
  if (/gmail\.com$/i.test(host)) pass = pass.replace(/\s+/g, "");

  // A login is required for Gmail; some other servers (e.g. a local relay)
  // accept mail without one, so there only a username without a password
  // is flagged.
  const isGmail = /gmail\.com$/i.test(host);
  const problems = [];
  if (!host) problems.push("SMTP_HOST is not set");
  if (host && isGmail && !user) problems.push("SMTP_USER is not set");
  if (host && user && !pass) problems.push("SMTP_PASS is not set");
  if (PLACEHOLDERS.includes(user)) problems.push("SMTP_USER is still the example value");
  if (PLACEHOLDERS.includes(pass)) problems.push("SMTP_PASS is still the placeholder - paste the Gmail App Password");
  if (isGmail && pass && !PLACEHOLDERS.includes(pass) && pass.length !== 16) {
    problems.push("SMTP_PASS should be the 16-letter Gmail App Password (not your normal Gmail password)");
  }

  return {
    configured: problems.length === 0,
    problems,
    host,
    port,
    secure,
    user,
    pass,
    from: process.env.MAIL_FROM || `"Frontier Marketplace" <${user || "no-reply@localhost"}>`,
    recipients: recipients(),
  };
}

let transporter = null;
let transporterKey = "";

function getTransporter() {
  const config = emailConfig();
  if (!config.configured) {
    throw new Error(`Email is not set up: ${config.problems.join("; ")}. Fix it in .env, then restart the app.`);
  }
  // Rebuild if the settings changed (e.g. after a restart with a new .env).
  const key = [config.host, config.port, config.secure, config.user, config.pass].join("|");
  if (transporter && key === transporterKey) return transporter;
  transporterKey = key;
  transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user ? { user: config.user, pass: config.pass } : undefined,
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
  return transporter;
}

/**
 * Turns SMTP errors into something an admin can act on.
 */
function friendlyEmailError(error) {
  const message = String(error?.message || error || "Unknown error");
  const config = emailConfig();
  if (error?.code === "EAUTH" || /535|Username and Password not accepted|Invalid login/i.test(message)) {
    return /gmail/i.test(config.host)
      ? "Gmail rejected the login. Check SMTP_USER is the full Gmail address and SMTP_PASS is a 16-letter App Password for that same account (not the normal Gmail password)."
      : `The email server rejected the login for ${config.user}. Check SMTP_USER and SMTP_PASS.`;
  }
  if (["ETIMEDOUT", "ESOCKET", "ECONNECTION", "ECONNREFUSED"].includes(error?.code) || /timeout|ECONNREFUSED/i.test(message)) {
    return `Couldn't connect to ${config.host}:${config.port}. The server may be blocking outgoing email on that port - try SMTP_PORT=587 with SMTP_SECURE=false, or ask the hosting provider to allow it.`;
  }
  if (error?.code === "EDNS" || /ENOTFOUND|EAI_AGAIN/i.test(message)) {
    return `The email server "${config.host}" couldn't be found. Check SMTP_HOST in .env.`;
  }
  return message;
}

/**
 * Connects and logs in without sending anything.
 */
async function verifyEmail() {
  try {
    await getTransporter().verify();
    return { ok: true };
  } catch (error) {
    return { ok: false, message: friendlyEmailError(error) };
  }
}

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[c],
  );
}

function formatDate(date) {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: process.env.APP_TIMEZONE || "Africa/Lusaka",
  }).format(date);
}

function buildInquiryEmail(inquiry) {
  const date = formatDate(inquiry.created_at || new Date());
  const rows = [
    ["Livestock", inquiry.livestock_title],
    ["Category", [inquiry.animal_name, inquiry.category_name].filter(Boolean).join(" · ") || "-"],
    ["Breed", inquiry.breed_name || "-"],
    ["Seller", inquiry.seller_name ? [inquiry.seller_name, inquiry.seller_phone].filter(Boolean).join("\n") : "Frontier's stock"],
    ["Full Name", inquiry.full_name],
    ["Phone", inquiry.phone],
    ["Email", inquiry.email],
    ["Message", inquiry.message],
    ["Date", date],
  ];

  const subject = `New Livestock Inquiry — ${inquiry.livestock_title}`;
  const text = [
    "New Livestock Inquiry — Frontier Marketplace",
    "",
    ...rows.flatMap(([label, value]) => [`${label}:`, value, ""]),
    inquiry.admin_url ? `Open in admin dashboard: ${inquiry.admin_url}` : "",
  ].join("\n");

  const htmlRows = rows
    .map(
      ([label, value]) => `
        <tr>
          <td style="padding:10px 14px;border-bottom:1px solid #e5e7eb;color:#6b7280;font-size:13px;width:120px;vertical-align:top;">${label}</td>
          <td style="padding:10px 14px;border-bottom:1px solid #e5e7eb;color:#111827;font-size:14px;white-space:pre-wrap;">${
            label === "Email"
              ? `<a href="mailto:${escapeHtml(value)}" style="color:#2563eb;">${escapeHtml(value)}</a>`
              : label === "Phone"
                ? `<a href="tel:${escapeHtml(String(value).replace(/[^\d+]/g, ""))}" style="color:#2563eb;">${escapeHtml(value)}</a>`
                : escapeHtml(value)
          }</td>
        </tr>`,
    )
    .join("");

  const html = `<!doctype html>
<html><body style="margin:0;background:#f3f4f6;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:24px 12px;">
    <div style="background:#0b2a5e;color:#fff;border-radius:12px 12px 0 0;padding:18px 20px;">
      <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#93c5fd;">Frontier Marketplace</div>
      <div style="font-size:20px;font-weight:700;margin-top:4px;">New Livestock Inquiry</div>
    </div>
    <table role="presentation" style="width:100%;border-collapse:collapse;background:#fff;">${htmlRows}</table>
    <div style="background:#fff;border-radius:0 0 12px 12px;padding:16px 20px;">
      ${
        inquiry.admin_url
          ? `<a href="${escapeHtml(inquiry.admin_url)}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600;font-size:14px;">Open in admin dashboard</a>`
          : ""
      }
      <p style="color:#9ca3af;font-size:12px;margin:14px 0 0;">Reply to this email to respond to ${escapeHtml(inquiry.full_name)} directly.</p>
    </div>
  </div>
</body></html>`;

  return { subject, text, html };
}

async function sendInquiryNotification(inquiry) {
  const { subject, text, html } = buildInquiryEmail(inquiry);
  const to = recipients();
  const mailer = getTransporter();
  const info = await mailer.sendMail({
    from: emailConfig().from,
    to: to.join(", "),
    replyTo: `"${inquiry.full_name.replace(/"/g, "")}" <${inquiry.email}>`,
    subject,
    text,
    html,
  });
  return { messageId: info.messageId, accepted: info.accepted, to };
}

// Wraps sending so callers always get the friendly message.
async function sendInquiryNotificationSafe(inquiry) {
  try {
    return await sendInquiryNotification(inquiry);
  } catch (error) {
    throw new Error(friendlyEmailError(error));
  }
}

function appUrl(path = "/") {
  const base = (process.env.APP_URL || "").replace(/\/+$/, "");
  return base ? `${base}${path}` : path;
}

// A short branded email: a heading, a few paragraphs and an optional button.
function buildSimpleEmail({ heading, paragraphs = [], rows = [], button = null }) {
  const text = [
    heading,
    "",
    ...paragraphs,
    ...(rows.length ? ["", ...rows.map(([label, value]) => `${label}: ${value}`)] : []),
    ...(button ? ["", `${button.label}: ${button.url}`] : []),
  ].join("\n");
  const html = `<!doctype html>
<html><body style="margin:0;background:#f3f4f6;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:24px 12px;">
    <div style="background:#0b2a5e;color:#fff;border-radius:12px 12px 0 0;padding:18px 20px;">
      <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#93c5fd;">Frontier Marketplace</div>
      <div style="font-size:20px;font-weight:700;margin-top:4px;">${escapeHtml(heading)}</div>
    </div>
    <div style="background:#fff;border-radius:0 0 12px 12px;padding:18px 20px;color:#111827;font-size:14px;line-height:1.55;">
      ${paragraphs.map((p) => `<p style="margin:0 0 12px;white-space:pre-wrap;">${escapeHtml(p)}</p>`).join("")}
      ${rows.length ? `<table role="presentation" style="width:100%;border-collapse:collapse;margin:4px 0 12px;">${rows
        .map(([label, value]) => `<tr><td style="padding:6px 0;color:#6b7280;width:130px;vertical-align:top;">${escapeHtml(label)}</td><td style="padding:6px 0;white-space:pre-wrap;">${escapeHtml(value)}</td></tr>`)
        .join("")}</table>` : ""}
      ${button ? `<a href="${escapeHtml(button.url)}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600;font-size:14px;">${escapeHtml(button.label)}</a>` : ""}
    </div>
  </div>
</body></html>`;
  return { text, html };
}

// Sends one email. Never throws: account and listing notices must not break
// the action that triggered them, so failures are logged and reported.
async function sendEmail({ to, subject, ...content }) {
  const list = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!list.length) return { sent: false, error: "No recipient" };
  if (!emailConfig().configured) return { sent: false, error: "Email is not set up" };
  try {
    const { text, html } = buildSimpleEmail(content);
    await getTransporter().sendMail({ from: emailConfig().from, to: list.join(", "), subject, text, html });
    return { sent: true };
  } catch (error) {
    console.error(`Email "${subject}" failed:`, error.message);
    return { sent: false, error: friendlyEmailError(error) };
  }
}

module.exports = {
  sendEmail,
  appUrl,
  sendInquiryNotification: sendInquiryNotificationSafe,
  buildInquiryEmail,
  recipients,
  emailConfig,
  verifyEmail,
  friendlyEmailError,
};
