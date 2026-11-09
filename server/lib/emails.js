// Every email Frontier Marketplace sends to customers, sellers and the team,
// in one place. Routes call these after the action has been saved; sending
// never throws (see sendEmail), so an email problem can't undo an action.
const pool = require("../db");
const { sendEmail, recipients, appUrl } = require("../services/mailer");
const { orderRef, kwacha, headCount, paymentText, STATUS_LABELS, OPERATOR_LABELS } = require("./orders");

const firstName = (name) => String(name || "").trim().split(/\s+/)[0] || "there";
const hi = (name) => `Hi ${firstName(name)},`;
const listingLink = (id) => appUrl(`/listing.html?id=${id}`);
const isFeed = (kind) => kind === "feed";
const reservedWord = (kind) => (isFeed(kind) ? "The feed is" : "The animals are");

function priceText(price, unit, animalName, kind) {
  if (price === null || price === undefined || price === "") return "Price on request";
  if (unit === "lot") return `${kwacha(price)} for the lot`;
  const each = isFeed(kind) ? "bag" : animalName === "Poultry" ? "bird" : "head";
  return `${kwacha(price)} per ${each}`;
}

async function sellerById(id) {
  if (!id) return null;
  const [[seller]] = await pool.query("SELECT id, name, business_name, email, phone FROM sellers WHERE id = ?", [id]);
  return seller && seller.email ? seller : null;
}

const DASHBOARD = () => ({ label: "Go to your dashboard", url: appUrl("/seller/") });

// --- Customers -------------------------------------------------------------

// Auto-reply when someone sends a question with Contact Seller.
function inquiryReceived(inquiry, item) {
  return sendEmail({
    to: inquiry.email,
    subject: `We've received your inquiry about ${item.title}`,
    heading: "Thank you for your inquiry",
    paragraphs: [
      hi(inquiry.full_name),
      `Thank you for your interest in ${item.title}. We've received your message and our team will get back to you within one working day, usually much sooner.`,
    ],
    quote: inquiry.message,
    rows: [
      ["Listing", item.title],
      ...(item.location ? [["Province", item.location]] : []),
      ["Price", priceText(item.price, item.price_unit, item.animal_name, item.animal_kind)],
      ["Your reference", `INQ-${1000 + Number(inquiry.id)}`],
    ],
    button: { label: "View the listing", url: listingLink(item.id) },
    after: ["If anything changes, just reply to this email."],
  });
}

// Order placed with Buy Now.
function orderReceived(order, item) {
  const units = headCount(order.quantity, item.animal_name, item.animal_kind);
  const lot = order.price_unit === "lot";
  const paysOnline = order.payment_method === "mobile_money" && order.online;
  return sendEmail({
    to: order.email,
    subject: `Order ${orderRef(order.id)} received: ${item.title}`,
    heading: `Order ${orderRef(order.id)} received`,
    paragraphs: [hi(order.full_name), `Thank you for your order. ${reservedWord(item.animal_kind)} now reserved for you.`],
    rows: [
      ["Order", orderRef(order.id)],
      ["Listing", item.title],
      ["Quantity", lot ? `The whole lot (${units})` : units],
      ["Total", kwacha(order.total)],
      ["Collection", `Collect from the farm${item.location ? ` (${item.location} Province)` : ""}`],
      ["Payment", paymentText(order)],
    ],
    stepsTitle: "What happens next",
    steps: [
      "We confirm availability with the seller.",
      paysOnline ? "Approve the mobile money prompt on your phone, if you haven't yet." : "We send you payment details, unless you've already paid on the website.",
      "We'll contact you to arrange collection.",
    ],
  });
}

