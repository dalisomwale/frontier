// Public "Buy Now". Visitors need no account. Nothing is paid on the website:
// the order is saved, the team is emailed, and the buyer gets a confirmation.
// The team then checks availability with the seller and sends payment details.
const express = require("express");
const pool = require("../db");
const { sendEmail, recipients, appUrl } = require("../services/mailer");
const { positiveInt, text, isEmail, isPhone, oneOf, badRequest, notFound } = require("../lib/validate");
const { orderRef, kwacha, headCount, paymentText, DELIVERY_LABELS } = require("../lib/orders");

const router = express.Router();

function validate(body) {
  const errors = {};
  const fullName = text(body.full_name, 120);
  const phone = text(body.phone, 30);
  const email = text(body.email, 255);
  // Delivery is switched off for now: every order is collected from the farm.
  const delivery = "collect";
  // Bank transfer is no longer offered at checkout (older orders keep it).
  const payment = oneOf(body.payment_method, ["mobile_money", "card"]);
  // Cards: only the type and last 4 digits are ever sent or kept.
  const cardBrand = payment === "card" ? oneOf(body.card_brand, ["visa", "mastercard"]) : null;
  const cardLast4 = payment === "card" && /^\d{4}$/.test(String(body.card_last4 || "")) ? String(body.card_last4) : null;
  const operator = payment === "mobile_money" ? oneOf(body.mobile_operator, ["airtel", "mtn", "zamtel"]) : null;
  const paymentPhone = payment === "mobile_money" ? text(body.payment_phone, 30) : null;

  if (!fullName || fullName.length < 2) errors.full_name = "Please enter your full name.";
  if (!phone || !isPhone(phone)) errors.phone = "Please enter a valid WhatsApp number, e.g. 0977 123 456.";
  if (!email || !isEmail(email)) errors.email = "Please enter a valid email address.";
  if (!payment) errors.payment_method = "Please choose how you'll pay.";
  else if (payment === "mobile_money") {
    if (!operator) errors.mobile_operator = "Please choose your mobile money operator.";
    if (!paymentPhone || !isPhone(paymentPhone)) errors.payment_phone = "Please enter the mobile money number, e.g. 0977 123 456.";
  } else if (payment === "card") {
    if (!cardBrand) errors.card_number = "We accept Visa and Mastercard.";
    else if (!cardLast4) errors.card_number = "Please check the card number.";
  }


  return {
    errors,
    values: {
      full_name: fullName,
      phone,
      email: email ? email.toLowerCase() : email,
      delivery,
      delivery_address: null,
      payment_method: payment,
      mobile_operator: operator,
      payment_phone: payment === "mobile_money" ? paymentPhone : null,
      payment_bank: null,
      payment_account: null,
      card_brand: cardBrand,
      card_last4: cardLast4,
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
      `SELECT l.id, l.title, l.quantity, l.price, l.price_unit, l.location, a.name AS animal_name, a.kind AS animal_kind,
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

    // Save the order and take the animals off the listing in one step, so two
    // buyers can't order the same animals. A listing with nothing left comes
    // off the website.
    const conn = await pool.getConnection();
    let result;
    let soldOut = false;
    try {
      await conn.beginTransaction();
      const [[current]] = await conn.query("SELECT quantity, status FROM livestock WHERE id = ? FOR UPDATE", [item.id]);
      if (!current || current.status !== "published" || Number(current.quantity) < 1) {
        throw notFound("This listing is no longer available.");
      }
      if (quantity > Number(current.quantity)) {
        const error = badRequest(`Only ${current.quantity} available now.`);
        error.status = 422;
        error.errors = { quantity: `Only ${current.quantity} available now.` };
        throw error;
      }
      [result] = await conn.query(
        `INSERT INTO orders
           (livestock_id, livestock_title, seller_id, seller_name, quantity, unit_price, price_unit, total,
            full_name, phone, email, delivery, delivery_address, payment_method, mobile_operator, payment_phone,
            payment_bank, payment_account, card_brand, card_last4, stock_deducted, ip_address)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        [item.id, item.title, item.seller_id, sellerName, quantity, unitPrice, item.price_unit, total,
          values.full_name, values.phone, values.email, values.delivery, values.delivery_address,
          values.payment_method, values.mobile_operator, values.payment_phone,
          values.payment_bank, values.payment_account, values.card_brand, values.card_last4, req.ip],
      );
      soldOut = Number(current.quantity) - quantity === 0;
      await conn.query(
        "UPDATE livestock SET quantity = quantity - ?, status = IF(quantity = 0, 'unpublished', status) WHERE id = ?",
        [quantity, item.id],
      );
      await conn.commit();
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
    const id = result.insertId;
    const reference = orderRef(id);
    const qtyText = lot ? `The whole lot (${headCount(quantity, item.animal_name, item.animal_kind)})` : headCount(quantity, item.animal_name, item.animal_kind);
    const deliveryText = `${DELIVERY_LABELS.collect} (${item.location} Province)`;

    // The order is already saved; email problems are recorded, not shown.
    const [team, buyer] = await Promise.all([
      sendEmail({
        to: recipients(),
        subject: `New order ${reference}: ${item.title}`,
        heading: `New order ${reference}`,
        paragraphs: [
          `${values.full_name} wants to buy ${lot ? "the whole lot" : headCount(quantity, item.animal_name, item.animal_kind)} from "${item.title}".`,
          soldOut
            ? "Nothing is left on the listing, so it has been taken off the website."
            : `The ${item.animal_kind === "feed" ? "bags have" : "animals have"} been taken off the listing. Cancelling the order puts them back.`,
        ],
        rows: [
          ["Listing", item.title],
          ["Seller", sellerName || "Frontier"],
          ["Quantity", qtyText],
          ["Total", kwacha(total)],
          ["Buyer", values.full_name],
          ["WhatsApp", values.phone],
          ["Email", values.email],
          ["Collection", deliveryText],
          ["Payment", paymentText(values)],
        ],
        button: { label: "Open order", url: appUrl(`/admin/orders.html?id=${id}`) },
      }),
      sendEmail({
        to: values.email,
        subject: `Order ${reference} received`,
        heading: `Order ${reference} received`,
        paragraphs: [
          `Hi ${values.full_name}, thank you for your order. ${item.animal_kind === "feed" ? "The feed is" : "The animals are"} now reserved for you.`,
          "We'll contact you on both WhatsApp and email to arrange collection.",
        ],
        rows: [
          ["Listing", item.title],
          ["Quantity", qtyText],
          ["Total", kwacha(total)],
          ["Collection", deliveryText],
          ["Payment", paymentText(values)],
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
