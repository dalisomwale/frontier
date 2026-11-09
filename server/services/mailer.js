// Email: the branded template, inquiry notifications and sendEmail().
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
  const rows = [
    ["Livestock", inquiry.livestock_title],
    ["Category", [inquiry.animal_name, inquiry.category_name].filter(Boolean).join(" · ") || "-"],
    ["Breed", inquiry.breed_name || "-"],
    ["Seller", inquiry.seller_name ? [inquiry.seller_name, inquiry.seller_phone].filter(Boolean).join("\n") : "Frontier's stock"],
    ["Customer", inquiry.full_name],
    ["Phone", inquiry.phone],
    ["Email", inquiry.email],
    ["Date", formatDate(inquiry.created_at || new Date())],
  ];
  const subject = `New inquiry: ${inquiry.livestock_title}`;
  const { text, html } = renderEmail({
    audience: "team",
    heading: "New livestock inquiry",
    paragraphs: [`${inquiry.full_name} asked about "${inquiry.livestock_title}":`],
    quote: inquiry.message,
    rows,
    button: inquiry.admin_url ? { label: "Open in admin", url: inquiry.admin_url } : null,
    after: [`Reply to this email to answer ${inquiry.full_name} directly.`],
  });
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

// Who to tell people to contact, from .env:
//   SUPPORT_PHONE   phone / WhatsApp shown at the bottom of customer emails
//   REPLY_TO_EMAIL  where replies to customer and seller emails go
function contactSettings() {
  return {
    phone: (process.env.SUPPORT_PHONE || "").trim(),
    replyTo: (process.env.REPLY_TO_EMAIL || "").trim(),
  };
}

function siteName() {
  try {
    return new URL(process.env.APP_URL || "").host || "marketplace.frontierfc.co.zm";
  } catch {
    return "marketplace.frontierfc.co.zm";
  }
}

const C = { deep: "#10231a", leaf: "#1f3d2b", lime: "#bef264", sun: "#fde047", ink: "#1f2937", muted: "#6b7280", line: "#edf0ee", page: "#eef1ee" };

/**
 * One branded email (Frontier's green and yellow-lime design).
 *   heading      title in the green header
 *   paragraphs   text before everything else ("Hi Chanda," first)
 *   quote        a message shown as a quote (e.g. what the customer wrote)
 *   rows         [label, value] details table
 *   stepsTitle / steps   a short numbered list ("What happens next")
 *   button       { label, url }
 *   after        text after the button
 *   audience     "public" (customers, sellers: sign-off and contact footer)
 *                or "team" (Frontier's own notifications)
 */
