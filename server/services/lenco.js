// Lenco (https://lenco.co) mobile money collections for Zambia: Airtel Money,
// MTN MoMo and Zamtel Kwacha. Lenco sends the buyer a prompt on their phone
// to approve the payment with their PIN.
//
// Switched on by LENCO_SECRET_KEY in .env. Without it the checkout works as
// before: the order is saved and the team arranges payment.
//
//   LENCO_SECRET_KEY   API secret key from the Lenco dashboard
//   LENCO_ENV          "sandbox" (default) or "production"
//   LENCO_BASE_URL     optional override of the API address (used in tests)
const crypto = require("crypto");

const BASE_URLS = {
  production: "https://api.lenco.co/access/v2",
  sandbox: "https://sandbox.lenco.co/access/v2",
};

function config() {
  const key = (process.env.LENCO_SECRET_KEY || "").trim();
  const env = process.env.LENCO_ENV === "production" ? "production" : "sandbox";
  const base = (process.env.LENCO_BASE_URL || BASE_URLS[env]).replace(/\/+$/, "");
  return { key, env, base };
}

function enabled() {
  return Boolean(config().key);
}

// "0977 123 456", "+260977123456" or "260977123456" -> "0977123456"
function localPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.startsWith("260") && digits.length === 12) return `0${digits.slice(3)}`;
  if (digits.length === 9) return `0${digits}`;
  return digits;
}

async function call(method, path, body) {
  const { key, base } = config();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    if (!res.ok || !json || json.status === false) {
      const message = (json && json.message) || `Lenco answered ${res.status}`;
      const error = new Error(message);
      error.status = res.status;
      error.data = json && json.data;
      throw error;
    }
    return json.data || {};
  } catch (error) {
    if (error.name === "AbortError") throw new Error("The payment service took too long to answer.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// Starts a collection: the buyer gets the PIN prompt on their phone.
// Returns Lenco's collection (status "pay-offline" / "pending" / "successful" / "failed").
function collectMobileMoney({ amount, reference, phone, operator }) {
  return call("POST", "/collections/mobile-money", {
    amount: Number(amount),
    reference,
    phone: localPhone(phone),
    operator,
    country: "zm",
    bearer: process.env.LENCO_FEE_BEARER === "customer" ? "customer" : "merchant",
  });
}

function collectionStatus(reference) {
  return call("GET", `/collections/status/${encodeURIComponent(reference)}`);
}

// Webhooks carry X-Lenco-Signature: HMAC-SHA512 of the body, keyed with the
// SHA-256 hex digest of the API secret key.
function validSignature(rawBody, signature) {
  const { key } = config();
  if (!key || !rawBody || !signature) return false;
  const hashKey = crypto.createHash("sha256").update(key).digest("hex");
  const expected = crypto.createHmac("sha512", hashKey).update(rawBody).digest("hex");
  const given = String(signature).trim().toLowerCase();
  return expected.length === given.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given));
}

module.exports = { enabled, config, localPhone, collectMobileMoney, collectionStatus, validSignature };
