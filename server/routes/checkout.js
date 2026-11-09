// Shopping cart and checkout (mobile money only). See lib/checkout.js.
//
//   POST /api/checkout/quote          price the cart in the browser
//   POST /api/checkout                place the order: reserves the items
//   GET  /api/checkout/:id?token=     the payment page asks for the status
//   POST /api/checkout/:id/payment    send the mobile money PIN prompt
const express = require("express");
const { text, isEmail, isPhone, oneOf, positiveInt, badRequest, notFound } = require("../lib/validate");
const checkout = require("../lib/checkout");
const lenco = require("../services/lenco");
const lipila = require("../services/lipila");
const { appUrl } = require("../services/mailer");

// Whether Lipila's card page can open inside our checkout page.
async function embeddable(url) {
  if (!url) return false;
  try {
    return await lipila.canEmbed(url, new URL(appUrl("/")).origin);
  } catch {
    return false;
  }
}

const router = express.Router();

router.post("/quote", async (req, res, next) => {
  try {
    res.json({ success: true, data: await checkout.quote(req.body && req.body.items) });
  } catch (error) {
    next(error);
  }
});

router.post("/", async (req, res, next) => {
  try {
    // Honeypot: real visitors never see or fill this field.
    if (req.body.website) return res.status(201).json({ success: true, data: { reference: "FMC-0" } });
    const fullName = text(req.body.full_name, 120);
    // Contact number: typed at checkout; for mobile money it falls back to
    // the number that pays.
    const phone = text(req.body.phone, 30)
      || (req.body.payment_method === "mobile_money" ? text(req.body.payment_phone, 30) : "");
    const email = text(req.body.email, 255);
    const errors = {};
    if (!fullName || fullName.length < 2) errors.full_name = "Please enter your full name.";
    if (!phone || !isPhone(phone)) errors.phone = "Please enter a valid phone number, e.g. 0977 123 456.";
    if (!email || !isEmail(email)) errors.email = "Please enter a valid email address.";
    // How the buyer pays: mobile money (network + number for the PIN prompt),
    // or card (address and town for the card page).
    const allowed = checkout.methods();
    const method = allowed.length ? oneOf(req.body.payment_method || "mobile_money", allowed) : null;
    let pay = null;
    if (allowed.length && !method) errors.payment_method = "Please choose how you'd like to pay.";
    if (method === "mobile_money") {
      const operator = oneOf(req.body.mobile_operator, checkout.operators());
      const payPhone = text(req.body.payment_phone, 30);
      if (!operator) errors.mobile_operator = "Please choose your mobile money network.";
      if (!payPhone || !isPhone(payPhone)) errors.payment_phone = "Please enter your mobile money number, e.g. 0977 123 456.";
      pay = { method, operator, phone: payPhone };
    } else if (method === "card") {
      const address = text(req.body.address, 120);
      const city = text(req.body.city, 60);
      if (!address || address.length < 3) errors.address = "Please enter your address.";
      if (!city || city.length < 2) errors.city = "Please enter your town or city.";
      pay = { method, address, city };
    }
    if (Object.keys(errors).length) {
      return res.status(422).json({ success: false, message: "Please correct the highlighted fields.", errors });
    }
    let created;
    try {
      created = await checkout.create(req.body.items, { full_name: fullName, phone, email: email.toLowerCase() }, req.ip, pay);
    } catch (error) {
      if (error.code === "CART_CHANGED") {
        return res.status(409).json({ success: false, code: "CART_CHANGED", message: error.message });
      }
      throw error;
    }
    const cardUrl = created.payment_method === "card" && created.payment_status === "pending" ? created.payment_url : null;
    res.status(201).json({
      success: true,
      message: `Order ${checkout.checkoutRef(created.id)} received.`,
      data: {
        id: created.id,
        reference: checkout.checkoutRef(created.id),
        token: created.public_token,
        total: Number(created.total),
        // Where the buyer pays. Today our own mobile money page; with a
        // gateway's hosted payment page this becomes their address.
        // Card: straight to Lipila's card page. Otherwise our payment page.
        pay_url: cardUrl || checkout.payUrl(created),
        // Card: open Lipila's card form inside the checkout page when it allows it.
        card_url: cardUrl,
        card_embed: await embeddable(cardUrl),
        page_url: checkout.payUrl(created),
      },
    });
  } catch (error) {
    next(error);
  }
});

