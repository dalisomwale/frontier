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

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.SMTP_HOST) {
    throw new Error("SMTP_HOST is not configured");
  }
  const port = Number(process.env.SMTP_PORT) || 587;
  const secure =
    process.env.SMTP_SECURE !== undefined && process.env.SMTP_SECURE !== ""
      ? process.env.SMTP_SECURE === "true"
      : port === 465;

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
  return transporter;
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
    ["Category", inquiry.category_name || "-"],
    ["Breed", inquiry.breed_name || "-"],
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
  const info = await getTransporter().sendMail({
    from:
      process.env.MAIL_FROM ||
      `"Frontier Marketplace" <${process.env.SMTP_USER || "no-reply@localhost"}>`,
    to: to.join(", "),
    replyTo: `"${inquiry.full_name.replace(/"/g, "")}" <${inquiry.email}>`,
    subject,
    text,
    html,
  });
  return { messageId: info.messageId, accepted: info.accepted, to };
}

module.exports = {
  sendInquiryNotification,
  buildInquiryEmail,
  recipients,
  getTransporter,
};