// Status changes from Admin > Orders (and a message without a change).
function orderUpdate(order, { status, changed, message, kind }) {
  const ref = orderRef(order.id);
  const paidOnline = order.payment_status === "paid";
  const lines = {
    new: { subject: `Order ${ref} is being processed`, heading: `Order ${ref}`, text: `Your order ${ref} is with our team again.` },
    confirmed: paidOnline
      ? { subject: `Order ${ref} confirmed`, heading: "Good news: your order is confirmed", text: `The seller has confirmed your order ${ref}. We'll contact you to arrange collection.` }
      : { subject: `Order ${ref} confirmed: please complete payment`, heading: "Good news: your order is confirmed", text: `The seller has confirmed your order ${ref}. Please complete payment so we can arrange collection.` },
    paid: { subject: `Payment received for order ${ref}`, heading: "Payment received", text: `We've received your payment for order ${ref}. Thank you. We'll contact you to arrange collection.` },
    completed: { subject: `Thank you for buying on Frontier Marketplace (${ref})`, heading: "Thank you for your purchase", text: `Order ${ref} is complete. Thank you for buying on Frontier Marketplace, and we hope ${isFeed(kind) ? "the feed serves you well" : "the animals settle in well"}.` },
    cancelled: { subject: `Order ${ref} has been cancelled`, heading: `Order ${ref} cancelled`, text: `Your order ${ref} for ${order.livestock_title} has been cancelled.` },
  };
  if (!changed) {
    return sendEmail({
      to: order.email,
      subject: `Order ${ref}: message from Frontier`,
      heading: `About your order ${ref}`,
      paragraphs: [hi(order.full_name)],
      quote: message,
      rows: [["Order", ref], ["Listing", order.livestock_title]],
      after: ["Reply to this email if you have any questions."],
    });
  }
  const l = lines[status];
  const wasPaid = paidOnline || ["paid", "completed"].includes(order.previous_status);
  const after = {
    completed: ["We'd love to hear how it went. Just reply to this email with any feedback; it helps us and our farmers."],
    cancelled: wasPaid ? ["You've already paid, so we'll contact you within one working day to arrange your refund."] : ["If you have any questions, just reply to this email."],
  }[status] || [];
  const button = {
    completed: { label: isFeed(kind) ? "Browse more feed" : "Browse more livestock", url: appUrl(isFeed(kind) ? "/#feed" : "/#listings") },
    cancelled: { label: "See similar listings", url: appUrl(isFeed(kind) ? "/#feed" : "/#listings") },
  }[status] || null;
  return sendEmail({
    to: order.email,
    subject: l.subject,
    heading: l.heading,
    paragraphs: [hi(order.full_name), l.text],
    quote: message || null,
    rows: [["Order", ref], ["Listing", order.livestock_title], ["Total", kwacha(order.total)], ["Status", STATUS_LABELS[status]]],
    button,
    after,
  });
}

// A website payment failed and the buyer hasn't paid since (sent once).
function paymentReminder(order) {
  const ref = orderRef(order.id);
  return sendEmail({
    to: order.email,
    subject: `Your payment for order ${ref} didn't go through`,
    heading: "Your payment didn't go through",
    paragraphs: [
      hi(order.full_name),
      `Your mobile money payment for order ${ref} wasn't completed${order.payment_failure ? ` (reason: ${order.payment_failure})` : ""}. Don't worry: your order is still reserved for you.`,
    ],
    rows: [["Order", ref], ["Listing", order.livestock_title], ["Amount", kwacha(order.total)]],
    button: { label: "Try the payment again", url: appUrl(`/pay.html?order=${order.id}&token=${order.public_token}`) },
    after: ["Prefer to pay another way? Reply to this email and we'll help."],
  });
}

// --- Sellers ---------------------------------------------------------------

function sellerWelcome(seller) {
  return sendEmail({
    to: seller.email,
    subject: "Welcome to Frontier Marketplace: we're reviewing your account",
    heading: "Welcome to Frontier Marketplace",
    paragraphs: [
      hi(seller.name),
      `Thank you for registering${seller.business_name ? ` ${seller.business_name}` : ""} as a seller. Our team is reviewing your details and you'll hear from us within one working day.`,
    ],
    rows: [
      ["Name", seller.name],
      ["Farm / business", seller.business_name || "-"],
      ["Phone", seller.phone],
      ...(seller.province ? [["Province", seller.province]] : []),
    ],
    after: ["While you wait, you can sign in and start adding listings. They go live once your account is approved."],
    button: DASHBOARD(),
  });
}