async function forBuyer(req) {
  const id = positiveInt(req.params.id);
  const token = String(req.query.token || req.body?.token || "");
  if (!id || !/^[a-f0-9]{32}$/.test(token)) throw notFound("Order not found.");
  const found = await checkout.load(id);
  if (!found || found.public_token !== token) throw notFound("Order not found.");
  return found;
}

router.get("/:id", async (req, res, next) => {
  try {
    const c = await checkout.refresh(await forBuyer(req));
    res.json({ success: true, data: checkout.publicView(c, await checkout.ordersOf(c.id)) });
  } catch (error) {
    next(error);
  }
});

router.post("/:id/payment", async (req, res, next) => {
  try {
    const providerNow = checkout.provider();
    if (!providerNow) throw badRequest("Mobile money payments on the website are not switched on. Our team will contact you.");
    const c = await forBuyer(req);
    const orders = await checkout.ordersOf(c.id);
    const view = checkout.publicView(c, orders);
    if (c.payment_status === "paid") return res.json({ success: true, data: view });
    if (view.closed || !view.total) throw badRequest("There's nothing left to pay on this order.");
    // Lenco: one prompt at a time. Lipila: the buyer may send it again.
    if (c.payment_status === "pending" && providerNow === "lenco") throw badRequest("A payment request is already waiting on your phone.");
    if (Number(c.payment_attempts) >= checkout.MAX_ATTEMPTS) {
      throw badRequest("Too many attempts. Our team will contact you to arrange payment.");
    }
    // Card: a new payment on Lipila's card page (address and town needed).
    if (req.body.payment_method === "card") {
      if (!checkout.methods().includes("card")) throw badRequest("Card payments aren't available right now.");
      const address = text(req.body.address, 120);
      const city = text(req.body.city, 60);
      const errs = {};
      if (!address || address.length < 3) errs.address = "Please enter your address.";
      if (!city || city.length < 2) errs.city = "Please enter your town or city.";
      if (Object.keys(errs).length) return res.status(422).json({ success: false, message: "Please correct the highlighted fields.", errors: errs });
      const opened = await checkout.startCard(c, { address, city });
      const v = checkout.publicView(opened, await checkout.ordersOf(opened.id));
      if (!v.pay_url) throw badRequest(opened.payment_failure || "We couldn't open the card payment page. Please try again.");
      return res.json({ success: true, data: { ...v, card_embed: await embeddable(v.pay_url) } });
    }
    const operator = oneOf(req.body.mobile_operator, checkout.operators());
    const phone = text(req.body.payment_phone, 30);
    const errors = {};
    if (!operator) errors.mobile_operator = "Please choose your mobile money network.";
    if (!phone || !isPhone(phone)) errors.payment_phone = "Please enter the mobile money number, e.g. 0977 123 456.";
    if (Object.keys(errors).length) {
      return res.status(422).json({ success: false, message: "Please correct the highlighted fields.", errors });
    }
    const updated = await checkout.startPayment(c, { operator, phone });
    res.json({ success: true, data: checkout.publicView(updated, await checkout.ordersOf(updated.id)) });
  } catch (error) {
    next(error);
  }
});

// Lipila's card page sends the buyer back here: /pay/return/:id/:token. The
// payment is checked with Lipila; nothing in the address is trusted.
const pages = express.Router();
pages.get("/return/:id/:token", async (req, res) => {
  const id = positiveInt(req.params.id);
  const token = String(req.params.token || "");
  try {
    const found = id && /^[a-f0-9]{32}$/.test(token) ? await checkout.load(id) : null;
    if (found && found.public_token === token && found.payment_status === "pending" && found.payment_provider === "lipila") {
      await checkout.refreshLipila(found);
    }
  } catch (error) {
    console.error(`Card return: ${error.message}`);
  }
  res.redirect(303, `/pay.html?checkout=${id}&token=${encodeURIComponent(token)}&returned=1`);
});

module.exports = router;
module.exports.pages = pages;
