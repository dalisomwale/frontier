// DPO Pay (Network International) hosted payment page, API v6.
//
//   createToken   our server creates a payment for the amount due and gets a
//                 transaction token
//   payment page  the buyer is sent to DPO's page (payv3.php?ID=<token>) and
//                 pays there; DPO sends them back to RedirectURL (or BackURL
//                 if they cancel)
//   verifyToken   our server asks DPO whether the token was paid; only this
//                 marks an order paid, never the buyer's return to our site
//
// Switched on by DPO_COMPANY_TOKEN in .env (it then takes over from Lenco for
// cart checkouts). Each merchant account has its own company token and
// service type; the marketplace account takes mobile money only.
//
//   DPO_COMPANY_TOKEN  company token from DPO (test or live)
//   DPO_SERVICE_TYPE   service type number for the marketplace
//   DPO_API_URL        optional, default https://secure.3gdirectpay.com/API/v6/
//   DPO_PAY_URL        optional, default https://secure.3gdirectpay.com/payv3.php
//   DPO_PTL_HOURS      optional, hours the buyer has to pay (default 24)

function config() {
  return {
    companyToken: (process.env.DPO_COMPANY_TOKEN || "").trim(),
    serviceType: (process.env.DPO_SERVICE_TYPE || "").trim(),
    apiUrl: (process.env.DPO_API_URL || "https://secure.3gdirectpay.com/API/v6/").trim(),
    payUrl: (process.env.DPO_PAY_URL || "https://secure.3gdirectpay.com/payv3.php").trim(),
    ptlHours: Math.max(1, Number.parseInt(process.env.DPO_PTL_HOURS, 10) || 24),
  };
}

function enabled() {
  const c = config();
  return Boolean(c.companyToken && c.serviceType);
}

const esc = (value) => String(value ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

function tag(name, value) {
  return value === undefined || value === null || value === "" ? "" : `<${name}>${esc(value)}</${name}>`;
}

// DPO answers with flat XML: <API3G><Result>000</Result>...</API3G>.
function read(xml, name) {
  const match = String(xml || "").match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i"));
  if (!match) return null;
  return match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&")
    .trim();
}

async function call(body) {
  const { apiUrl } = config();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/xml", Accept: "application/xml" },
      body: `<?xml version="1.0" encoding="utf-8"?><API3G>${body}</API3G>`,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok && !/<Result>/i.test(text)) throw new Error(`DPO answered ${res.status}`);
    return text;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("The payment service took too long to answer.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// "2026/11/05 16:30" in Zambian time.
function serviceDate(date = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: process.env.APP_TIMEZONE || "Africa/Lusaka",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.year}/${p.month}/${p.day} ${p.hour}:${p.minute}`;
}

// "0977 123 456" / "+260977123456" -> "977123456"
function nationalNumber(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.startsWith("260") && digits.length === 12) return digits.slice(3);
  if (digits.startsWith("0") && digits.length === 10) return digits.slice(1);
  return digits;
}

function createTokenXml({ amount, reference, description, redirectUrl, backUrl, customer }, withPhone) {
  const { companyToken, serviceType, ptlHours } = config();
  const [first, ...rest] = String(customer.name || "").trim().split(/\s+/);
  return [
    tag("CompanyToken", companyToken),
    tag("Request", "createToken"),
    "<Transaction>",
    tag("PaymentAmount", Number(amount).toFixed(2)),
    tag("PaymentCurrency", "ZMW"),
    tag("CompanyRef", reference),
    tag("RedirectURL", redirectUrl),
    tag("BackURL", backUrl),
    tag("CompanyRefUnique", "0"),
    tag("PTL", ptlHours),
    tag("PTLtype", "hours"),
    tag("customerFirstName", first),
    tag("customerLastName", rest.join(" ") || first),
    tag("customerEmail", customer.email),
    ...(withPhone ? [tag("customerPhone", nationalNumber(customer.phone)), tag("customerDialCode", "260"), tag("customerCountry", "ZM")] : []),
    // Open the payment page on mobile money, in Zambia.
    tag("DefaultPayment", "MO"),
    tag("DefaultPaymentCountry", "zambia"),
    "</Transaction>",
    "<Services><Service>",
    tag("ServiceType", serviceType),
    tag("ServiceDescription", String(description).slice(0, 250)),
    tag("ServiceDate", serviceDate()),
    "</Service></Services>",
  ].join("");
}

// Creates the payment. Returns { token, transRef, payUrl }.
async function createToken(details) {
  let xml = await call(createTokenXml(details, true));
  // If DPO doesn't accept the phone details, try once without them: the buyer
  // types their number on the payment page anyway.
  if (read(xml, "Result") !== "000" && /phone|dial|country/i.test(read(xml, "ResultExplanation") || "")) {
    xml = await call(createTokenXml(details, false));
  }
  const result = read(xml, "Result");
  if (result !== "000") {
    const error = new Error(read(xml, "ResultExplanation") || `DPO could not create the payment (${result || "no answer"}).`);
    error.code = result;
    throw error;
  }
  const token = read(xml, "TransToken");
  return { token, transRef: read(xml, "TransRef"), payUrl: `${config().payUrl}?ID=${encodeURIComponent(token)}` };
}

// What happened to a payment. status: paid | pending | failed.
//   000 paid; 900 not paid yet; 901 declined; 902 data mismatch;
//   903 payment time expired; 904 cancelled; 001-007 in progress.
async function verifyToken(token) {
  const xml = await call([tag("CompanyToken", config().companyToken), tag("Request", "verifyToken"), tag("TransactionToken", token)].join(""));
  const result = read(xml, "Result");
  const explanation = read(xml, "ResultExplanation");
  const out = {
    result,
    explanation,
    amount: read(xml, "TransactionAmount"),
    currency: read(xml, "TransactionCurrency"),
    approval: read(xml, "TransactionApproval"),
    phone: read(xml, "CustomerPhone"),
    paymentType: read(xml, "CustomerCreditType"),
  };
  if (result === "000") return { ...out, status: "paid" };
  const failures = {
    901: "The payment was declined.",
    902: "The payment details didn't match. Please try again.",
    903: "The time to pay ran out. Please try again.",
    904: "The payment was cancelled.",
  };
  if (failures[result]) return { ...out, status: "failed", reason: failures[result] };
  return { ...out, status: "pending" };
}

module.exports = { enabled, config, createToken, verifyToken, serviceDate, nationalNumber };
