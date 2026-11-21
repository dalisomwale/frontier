// Transport notices: the in-app notification and email for each party, plus
// live updates for their open pages. Never throws: a notice must not undo the
// step that caused it.
const pool = require("../../db");
const { sendEmail, recipients, appUrl } = require("../../services/mailer");
const notifications = require("../../services/notifications");
const { bookingRef, STATUS_LABELS } = require("./core");

const first = (name) => String(name || "").trim().split(/\s+/)[0] || "there";
const links = {
  customer: (b) => `/account/?tab=orders&delivery=${b.id}`,
  seller: (b) => `/seller/?tab=orders&delivery=${b.id}`,
  provider: (b) => `/transport/?booking=${b.id}`,
  admin: (b) => `/admin/transport?id=${b.id}`,
};

async function contactOf(b) {
  const [[c]] = await pool.query("SELECT full_name, email FROM checkouts WHERE id = ?", [b.checkout_id]);
  return c || null;
}

async function safe(label, task) {
  try {
    return await task();
  } catch (error) {
    console.error(`Transport notice (${label}) failed: ${error.message}`);
    return null;
  }
}

// The buyer: in-app notification (when they have an account) and email.
function customer(b, { title, body, subject, heading, paragraphs = [], rows = [], button }) {
  return safe("customer", async () => {
    const link = links.customer(b);
    if (b.buyer_id) {
      await notifications.notifyBuyer(b.buyer_id, { type: "order", title, body, link });
      notifications.pingBuyer(b.buyer_id, "transport", { booking_id: b.id, status: b.status });
    }
    if (subject) {
      const c = await contactOf(b);
      if (c && c.email) {
        await sendEmail({
          to: c.email,
          subject,
          heading: heading || title,
          paragraphs: [`Hi ${first(c.full_name)},`, ...(paragraphs.length ? paragraphs : [body])],
          rows: [["Delivery", bookingRef(b.id)], ...rows],
          button: button || { label: "View your delivery", url: appUrl(link) },
          log: true,
        });
      }
    }
  });
}

// The seller (Frontier's own stock: the team instead).
function seller(b, { title, body, subject, heading, paragraphs = [], rows = [] }) {
  return safe("seller", async () => {
    if (!b.seller_id) {
      if (subject) await team(b, { subject: `Frontier stock: ${subject}`, heading: heading || title, paragraphs: paragraphs.length ? paragraphs : [body], rows });
      return;
    }
    const link = links.seller(b);
    await notifications.notifySeller(b.seller_id, { type: "order", title, body, link });
    notifications.pingSeller(b.seller_id, "transport", { booking_id: b.id, status: b.status });
    if (subject) {
      const [[s]] = await pool.query("SELECT name, email FROM sellers WHERE id = ?", [b.seller_id]);
      if (s && s.email) {
        await sendEmail({
          to: s.email,
          subject,
          heading: heading || title,
          paragraphs: [`Hi ${first(s.name)},`, ...(paragraphs.length ? paragraphs : [body])],
          rows: [["Delivery", bookingRef(b.id)], ...rows],
          button: { label: "Open in your seller account", url: appUrl(link) },
          log: true,
        });
      }
    }
  });
}

function provider(providerId, b, { title, body, subject, heading, paragraphs = [], rows = [] }) {
  return safe("provider", async () => {
    if (!providerId) return;
    const link = b ? links.provider(b) : "/transport/";
    await notifications.notifyProvider(providerId, { type: "transport", title, body, link });
    if (b) notifications.pingProvider(providerId, "transport", { booking_id: b.id, status: b.status });
    if (subject) {
      const [[p]] = await pool.query("SELECT name, contact_person, email FROM transport_providers WHERE id = ?", [providerId]);
      if (p && p.email) {
        await sendEmail({
          to: p.email,
          subject,
          heading: heading || title,
          paragraphs: [`Hi ${first(p.contact_person || p.name)},`, ...(paragraphs.length ? paragraphs : [body])],
          rows: [...(b ? [["Delivery", bookingRef(b.id)]] : []), ...rows],
          button: { label: "Open your transport dashboard", url: appUrl(link) },
          log: true,
        });
      }
    }
  });
}

// Frontier's team.
function team(b, { subject, heading, paragraphs = [], rows = [] }) {
  return safe("team", async () => {
    await sendEmail({
      to: recipients(),
      subject,
      heading: heading || subject,
      paragraphs,
      rows: [...(b ? [["Delivery", bookingRef(b.id)], ["Status", STATUS_LABELS[b.status] || b.status]] : []), ...rows],
      button: b ? { label: "Open the delivery", url: appUrl(links.admin(b)) } : { label: "Open transport", url: appUrl("/admin/transport") },
      log: true,
    });
  });
}

// Every open page that shows this booking refreshes (no stored notification).
function live(b, change = "status") {
  try {
    const data = { booking_id: b.id, status: b.status, change };
    if (b.buyer_id) notifications.pingBuyer(b.buyer_id, "transport", data);
    if (b.seller_id) notifications.pingSeller(b.seller_id, "transport", data);
    if (b.provider_id) notifications.pingProvider(b.provider_id, "transport", data);
    notifications.broadcastAdmin("transport", { ...data, id: undefined });
  } catch (error) {
    console.error(`Transport live update failed: ${error.message}`);
  }
}

module.exports = { customer, seller, provider, team, live, links };