function listingReceived(seller, listing, edited) {
  return sendEmail({
    to: seller.email,
    subject: edited ? `We've received your changes: ${listing.title}` : `We've received your listing: ${listing.title}`,
    heading: "Your listing is being reviewed",
    paragraphs: [
      hi(seller.name),
      `${edited ? "Thanks for updating" : "Thanks for adding"} ${listing.title}. Our team checks every listing before it goes live, usually within a few hours.`,
    ],
    rows: [
      ["Listing", listing.title],
      ["Price", priceText(listing.price, listing.price_unit, listing.animal_name, listing.animal_kind)],
      ...(listing.quantity ? [["Quantity", headCount(listing.quantity, listing.animal_name, listing.animal_kind)]] : []),
      ["Status", "Waiting for review"],
    ],
    after: ["We'll email you as soon as it's live, or if anything needs changing."],
  });
}

async function listingVisibility(sellerId, listing, published, { first = false } = {}) {
  const seller = await sellerById(sellerId);
  if (!seller) return null;
  return sendEmail({
    to: seller.email,
    subject: published ? `Your listing is ${first ? "live" : "back on the website"}: ${listing.title}` : `Your listing was taken off the website: ${listing.title}`,
    heading: published ? (first ? "Your listing is live" : "Your listing is back on the website") : "Your listing is off the website",
    paragraphs: published
      ? [hi(seller.name), `${listing.title} is on Frontier Marketplace${first ? "" : " again"}. Buyers can see it, ask questions and order it.`]
      : [hi(seller.name), `${listing.title} has been taken off the website for now, so buyers can't see it.`],
    button: published ? { label: "View it on the website", url: listingLink(listing.id) } : null,
    after: published ? [] : ["If you think this is a mistake, reply to this email and we'll look into it."],
  });
}

async function listingRemoved(sellerId, listing) {
  const seller = await sellerById(sellerId);
  if (!seller) return null;
  return sendEmail({
    to: seller.email,
    subject: `Your listing was removed: ${listing.title}`,
    heading: "Your listing was removed",
    paragraphs: [hi(seller.name), `We've removed ${listing.title} from Frontier Marketplace.`],
    after: ["Reply to this email if you have questions or would like to list it again."],
  });
}

async function listingSoldOut(sellerId, listing) {
  const seller = await sellerById(sellerId);
  if (!seller) return null;
  return sendEmail({
    to: seller.email,
    subject: `Sold out: ${listing.title}`,
    heading: "Your listing has sold out",
    paragraphs: [hi(seller.name), `Everything on ${listing.title} has been ordered, so the listing is now off the website.`],
    after: ["Have more to sell? Add a new listing or update the quantity and we'll put it back on."],
    button: DASHBOARD(),
  });
}

// The seller hears about an order once it's confirmed, then when it's
// completed or cancelled. Buyers' contact details are never included.
async function sellerOrder(order, event, { units, leftOnListing } = {}) {
  const seller = await sellerById(order.seller_id);
  if (!seller) return null;
  const ref = orderRef(order.id);
  const what = order.price_unit === "lot" ? `The whole lot (${units})` : units;
  const content = {
    new: {
      subject: `New order ${ref}: ${order.livestock_title}`,
      heading: "You have a new order",
      text: `Good news: ${order.price_unit === "lot" ? "the whole lot" : units} from ${order.livestock_title} ${order.quantity === 1 && order.price_unit !== "lot" ? "has" : "have"} been ordered.`,
      rows: [["Order", ref], ["Quantity", what], ["Total", kwacha(order.total)], ["Payment", order.payment_status === "paid" ? "Paid online" : "Being arranged by Frontier"],
        ...(leftOnListing !== undefined ? [["Left on the listing", String(leftOnListing)]] : [])],
      after: ["Our team will contact you to arrange the handover. Please keep these aside for this buyer."],
    },
    completed: {
      subject: `Order ${ref} is complete`,
      heading: "Order complete: thank you",
      text: `Order ${ref} for ${order.livestock_title} is complete. Thank you for selling on Frontier Marketplace.`,
      rows: [["Order", ref], ["Quantity", what], ["Total", kwacha(order.total)]],
      after: ["Our team will be in touch about your payment if it hasn't been settled yet."],
    },
    cancelled: {
      subject: `Order ${ref} was cancelled`,
      heading: "An order was cancelled",
      text: `Order ${ref} for ${what} from ${order.livestock_title} has been cancelled. ${order.livestock_id ? "They're back on your listing and buyers can order them again." : ""}`.trim(),
      rows: [["Order", ref], ["Back on the listing", what]],
      after: [],
    },
  }[event];
  return sendEmail({
    to: seller.email,
    subject: content.subject,
    log: true,
    heading: content.heading,
    paragraphs: [hi(seller.name), content.text],
    rows: content.rows,
    after: content.after,
    button: DASHBOARD(),
  });
}