function renderEmail({ heading, paragraphs = [], quote = null, rows = [], stepsTitle = null, steps = [], button = null, after = [], audience = "public" }) {
  const team = audience === "team";
  const { phone } = contactSettings();
  const signOff = team ? [] : ["Kind regards,", "The Frontier Marketplace team"];
  const footerText = team
    ? "Sent to the Frontier team by Frontier Marketplace."
    : `Frontier Marketplace by Frontier Farms & Consult · ${siteName()}\nQuestions? Reply to this email${phone ? ` or call / WhatsApp us on ${phone}` : ""}.`;

  const text = [
    heading,
    "",
    ...paragraphs,
    ...(quote ? ["", ...String(quote).split("\n").map((l) => `> ${l}`)] : []),
    ...(rows.length ? ["", ...rows.map(([label, value]) => `${label}: ${value}`)] : []),
    ...(steps.length ? ["", stepsTitle || "", ...steps.map((st, i) => `${i + 1}. ${st}`)] : []),
    ...(button ? ["", `${button.label}: ${button.url}`] : []),
    ...(after.length ? ["", ...after] : []),
    ...(signOff.length ? ["", ...signOff] : []),
    "",
    "--",
    footerText,
  ].join("\n");

  const p = (t) => `<p style="margin:0 0 12px;white-space:pre-wrap;">${escapeHtml(t)}</p>`;
  const html = `<!doctype html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"></head>
<body style="margin:0;background:${C.page};font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:24px 12px;">
    <div style="border-radius:12px;overflow:hidden;background:#fff;border:1px solid #dfe5e0;">
      <div style="height:4px;background:${C.sun};background-image:linear-gradient(90deg,${C.sun},${C.lime});"></div>
      <div style="background:${C.deep};color:#fff;padding:18px 22px;">
        <div style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:${C.lime};font-weight:700;">Frontier Marketplace</div>
        <div style="font-size:20px;font-weight:700;margin-top:4px;line-height:1.3;">${escapeHtml(heading)}</div>
      </div>
      <div style="padding:20px 22px 8px;color:${C.ink};font-size:14.5px;line-height:1.6;">
        ${paragraphs.map(p).join("")}
        ${quote ? `<div style="margin:0 0 14px;padding:10px 14px;border-left:3px solid ${C.lime};background:#f7faf5;color:#374151;white-space:pre-wrap;">${escapeHtml(quote)}</div>` : ""}
        ${rows.length ? `<table role="presentation" style="width:100%;border-collapse:collapse;margin:4px 0 14px;font-size:14px;">${rows
          .map(([label, value]) => `<tr><td style="padding:7px 10px 7px 0;border-top:1px solid ${C.line};color:${C.muted};width:140px;vertical-align:top;">${escapeHtml(label)}</td><td style="padding:7px 0;border-top:1px solid ${C.line};white-space:pre-wrap;">${escapeHtml(value)}</td></tr>`)
          .join("")}</table>` : ""}
        ${steps.length ? `${stepsTitle ? `<p style="margin:0 0 6px;font-weight:700;">${escapeHtml(stepsTitle)}</p>` : ""}<ol style="margin:0 0 14px;padding-left:20px;">${steps.map((st) => `<li style="margin-bottom:4px;">${escapeHtml(st)}</li>`).join("")}</ol>` : ""}
        ${button ? `<p style="margin:2px 0 14px;"><a href="${escapeHtml(button.url)}" style="display:inline-block;background:${C.leaf};color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;font-size:14px;">${escapeHtml(button.label)}</a></p>` : ""}
        ${after.map(p).join("")}
        ${signOff.length ? `<p style="margin:4px 0 12px;">${signOff.map(escapeHtml).join("<br>")}</p>` : ""}
      </div>
      <div style="padding:14px 22px 18px;border-top:1px solid ${C.line};font-size:12px;color:${C.muted};line-height:1.55;white-space:pre-line;">${escapeHtml(footerText)}</div>
    </div>
  </div>
</body></html>`;
  return { text, html };
}

// Kept for older callers.
function buildSimpleEmail(content) {
  return renderEmail(content);
}

// Sends one email. Never throws: account and listing notices must not break
// the action that triggered them, so failures are logged and reported.
// Team emails (sent to the notification list) get the team layout unless
// the caller says otherwise. Customer and seller emails carry REPLY_TO_EMAIL.
// log: true also writes a line to the app log when the email goes out.
async function sendEmail({ to, subject, replyTo, log, ...content }) {
  const list = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!list.length) return { sent: false, error: "No recipient" };
  if (!emailConfig().configured) {
    if (log) console.error(`Email "${subject}" not sent: email is not set up`);
    return { sent: false, error: "Email is not set up" };
  }
  const team = recipients();
  const audience = content.audience || (list.every((address) => team.includes(address)) ? "team" : "public");
  const reply = replyTo || (audience === "public" ? contactSettings().replyTo : "") || undefined;
  try {
    const { text, html } = renderEmail({ ...content, audience });
    await getTransporter().sendMail({ from: emailConfig().from, to: list.join(", "), replyTo: reply, subject, text, html });
    if (log) console.log(`Email "${subject}" sent to ${list.join(", ")}`);
    return { sent: true };
  } catch (error) {
    console.error(`Email "${subject}" failed:`, error.message);
    return { sent: false, error: friendlyEmailError(error) };
  }
}

module.exports = {
  sendEmail,
  renderEmail,
  contactSettings,
  appUrl,
  sendInquiryNotification: sendInquiryNotificationSafe,
  buildInquiryEmail,
  recipients,
  emailConfig,
  verifyEmail,
  friendlyEmailError,
};
