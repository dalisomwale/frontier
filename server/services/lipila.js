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

// Card (Visa / Mastercard): Lipila's hosted card page. Returns
// { status, url, identifier }; the buyer is sent to url and comes back to
// backUrl. Card details are entered on Lipila's page only.
async function collectCard({ reference, amount, phone, narration, email, customer, backUrl, callbackUrl }) {
  const [first, ...rest] = String(customer.name || "").trim().split(/\s+/);
  const res = await request("POST", "/collections/card", {
    body: {
      customerInfo: {
        firstName: first || "Customer",
        lastName: rest.join(" ") || first || "Customer",
        phoneNumber: msisdn(phone),
        email,
        city: String(customer.city || "Lusaka").slice(0, 60),
        country: "ZM",
        address: String(customer.address || customer.city || "Zambia").slice(0, 120),
        zip: String(customer.zip || "10101"),
      },
      collectionRequest: {
        referenceId: reference,
        amount: Math.round(Number(amount) * 100) / 100,
        narration: String(narration).slice(0, 100),
        accountNumber: msisdn(phone),
        currency: "ZMW",
        backUrl,
        referenceData: reference,
      },
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
  const url = res.data.cardRedirectionUrl;
  // Only a secure Lipila page (a local test page is allowed for development).
  if (!url || !/^(https:\/\/|http:\/\/127\.0\.0\.1[:/])/.test(url)) throw new Error(res.data.message || "The card payment page wasn't created.");
  return { status: classify(res.data.status), url, identifier: res.data.identifier || null, lipilaReference: res.data.referenceId || null };
}

// Returns { status: pending|paid|failed, amount, currency, message, identifier, externalId, raw }.
// Looks the payment up by our reference first, then by Lipila's own
// identifier when the first lookup isn't understood (404 or 400).
async function checkStatus(reference, identifier) {
  let res = await request("GET", `/collections/check-status?referenceId=${encodeURIComponent(reference)}`);
  let by = "referenceId";
  if ((res.status === 404 || res.status === 400) && identifier) {
    const second = await request("GET", `/collections/check-status?identifier=${encodeURIComponent(identifier)}`);
    if (second.ok || second.status === 404) {
      res = second;
      by = "identifier";
    }
  }
  if (res.status === 404) return { status: "pending", notFound: true, raw: rawText(res), by };
  if (!res.ok || !res.data) {
    // Lipila sometimes answers with an error while a payment is still being
    // set up; the caller treats this as "no news yet" and checks again.
    const e = new Error(`HTTP ${res.status}: ${message(res)}`);
    e.status = res.status;
    e.raw = rawText(res);
    throw e;
  }
  const d = res.data.data && typeof res.data.data === "object" ? res.data.data : res.data;
  return {
    status: classify(d.status),
    lipilaStatus: d.status || null,
    amount: d.amount !== undefined ? Number(d.amount) : null,
    currency: d.currency || null,
    message: d.message || "",
    identifier: d.identifier || null,
    externalId: d.externalId || null,
    raw: rawText(res),
    by,
  };
}

// Lipila's full answer, shortened, for the log and the admin check.
function rawText(res) {
  return String(res.text || "").replace(/\s+/g, " ").slice(0, 600);
}

// Card payments are offered only once Lipila has enabled them for the
// account: LIPILA_CARDS=on.
function cardsEnabled() {
  return enabled() && /^(on|true|1|yes)$/i.test(String(process.env.LIPILA_CARDS || "").trim());
}

// Can Lipila's card page be shown inside our checkout (in an iframe)? We read
// the page's own X-Frame-Options and frame-ancestors headers; if it refuses,
// or we can't tell, the buyer is sent to the page instead. The answer is kept
// per site for a while. LIPILA_CARD_EMBED=off always sends buyers to the page.
const embedCache = new Map();
function framingAllowed(headers, ourOrigin) {
  const xfo = String(headers.get("x-frame-options") || "").trim().toLowerCase();
  if (xfo === "deny" || xfo === "sameorigin") return false;
  const csp = String(headers.get("content-security-policy") || "");
  const fa = csp.split(";").map((d) => d.trim()).find((d) => /^frame-ancestors\s/i.test(d));
  if (!fa) return true;
  const sources = fa.split(/\s+/).slice(1).map((s) => s.replace(/^'|'$/g, "").toLowerCase());
  if (sources.includes("none")) return false;
  if (sources.includes("*")) return true;
  const ours = String(ourOrigin || "").toLowerCase().replace(/\/+$/, "");
  const host = ours.replace(/^https?:\/\//, "");
  return sources.some((s) => {
    if (s === ours || s === host) return true;
    if (s === "https:" && ours.startsWith("https://")) return true;
    const wild = s.match(/^(https?:\/\/)?\*\.(.+)$/);
    return Boolean(wild && host.endsWith(`.${wild[2]}`));
  });
}

async function canEmbed(url, ourOrigin) {
  if (/^(off|false|0|no)$/i.test(String(process.env.LIPILA_CARD_EMBED || "").trim())) return false;
  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    return false;
  }
  const cached = embedCache.get(origin);
  if (cached && cached.until > Date.now()) return cached.ok;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  let ok = false;
  try {
    // Opening the page charges nothing; it only shows the card form.
    const res = await fetch(url, { method: "GET", redirect: "follow", signal: controller.signal });
    ok = res.status < 400 && framingAllowed(res.headers, ourOrigin);
    if (res.body && res.body.cancel) res.body.cancel().catch(() => {});
  } catch {
    ok = false;
  } finally {
    clearTimeout(timer);
  }
  embedCache.set(origin, { ok, until: Date.now() + (ok ? 60 : 10) * 60 * 1000 });
  return ok;
}

module.exports = { enabled, cardsEnabled, isSandbox, baseUrl, msisdn, collect, collectCard, checkStatus, canEmbed, framingAllowed };