function passwordChanged(seller, when = new Date()) {
  const at = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: process.env.APP_TIMEZONE || "Africa/Lusaka" }).format(when);
  return sendEmail({
    to: seller.email,
    subject: "Your Frontier Marketplace password was changed",
    heading: "Your password was changed",
    paragraphs: [
      hi(seller.name),
      `The password for your seller account was changed on ${at}.`,
      "If this was you, there's nothing to do. If it wasn't, reset your password straight away and reply to this email so we can help.",
    ],
    button: { label: "Reset my password", url: appUrl("/seller/forgot.html") },
  });
}

async function accountStatus(sellerId, active) {
  const seller = await sellerById(sellerId);
  if (!seller) return null;
  return sendEmail({
    to: seller.email,
    subject: active ? "Your seller account is active again" : "Your seller account has been paused",
    heading: active ? "Your seller account is active again" : "Your seller account is paused",
    paragraphs: active
      ? [hi(seller.name), `Your seller account${seller.business_name ? ` for ${seller.business_name}` : ""} is active again. You can sign in and manage your listings as usual.`]
      : [hi(seller.name), `Your seller account${seller.business_name ? ` for ${seller.business_name}` : ""} has been paused, so you can't sign in or make changes for now.`],
    button: active ? DASHBOARD() : null,
    after: active ? [] : ["Reply to this email if you have questions."],
  });
}

// --- Frontier team ---------------------------------------------------------

function unpaidOrder(order) {
  const ref = orderRef(order.id);
  return sendEmail({
    to: recipients(),
    subject: `Unpaid order ${ref}: payment didn't go through`,
    heading: `Order ${ref} is unpaid`,
    paragraphs: [`${order.full_name}'s mobile money payment for order ${ref} wasn't completed${order.payment_failure ? ` (${order.payment_failure})` : ""}. The order is still reserved. You may want to follow up.`],
    rows: [
      ["Listing", order.livestock_title],
      ["Total", kwacha(order.total)],
      ["WhatsApp", order.phone],
      ["Paying from", `${OPERATOR_LABELS[order.mobile_operator] || "Mobile money"} ${order.payment_phone || ""}`.trim()],
      ["Attempts", String(order.payment_attempts || 1)],
    ],
    button: { label: "Open order", url: appUrl(`/admin/orders.html?id=${order.id}`) },
  });
}

function dailySummary(stats) {
  const parts = [];
  if (stats.newOrders) parts.push(`${stats.newOrders} new order${stats.newOrders === 1 ? "" : "s"}`);
  if (stats.openInquiries) parts.push(`${stats.openInquiries} inquir${stats.openInquiries === 1 ? "y" : "ies"} waiting`);
  if (stats.pendingListings) parts.push(`${stats.pendingListings} listing${stats.pendingListings === 1 ? "" : "s"} to review`);
  if (stats.pendingSellers) parts.push(`${stats.pendingSellers} seller${stats.pendingSellers === 1 ? "" : "s"} to approve`);
  return sendEmail({
    to: recipients(),
    subject: `Frontier today: ${parts.join(", ") || "all clear"}`,
    heading: "Good morning: here's what needs attention",
    rows: [
      ["New orders (last 24 h)", `${stats.newOrders}${stats.unpaidOrders ? ` (${stats.unpaidOrders} unpaid)` : ""}`],
      ["Orders waiting for action", String(stats.openOrders)],
      ["Inquiries not yet replied to", String(stats.openInquiries)],
      ["Listings to review", String(stats.pendingListings)],
      ["Sellers to approve", String(stats.pendingSellers)],
      ["Paid online yesterday", kwacha(stats.paidYesterday)],
    ],
    button: { label: "Open the dashboard", url: appUrl("/admin/") },
  });
}

module.exports = {
  priceText,
  inquiryReceived,
  orderReceived,
  orderUpdate,
  paymentReminder,
  sellerWelcome,
  listingReceived,
  listingVisibility,
  listingRemoved,
  listingSoldOut,
  sellerOrder,
  passwordChanged,
  accountStatus,
  unpaidOrder,
  dailySummary,
};
