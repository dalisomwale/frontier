// Public "Buy Now". Visitors need no account. Nothing is paid on the website:
// the order is saved, the team is emailed, and the buyer gets a confirmation.
// The team then checks availability with the seller and sends payment details.
const express = require("express");
const pool = require("../db");
const { sendEmail, recipients, appUrl } = require("../services/mailer");
const { positiveInt, text, isEmail, isPhone, oneOf, badRequest, notFound } = require("../lib/validate");
const { orderRef, kwacha, headCount, DELIVERY_LABELS, PAYMENT_LABELS } = require("../lib/orders");

const router = express.Router();

function validate(body) {
  const errors = {};
  const fullName = text(body.full_name, 120);
  const phone = text(body.phone, 30);
  const email = text(body.email, 255);
  const delivery = oneOf(body.delivery || "collect", ["collect", "deliver"]);
  const address = text(body.delivery_address, 300);
  const payment = oneOf(body.payment_method || "mobile_money", ["mobile_money", "bank_transfer"]);

  if (!fullName || fullName.length < 2) errors.full_name = "Please enter your full name.";
  if (!phone || !isPhone(phone)) errors.phone = "Please enter a valid WhatsApp number, e.g. 0977 123 456.";
  if (!email || !isEmail(email)) errors.email = "Please enter a valid email address.";
  if (!delivery) errors.delivery = "Please choose collection or delivery.";
  if (delivery === "deliver" && (!address || address.length < 5))
    errors.delivery_address = address === undefined ? "Address must be 300 characters or fewer." : "Please enter the delivery address.";
  if (!payment) errors.payment_method = "Please choose how you'll pay.";

  return {
    errors,
    values: {
      full_name: fullName,
      phone,
      email: email ? email.toLowerCase() : email,
      delivery,
      delivery_address: delivery === "deliver" ? address : null,
      payment_method: payment,
    },
  };
}

router.post("/", async (req, res, next) => {
  try {
    // Honeypot: real visitors never see or fill this field.
    if (req.body.website) return res.status(201).json({ success: true, data: { reference: "FM-0" } });

    const livestockId = positiveInt(req.body.livestock_id);
    if (!livestockId) throw badRequest("Please choose a listing to buy.");

    const [rows] = await pool.query(
      `SELECT l.id, l.title, l.quantity, l.price, l.price_unit, l.location, a.name AS animal_name,
         s.id AS seller_id, s.name AS seller_name, s.business_name AS seller_business_name,
         (SELECT li.thumb_path FROM livestock_images li WHERE li.livestock_id = l.id
            ORDER BY li.sort_order, li.id LIMIT 1) AS thumb_path
       FROM livestock l
       JOIN categories c ON c.id = l.category_id
       JOIN animals a ON a.id = c.animal_id
       LEFT JOIN sellers s ON s.id = l.seller_id
       WHERE l.id = ? AND l.status = 'published' AND c.status = 'active' AND a.status = 'active'`,
      [livestockId],
    );
    if (!rows.length) throw notFound("This listing is no longer available.");
    const item = rows[0];
    if (item.price === null) throw badRequest("This listing has no price yet. Please contact the seller instead.");
    if (Number(item.quantity) < 1) throw badRequest("This listing is sold out.");

    const { errors, values } = validate(req.body);
    // A lot is bought whole; otherwise 1 up to the number available.
    const lot = item.price_unit === "lot";
    const quantity = lot ? Number(item.quantity) : positiveInt(req.body.quantity);
    if (!quantity) errors.quantity = "Please choose how many you want.";
    else if (quantity > Number(item.quantity)) errors.quantity = `Only ${item.quantity} available.`;
    if (Object.keys(errors).length) {
      return res.status(422).json({ success: false, message: "Please correct the highlighted fields.", errors });
    }

    const unitPrice = Number(item.price);
    const total = lot ? unitPrice : Math.round(unitPrice * quantity * 100) / 100;
    const sellerName = item.seller_name
      ? (item.seller_business_name ? `${item.seller_name} (${item.seller_business_name})` : item.seller_name)
      : null;

    const [result] = await pool.query(
      `INSERT INTO orders
         (livestock_id, livestock_title, seller_id, seller_name, quantity, unit_price, price_unit, total,
          full_name, phone, email, delivery, delivery_address, payment_method, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [item.id, item.title, item.seller_id, sellerName, quantity, unitPrice, item.price_unit, total,
        values.full_name, values.phone, values.email, values.delivery, values.delivery_address,
        values.payment_method, req.ip],
    );
    const id = result.insertId;
    const reference = orderRef(id);
    const qtyText = lot ? `The whole lot (${headCount(quantity, item.animal_name)})` : headCount(quantity, item.animal_name);
    const deliveryText = values.delivery === "deliver"
      ? `${DELIVERY_LABELS.deliver}: ${values.delivery_address}`
      : `${DELIVERY_LABELS.collect} (${item.location} Province)`;

    // The order is already saved; email problems are recorded, not shown.
    const [team, buyer] = await Promise.all([
      sendEmail({
        to: recipients(),
        subject: `New order ${reference}: ${item.title}`,
        heading: `New order ${reference}`,
        paragraphs: [`${values.full_name} wants to buy ${lot ? "the whole lot" : headCount(quantity, item.animal_name)} from "${item.title}".`],
        rows: [
          ["Listing", item.title],
          ["Seller", sellerName || "Frontier"],
          ["Quantity", qtyText],
          ["Total", kwacha(total)],
          ["Buyer", values.full_name],
          ["WhatsApp", values.phone],
          ["Email", values.email],
          ["Delivery", deliveryText],
          ["Payment", PAYMENT_LABELS[values.payment_method]],
        ],
        button: { label: "Open order", url: appUrl(`/admin/orders.html?id=${id}`) },
      }),
      sendEmail({
        to: values.email,
        subject: `Order ${reference} received`,
        heading: `Order ${reference} received`,
        paragraphs: [
          `Hi ${values.full_name}, thank you for your order.`,
          "We'll confirm availability with the seller and send payment details to your WhatsApp and email.",
        ],
        rows: [
          ["Listing", item.title],
          ["Quantity", qtyText],
          ["Total", kwacha(total)],
          ["Delivery", deliveryText],
          ["Payment", PAYMENT_LABELS[values.payment_method]],
        ],
      }),
    ]);
    await pool.query("UPDATE orders SET email_status = ?, email_error = ? WHERE id = ?", [
      team.sent ? "sent" : "failed",
      team.sent ? null : String(team.error || "").slice(0, 500),
      id,
    ]);
    if (!buyer.sent) console.error(`Order ${reference}: buyer email not sent (${buyer.error})`);

    return res.status(201).json({
      success: true,
      message: `Order ${reference} received.`,
      data: {
        id,
        reference,
        title: item.title,
        quantity,
        price_unit: item.price_unit,
        total,
        delivery: values.delivery,
        thumb_path: item.thumb_path,
      },
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
module.exports.validateOrder = validate;
