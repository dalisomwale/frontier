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
    const phone = text(req.body.phone, 30);
    const email = text(req.body.email, 255);
    const errors = {};
    if (!fullName || fullName.length < 2) errors.full_name = "Please enter your full name.";
    if (!phone || !isPhone(phone)) errors.phone = "Please enter a valid WhatsApp number, e.g. 0977 123 456.";
    if (!email || !isEmail(email)) errors.email = "Please enter a valid email address.";
    // Mobile money number for the PIN prompt (when online payment is on).
    let pay = null;
    if (checkout.operators().length) {
      const operator = oneOf(req.body.mobile_operator, checkout.operators());
      const payPhone = text(req.body.payment_phone, 30);
      if (!operator) errors.mobile_operator = "Please choose your mobile money network.";
      if (!payPhone || !isPhone(payPhone)) errors.payment_phone = "Please enter your mobile money number, e.g. 0977 123 456.";
      pay = { operator, phone: payPhone };
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
        pay_url: created.mobile_operator ? `/pay.html?checkout=${created.id}&token=${created.public_token}` : checkout.payUrl(created),
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
    if (c.payment_status === "pending" && providerNow === "lenco") throw badRequest("A payment request is already waiting on your phone.");
    if (Number(c.payment_attempts) >= checkout.MAX_ATTEMPTS) {
      throw badRequest("Too many attempts. Our team will contact you to arrange payment.");
    }
    // DPO with a number: send the PIN prompt to the phone.
    if (providerNow === "dpo" && req.body.mobile_operator) {
      const operator = oneOf(req.body.mobile_operator, checkout.operators());
      const phone = text(req.body.payment_phone, 30);
      const errors = {};
      if (!operator) errors.mobile_operator = "Please choose your mobile money network.";
      if (!phone || !isPhone(phone)) errors.payment_phone = "Please enter the mobile money number, e.g. 0977 123 456.";
      if (Object.keys(errors).length) {
        return res.status(422).json({ success: false, message: "Please correct the highlighted fields.", errors });
      }
      const sent = await checkout.startPayment(c, { operator, phone });
      return res.json({ success: true, data: checkout.publicView(sent, await checkout.ordersOf(sent.id)) });
    }
    // DPO without a number: open a payment on DPO's page; the buyer is sent there.
    if (providerNow === "dpo") {
      if (c.payment_status === "pending" && c.payment_provider === "dpo" && c.payment_url && !c.mobile_operator) {
        return res.json({ success: true, data: { ...view, pay_url: c.payment_url } });
      }
      const opened = await checkout.startDpo({ ...c, mobile_operator: null });
      const v = checkout.publicView(opened, await checkout.ordersOf(opened.id));
      if (!v.pay_url) throw badRequest(opened.payment_failure || "We couldn't open the payment page. Please try again.");
      return res.json({ success: true, data: v });
    }
    const operator = oneOf(req.body.mobile_operator, checkout.operators());
    const phone = text(req.body.payment_phone, 30);
    const errors = {};
    if (!operator) errors.mobile_operator = "Please choose your mobile money operator.";
    if (!phone || !isPhone(phone)) errors.payment_phone = "Please enter the mobile money number, e.g. 0977 123 456.";
    if (Object.keys(errors).length) {
      return res.status(422).json({ success: false, message: "Please correct the highlighted fields.", errors });
    }
    const updated = await checkout.startCollection(c, { operator, phone });
    res.json({ success: true, data: checkout.publicView(updated, await checkout.ordersOf(updated.id)) });
  } catch (error) {
    next(error);
  }
});

// Pages DPO sends the buyer back to: /pay/return/:id/:token after paying,
// /pay/back/:id/:token if they cancel. The payment is checked with DPO here;
// what DPO adds to the address is not trusted.
const pages = express.Router();
async function back(req, res, cancelled) {
  const id = positiveInt(req.params.id);
  const token = String(req.params.token || "");
  const page = `/pay.html?checkout=${id}&token=${encodeURIComponent(token)}`;
  try {
    const found = id && /^[a-f0-9]{32}$/.test(token) ? await checkout.load(id) : null;
    if (found && found.public_token === token && !cancelled) await checkout.refresh({ ...found, payment_checked_at: null });
  } catch (error) {
    console.error(`DPO return: ${error.message}`);
  }
  res.redirect(303, `${page}${cancelled ? "&cancelled=1" : "&returned=1"}`);
}
pages.get("/return/:id/:token", (req, res) => back(req, res, false));
pages.get("/back/:id/:token", (req, res) => back(req, res, true));

module.exports = router;
module.exports.pages = pages;
