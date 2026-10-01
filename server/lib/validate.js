// Small input-normalisation helpers shared by the route handlers.

function positiveInt(value, fallback = null) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// Trimmed string or null. Returns `undefined` when the value is too long so
// callers can tell "missing" from "invalid".
function text(value, maxLength) {
  if (value === undefined || value === null) return null;
  const output = String(value).trim();
  if (!output) return null;
  return output.length <= maxLength ? output : undefined;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function isEmail(value) {
  return typeof value === "string" && value.length <= 255 && EMAIL_RE.test(value);
}

// Accepts local Zambian numbers (0977 123 456) and international formats
// (+260 977 123 456, +44 20 7946 0958): 7-15 digits, optional leading +,
// spaces/dashes/brackets allowed as separators.
function isPhone(value) {
  if (typeof value !== "string") return false;
  if (!/^\+?[\d\s\-()]{7,25}$/.test(value)) return false;
  const digits = value.replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15;
}

function oneOf(value, allowed) {
  return allowed.includes(value) ? value : null;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.expose = true;
  }
}

const badRequest = (message) => new HttpError(400, message);
const notFound = (message = "Not found") => new HttpError(404, message);

module.exports = {
  positiveInt,
  text,
  isEmail,
  isPhone,
  oneOf,
  HttpError,
  badRequest,
  notFound,
};
