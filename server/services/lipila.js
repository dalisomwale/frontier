// Lipila (lipila.io) mobile money collections: Airtel Money, MTN MoMo and
// Zamtel Kwacha.
//
//   collect      POST /collections/mobile-money: Lipila sends the PIN prompt to
//                the buyer's phone
//   checkStatus  GET /collections/check-status?referenceId=: Pending,
//                Successful or Failed. Only this marks an order paid.
//   callback     Lipila also calls /api/payments/lipila/callback when a payment
//                finishes; we then ask checkStatus rather than trust the call.
//
// Settings (.env):
//   LIPILA_API_KEY   from the Lipila dashboard (live merchant account)
//   LIPILA_ENV       optional: "sandbox" to use Lipila's test system with a
//                    test key; anything else (default) is live
//   LIPILA_BASE_URL  optional override of the API address
//
// Live payments are real. Sandbox test numbers: 0977000001 succeeds,
// 0977000002 fails, 0977000003 stays pending.

const SANDBOX_URL = "https://api.lipila.dev/api/v1";
const LIVE_URL = "https://blz.lipila.io/api/v1";

function apiKey() {
  return (process.env.LIPILA_API_KEY || "").trim();
}

function enabled() {
  return Boolean(apiKey());
}

function baseUrl() {
  const override = (process.env.LIPILA_BASE_URL || "").trim().replace(/\/+$/, "");
  if (override) return override;
  return String(process.env.LIPILA_ENV || "").trim().toLowerCase() === "sandbox" ? SANDBOX_URL : LIVE_URL;
}

function isSandbox() {
  return /lipila\.dev/i.test(baseUrl());
}

// "0977 123 456" / "+260 977 123 456" -> "260977123456"
function msisdn(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.startsWith("260") && digits.length === 12) return digits;
  if (digits.startsWith("0") && digits.length === 10) return `260${digits.slice(1)}`;
  if (digits.length === 9) return `260${digits}`;
  return digits;
}

async function request(method, path, { body, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const res = await fetch(`${baseUrl()}${path}`, {
      method,
      headers: { accept: "application/json", "content-type": "application/json", "x-api-key": apiKey(), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    return { status: res.status, ok: res.ok, data, text };
  } catch (error) {
    // No answer: the payment may or may not have started; check later.
    const e = new Error(error.name === "AbortError" ? "The payment service took too long to answer." : `Couldn't reach the payment service (${error.message}).`);
    e.unknownOutcome = true;
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function message(res) {
  const d = res.data || {};
  const m = d.message || d.error || d.title || (Array.isArray(d.errors) ? d.errors.join(" ") : "");
  if (m) return String(m).slice(0, 200);
  return {
    400: "The payment details were not accepted. Check the mobile money number and amount.",
    401: "The payment service rejected our API key.",
    403: "Mobile money collections aren't enabled for this account.",
    429: "The payment service is busy. Please try again in a moment.",
  }[res.status] || `The payment service answered ${res.status}.`;
}

// Lipila's status words -> paid | pending | failed.
function classify(status) {
  const s = String(status || "").toLowerCase();
  if (s === "successful" || s === "success" || s === "completed") return "paid";
  if (s === "failed" || s === "failure" || s === "rejected" || s === "cancelled" || s === "declined") return "failed";
  return "pending";
}

// Sends the PIN prompt. Returns { status: pending|paid|failed, message, identifier }.
async function collect({ reference, amount, phone, narration, email, callbackUrl }) {
  const res = await request("POST", "/collections/mobile-money", {
    body: {
      referenceId: reference,
      amount: Math.round(Number(amount) * 100) / 100,
      narration: String(narration).slice(0, 100),
      accountNumber: msisdn(phone),
      currency: "ZMW",
      ...(email ? { email } : {}),
    },
    headers: callbackUrl ? { callbackUrl } : {},
  });
  if (res.status >= 500 || res.status === 408) {
    const e = new Error(message(res));
    e.unknownOutcome = true;
    throw e;
  }
  if (!res.ok || !res.data) {
    const e = new Error(message(res));
    e.status = res.status;
    throw e;
  }
  return {
    status: classify(res.data.status),
    message: res.data.message || "",
    identifier: res.data.identifier || null,
  };
}

// Returns { status: pending|paid|failed, amount, currency, message, identifier, externalId }.
async function checkStatus(reference) {
  const res = await request("GET", `/collections/check-status?referenceId=${encodeURIComponent(reference)}`);
  if (res.status === 404) return { status: "pending", notFound: true };
  if (!res.ok || !res.data) {
    const e = new Error(message(res));
    e.status = res.status;
    throw e;
  }
  const d = res.data.data && typeof res.data.data === "object" ? res.data.data : res.data;
  return {
    status: classify(d.status),
    amount: d.amount !== undefined ? Number(d.amount) : null,
    currency: d.currency || null,
    message: d.message || "",
    identifier: d.identifier || null,
    externalId: d.externalId || null,
  };
}

module.exports = { enabled, isSandbox, baseUrl, msisdn, collect, checkStatus };
