// A transport company's drivers (D: drivers).
//
// The company registers its drivers (name and phone number) and gives each a
// sign-in code. A driver signs in with their phone number and that code, sees
// the company's delivery requests (the company's area and coverage), accepts
// them with one of the company's vehicles, and does the delivery. The company
// manages everything: drivers, vehicles, and who does which delivery.
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const pool = require("../../db");
const { text, isPhone } = require("../validate");
const core = require("./core");

// The same number written 0977 123 456, +260 977 123 456 or 260977123456.
const phoneKey = (phone) => String(phone || "").replace(/\D/g, "").slice(-9);

// Sign-in codes: 8 letters and digits that can't be mixed up (no 0/O, 1/I/L),
// shown as ABCD-EFGH. Stored like a password; the driver can change it.
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function makeCode() {
  const bytes = crypto.randomBytes(8);
  const raw = [...bytes].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}
const codeForm = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

async function setCode(driverId, conn = pool) {
  const code = makeCode();
  await conn.query("UPDATE transport_drivers SET password_hash = ?, code_made_at = NOW() WHERE id = ?", [await bcrypt.hash(codeForm(code), 12), driverId]);
  return code;
}

// A code is typed with or without the dash, in any case; a password the
// driver chose is compared as typed.
async function passwordMatches(input, hash) {
  if (!hash || !input) return false;
  if (await bcrypt.compare(input, hash)) return true;
  const c = codeForm(input);
  return c.length === 8 && c !== input ? bcrypt.compare(c, hash) : false;
}

// Checks one driver's details. taken: phone keys already used in this form.
async function driverPayload(body, { exceptId = 0, taken = new Set(), conn = pool } = {}) {
  const name = text(body.name, 120);
  const phone = text(body.phone, 30);
  const licence = text(body.licence_number, 80);
  const errors = {};
  if (!name || name.length < 2) errors.name = "Please enter the driver's full name.";
  if (!phone || !isPhone(phone)) errors.phone = "Please enter the driver's phone number, e.g. 0977 123 456.";
  else {
    const key = phoneKey(phone);
    if (taken.has(key)) errors.phone = "This phone number is listed twice.";
    else {
      const [[other]] = await conn.query("SELECT id FROM transport_drivers WHERE phone_key = ? AND id <> ?", [key, exceptId]);
      if (other) errors.phone = "This phone number is already registered as a driver.";
    }
  }
  if (licence === undefined) errors.licence_number = "Must be 80 characters or fewer.";
  return { errors, data: { name, phone, phone_key: phoneKey(phone), licence_number: licence || null } };
}

// The company's drivers, each with the delivery they're on (if any).
async function listOf(providerId, id = null) {
  const [rows] = await pool.query(
    `SELECT d.*, (SELECT b.id FROM transport_bookings b WHERE b.driver_id = d.id AND b.status IN (?) ORDER BY b.id DESC LIMIT 1) AS busy_booking,
       (SELECT COUNT(*) FROM transport_bookings b WHERE b.driver_id = d.id AND b.status = 'completed') AS completed
     FROM transport_drivers d WHERE d.provider_id = ? ${id ? "AND d.id = ?" : ""} ORDER BY d.is_active DESC, d.name`,
    [core.VEHICLE_BUSY, providerId, ...(id ? [id] : [])],
  );
  return rows.map(view);
}

function view(d) {
  return {
    id: d.id,
    name: d.name,
    phone: d.phone,
    licence_number: d.licence_number,
    is_active: Boolean(d.is_active),
    has_code: Boolean(d.password_hash),
    code_made_at: d.code_made_at,
    last_login_at: d.last_login_at,
    busy_booking: d.busy_booking ? { id: d.busy_booking, reference: core.bookingRef(d.busy_booking) } : null,
    completed: d.completed === undefined ? undefined : Number(d.completed),
    created_at: d.created_at,
  };
}

async function load(id, conn = pool) {
  const [[d]] = await conn.query("SELECT * FROM transport_drivers WHERE id = ?", [id || 0]);
  return d || null;
}

module.exports = { phoneKey, makeCode, codeForm, setCode, passwordMatches, driverPayload, listOf, load, view };
