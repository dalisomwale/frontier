// Transport provider accounts (/api/transport). The provider is the person or
// business who drives and carries the goods: there are no separate driver
// accounts. Providers register with their papers, Frontier approves them and
// sets how far they cover; they never set their own coverage or prices.
//
// Once approved, a provider manages their vehicles, receives the delivery
// requests they're eligible for, accepts one with a vehicle, records the
// collection and the delivery with photos, and shares their phone's location
// while on the road.
const crypto = require("crypto");
const fs = require("fs");
const express = require("express");
const bcrypt = require("bcrypt");
const pool = require("../db");
const { sendEmail, appUrl, recipients } = require("../services/mailer");
const notifications = require("../services/notifications");
const { positiveInt, text, isEmail, isPhone, badRequest, notFound, HttpError, PROVINCES } = require("../lib/validate");
const {
  uploadDocuments, uploadRegistration, uploadVehicleFiles, uploadTransportPhotos, savePrivateDocument, privateDocumentPath, deletePrivateDocuments,
  saveImage, deleteImageFiles,
} = require("../middleware/upload");
const core = require("../lib/transport/core");
const bookings = require("../lib/transport/bookings");
const views = require("../lib/transport/views");
const drivers = require("../lib/transport/drivers");
const passwordRules = require("../../public/js/password-rules");
const zambiaDistricts = require("../../public/js/zambia-districts");

const router = express.Router();
const DUMMY_HASH = bcrypt.hashSync("frontier-transport-timing-guard", 12);
const REMEMBER_MS = 30 * 24 * 60 * 60 * 1000;
const RESET_HOURS = 1;
// Registration asks for the NRC and driver's licence (required) and a
// passport (if any). The rest can be added later from the dashboard.
const DOC_TYPES = { nrc: "NRC", drivers_licence: "Driver's licence", passport: "Passport", permit: "Transport permit", registration: "Business registration", insurance: "Insurance", licence: "Driving / transport licence", id: "National ID / passport", other: "Other" };
const REQUIRED_DOCS = { nrc: "NRC", drivers_licence: "driver's licence" };
// How far a provider would like to travel (km by road from their address).
// Frontier confirms it as their coverage.
const MIN_KM = 5;
const MAX_KM = 1000;
function preferredKm(value) {
  const km = Number(value);
  if (value === undefined || value === null || value === "" || !Number.isFinite(km)) return { error: "Please enter how far you're willing to travel, in km." };
  if (km < MIN_KM || km > MAX_KM) return { error: `Please enter a distance from ${MIN_KM} to ${MAX_KM} km.` };
  return { km: Math.round(km) };
}
const PROVIDER_FIELDS = `id, kind, name, contact_person, phone, email, province, district, address, base_label, base_lat, base_lng,
  registration_number, licence_number, status, is_active, is_available, coverage_km, coverage_active,
  preferred_coverage_km, preferred_coverage_at, admin_note, approved_at, created_at`;

// A custom header a cross-site form cannot send.
router.use((req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (req.get("X-Frontier-Transport") === "1") return next();
  return res.status(403).json({ success: false, message: "Request blocked (missing transport header)." });
});

function validationError(errors) {
  const e = new HttpError(422, "Please correct the highlighted fields.");
  e.errors = errors;
  return e;
}

async function loadProvider(id) {
  const [[p]] = await pool.query(`SELECT ${PROVIDER_FIELDS} FROM transport_providers WHERE id = ?`, [id]);
  if (!p) return null;
  return {
    ...p,
    is_active: Boolean(p.is_active),
    is_available: Boolean(p.is_available),
    coverage_active: Boolean(p.coverage_active),
    coverage_km: p.coverage_km === null ? null : Number(p.coverage_km),
    preferred_coverage_km: p.preferred_coverage_km === null ? null : Number(p.preferred_coverage_km),
    base_lat: p.base_lat === null ? null : Number(p.base_lat),
    base_lng: p.base_lng === null ? null : Number(p.base_lng),
  };
}

async function requireProvider(req, res, next) {
  const id = req.session && req.session.providerId;
  const out = (message = "Please sign in to continue.") => res.status(401).json({ success: false, message });
  if (!id) return out();
  try {
    const p = await loadProvider(id);
    if (!p) {
      req.session.destroy(() => {});
      return out();
    }
    req.provider = p;
    req.who = { party: "provider", id: p.id, name: p.name };
    // A company driver (D: drivers): signed in to their company's account,
    // as themselves. Deactivated by the company: signed out.
    if (req.session.driverId) {
      const d = await drivers.load(req.session.driverId);
      if (!d || Number(d.provider_id) !== Number(p.id) || !d.is_active) {
        req.session.destroy(() => {});
        return out("Your driver account is switched off. Please contact your company.");
      }
      req.driver = { id: d.id, name: d.name, phone: d.phone };
      req.who = { party: "provider", id: p.id, name: `${d.name} (${p.name})` };
    }
    return next();
  } catch (error) {
    return next(error);
  }
}

// What only the company (or owner-driver) does, not its drivers.
function ownerOnly(req, res, next) {
  if (!req.driver) return next();
  return res.status(403).json({ success: false, message: "Only your company's account can do this." });
}

// Only approved, active providers take part in deliveries.
function requireApproved(req, res, next) {
  const p = req.provider;
  if (p.status === "approved" && p.is_active) return next();
  const message = p.status === "pending" ? "Your account is waiting for Frontier's approval."
    : p.status === "rejected" ? "Your registration was not approved. Please contact Frontier."
      : p.status === "suspended" ? "Your account is suspended. Please contact Frontier."
        : "Your account has been deactivated by Frontier. Please contact us.";
  return res.status(403).json({ success: false, message });
}

function startSession(req, id, { remember = true, driverId = null } = {}) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => {
      if (error) return reject(error);
      req.session.providerId = id;
      if (driverId) req.session.driverId = driverId;
      req.session.cookie.maxAge = remember ? REMEMBER_MS : null;
      return req.session.save((e) => (e ? reject(e) : resolve()));
    });
  });
}

async function emailTaken(email, exceptId = 0) {
  const [rows] = await pool.query("SELECT id FROM transport_providers WHERE email = ? AND id <> ? LIMIT 1", [email.toLowerCase(), exceptId]);
  return rows.length > 0;
}

// ---------------------------------------------------------------- account
function registrationPayload(body) {
  const kind = body.kind === "company" ? "company" : "individual";
  const name = text(body.name, 150);
  const contactPerson = text(body.contact_person, 120);
  const phone = text(body.phone, 30);
  const email = text(body.email, 255);
  const province = text(body.province, 50);
  const district = text(body.district, 80);
  const address = text(body.address, 255);
  // The operating location comes from the physical address: the point of
  // the address suggestion picked, if any (otherwise looked up on register).
  const base = core.point(body.base_lat, body.base_lng);
  const errors = {};
  if (!name || name.length < 2) errors.name = kind === "company" ? "Please enter the company name." : "Please enter your full name.";
  if (kind === "company" && (!contactPerson || contactPerson.length < 2)) errors.contact_person = "Please enter the contact person.";
  if (!phone || !isPhone(phone)) errors.phone = "Please enter a valid phone number, e.g. 0977 123 456.";
  if (!email || !isEmail(email)) errors.email = "Please enter a valid email address.";
  if (!province || !PROVINCES.includes(province)) errors.province = "Please choose your province.";
  if (!district || district.length < 2) errors.district = "Please choose your district.";
  else if (province && PROVINCES.includes(province) && !zambiaDistricts.match(province, district)) errors.district = `Please choose one of ${province} Province's districts.`;
  if (!address || address.length < 3) errors.address = "Please enter your physical address.";
  if (base && !require("../lib/transport/pricing").inZambia(base)) errors.address = "This address must be in Zambia.";
  const pref = preferredKm(body.preferred_coverage_km);
  if (pref.error) errors.preferred_coverage_km = pref.error;
  return {
    errors,
    data: { kind, name, contact_person: contactPerson || null, phone, email: email && email.toLowerCase(), province, district: (province && zambiaDistricts.match(province, district)) || district, address, base_label: base ? address : null, base_lat: base && base.lat, base_lng: base && base.lng, registration_number: null, licence_number: null, preferred_coverage_km: pref.km || null },
  };
}

async function storeDocuments(conn, providerId, files, types, driverId = null) {
  const saved = [];
  try {
    for (let i = 0; i < files.length; i++) {
      const doc = await savePrivateDocument(files[i]);
      saved.push(doc.file_name);
      const type = Object.keys(DOC_TYPES).includes(types[i]) ? types[i] : "other";
      await conn.query(
        "INSERT INTO transport_provider_documents (provider_id, driver_id, doc_type, file_name, original_name, mime, size_bytes) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [providerId, driverId, type, doc.file_name, String(files[i].originalname || "").slice(0, 255), doc.mime, doc.size_bytes],
      );
    }
  } catch (error) {
    deletePrivateDocuments(...saved);
    throw error;
  }
  return saved;
}

const docTypesOf = (body) => [].concat(body.doc_types || []).flatMap((v) => String(v).split(","));

// What comes with a registration besides the account (D: drivers):
//   company: its drivers, each with their own vehicle and papers (NRC and
//     driver's licence; passport if any). Sent as a JSON list "drivers"
//     ([{ name, phone, licence_number, vehicle_type, registration, size_class }]);
//     each file says whose it is in "doc_owner" (the driver's index).
//   owner-driver: their one vehicle ("vehicles": [{ … }]) and their papers.
// A problem is reported as "Driver 2: …".
const MAX_FLEET = 10;
function jsonList(raw) {
  if (Array.isArray(raw)) return raw;
  try {
    const v = JSON.parse(String(raw || "[]"));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
const docOwnersOf = (body) => [].concat(body.doc_owner || []).flatMap((v) => String(v).split(","));
async function fleetPayload(body, files = [], { company = false } = {}) {
  const errors = {};
  const types = docTypesOf(body);
  const owners = docOwnersOf(body);
  const filesOf = (owner) => files.map((f, i) => ({ file: f, type: types[i], owner: owners[i] ?? "" })).filter((x) => String(x.owner) === String(owner));
  const missingDocs = (list) => Object.keys(REQUIRED_DOCS).filter((t) => !list.some((x) => x.type === t)).map((t) => REQUIRED_DOCS[t]);
  const out = { drivers: [], vehicles: [], ownDocs: [] };
  const regs = new Set();
  if (company) {
    const rows = jsonList(body.drivers).slice(0, MAX_FLEET);
    const phones = new Set();
    if (!rows.length) errors.drivers = "Please add at least one driver with their vehicle.";
    for (const [i, row] of rows.entries()) {
      const who = `Driver ${i + 1}`;
      const { errors: e, data } = await drivers.driverPayload(row || {}, { taken: phones });
      if (Object.keys(e).length) { errors.drivers = `${who}: ${Object.values(e)[0]}`; break; }
      const v = await vehiclePayload(row || {}, 0);
      if (v.data.registration && regs.has(v.data.registration)) v.errors.registration = "This registration number is listed twice.";
      if (Object.keys(v.errors).length) { errors.drivers = `${who}'s vehicle: ${Object.values(v.errors)[0]}`; break; }
      const docs = filesOf(i);
      const missing = missingDocs(docs);
      if (missing.length) { errors.drivers = `${who}: please upload their ${missing.join(" and ")}.`; break; }
      phones.add(data.phone_key);
      regs.add(v.data.registration);
      out.drivers.push({ data, vehicle: v, docs });
    }
  } else {
    const rows = jsonList(body.vehicles).slice(0, 1); // owner-drivers have one vehicle
    if (!rows.length) errors.vehicles = "Please add your vehicle.";
    for (const row of rows) {
      const v = await vehiclePayload(row || {}, 0);
      if (Object.keys(v.errors).length) { errors.vehicles = Object.values(v.errors)[0]; break; }
      out.vehicles.push(v);
    }
    out.ownDocs = filesOf("");
    const missing = missingDocs(out.ownDocs);
    if (missing.length) errors.documents = `Please upload your ${missing.join(" and ")}.`;
  }
  return { errors, ...out };
}

router.post("/auth/register", uploadRegistration, async (req, res, next) => {
  const conn = await pool.getConnection();
  let saved = [];
  try {
    const { errors, data } = registrationPayload(req.body);
    const password = typeof req.body.password === "string" ? req.body.password : "";
    const problem = passwordRules.problem(password, { email: data.email, phone: data.phone });
    if (problem) errors.password = problem;
    if (req.body.confirm_password !== undefined && req.body.confirm_password !== password) errors.confirm_password = "The passwords don't match.";
    if (!["1", "true", "on"].includes(String(req.body.accept_terms))) errors.accept_terms = "Please tick the box to accept the terms.";
    if (!errors.email && (await emailTaken(data.email))) errors.email = "A transport account with this email already exists. Sign in instead.";
    const fleet = await fleetPayload(req.body, req.files || [], { company: data.kind === "company" });
    Object.assign(errors, fleet.errors);
    if (Object.keys(errors).length) throw validationError(errors);
    // No suggestion picked: find the physical address on the map (the
    // address, else the district). If it can't be found, Frontier sets the
    // operating location when reviewing the registration.
    if (data.base_lat === null || data.base_lat === undefined) {
      const pricing = require("../lib/transport/pricing");
      const queries = [`${data.address}, ${data.district}, ${data.province}`, `${data.district}, ${data.province} Province`];
      for (const [i, q] of queries.entries()) {
        try {
          const hit = (await require("../services/routing").geocode(q)).find((r) => pricing.inZambia(r));
          if (hit) {
            // Exact only when the place found is the address itself, not just the town.
            const word = String(data.address).toLowerCase().split(/[^a-z0-9']+/).find((w) => w.length > 3 && !["plot", "house", "stand", "farm", "road", "street"].includes(w));
            const exact = !i && word && hit.label.toLowerCase().includes(word);
            Object.assign(data, { base_lat: hit.lat, base_lng: hit.lng, base_label: `${exact ? "" : "Approximate: "}${hit.label}`.slice(0, 255) });
            break;
          }
        } catch (error) {
          console.error(`Provider address lookup failed: ${error.message}`);
        }
      }
    }
    await conn.beginTransaction();
    const [r] = await conn.query(
      `INSERT INTO transport_providers (kind, name, contact_person, phone, email, province, district, address, base_label, base_lat, base_lng,
         registration_number, licence_number, preferred_coverage_km, preferred_coverage_at, password_hash, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, 'pending')`,
      [data.kind, data.name, data.contact_person, data.phone, data.email, data.province, data.district, data.address, data.base_label, data.base_lat, data.base_lng,
        data.registration_number, data.licence_number, data.preferred_coverage_km, await bcrypt.hash(password, 12)],
    );
    const addVehicle = async (v) => {
      const [vr] = await conn.query("INSERT INTO transport_vehicles (provider_id, registration, vehicle_type, size_class, capacity_note) VALUES (?, ?, ?, ?, ?)", [r.insertId, v.data.registration, v.data.vehicle_type, v.data.size_class, v.data.capacity_note]);
      for (const c of v.cargo) await conn.query("INSERT INTO transport_vehicle_cargo (vehicle_id, cargo_key, max_quantity) VALUES (?, ?, ?)", [vr.insertId, c.key, c.max]);
      return vr.insertId;
    };
    saved = await storeDocuments(conn, r.insertId, fleet.ownDocs.map((x) => x.file), fleet.ownDocs.map((x) => x.type));
    for (const v of fleet.vehicles) await addVehicle(v);
    for (const d of fleet.drivers) {
      const vehicleId = await addVehicle(d.vehicle);
      const [dr] = await conn.query("INSERT INTO transport_drivers (provider_id, name, phone, phone_key, licence_number, vehicle_id) VALUES (?, ?, ?, ?, ?, ?)", [r.insertId, d.data.name, d.data.phone, d.data.phone_key, d.data.licence_number, vehicleId]);
      saved.push(...(await storeDocuments(conn, r.insertId, d.docs.map((x) => x.file), d.docs.map((x) => x.type), dr.insertId)));
    }
    await conn.commit();
    await startSession(req, r.insertId);
    sendEmail({
      to: data.email,
      subject: "Your Frontier transport registration",
      heading: "Thank you for registering",
      paragraphs: [`Hi ${String(data.contact_person || data.name).split(/\s+/)[0]},`, "We've received your registration as a transport provider. Frontier will review your details and papers, and email you once your account is approved. You can add your vehicles in the meantime."],
      button: { label: "Open your transport dashboard", url: appUrl("/transport/") },
    });
    sendEmail({
      to: recipients(),
      subject: `New transport provider registration: ${data.name}`,
      heading: "A transport provider is waiting for approval",
      paragraphs: ["Please review their details and documents, then approve or reject them and set their coverage."],
      rows: [["Name", data.name], ["Type", data.kind === "company" ? "Company" : "Individual"], ["Phone", data.phone], ["Email", data.email], ["Area", `${data.district}, ${data.province}`], ["Address", data.address], ["Preferred coverage", `${data.preferred_coverage_km} km`], ...(data.kind === "company" ? [["Drivers", fleet.drivers.map((d) => `${d.data.name} (${d.vehicle.data.registration})`).join(", ")]] : [["Vehicle", fleet.vehicles.map((v) => v.data.registration).join(", ")]]), ["Documents", req.files.map((f, i) => DOC_TYPES[docTypesOf(req.body)[i]] || "Other").join(", ")],
        ["Operating location", data.base_lat === null || data.base_lat === undefined ? "Not found on the map: set it before approving" : data.base_label && data.base_label.startsWith("Approximate") ? "Approximate (the address wasn't found exactly): check it before approving" : "From the address"]],
      button: { label: "Review the provider", url: appUrl(`/admin/transport-providers?id=${r.insertId}`) },
    });
    notifications.broadcastAdmin("transport", { change: "provider_registered", provider_id: r.insertId });
    res.status(201).json({ success: true, data: await loadProvider(r.insertId) });
  } catch (error) {
    await conn.rollback().catch(() => {});
    deletePrivateDocuments(...saved);
    next(error);
  } finally {
    conn.release();
  }
});

router.post("/auth/login", async (req, res, next) => {
  try {
    const email = text(req.body.email, 255);
    const password = typeof req.body.password === "string" ? req.body.password : "";
    if (!email || !password) throw badRequest("Email and password are required.");
    const [[row]] = await pool.query("SELECT id, status, is_active, password_hash FROM transport_providers WHERE email = ?", [email.toLowerCase()]);
    const valid = await bcrypt.compare(password, row ? row.password_hash : DUMMY_HASH);
    if (!row || !valid) return res.status(401).json({ success: false, message: "Incorrect email or password." });
    await startSession(req, row.id, { remember: req.body.remember !== false && req.body.remember !== "false" });
    await pool.query("UPDATE transport_providers SET last_login_at = NOW() WHERE id = ?", [row.id]);
    res.json({ success: true, data: await loadProvider(row.id) });
  } catch (error) {
    next(error);
  }
});

// A company driver signs in with their phone number and the sign-in code
// their company gave them (or the password they chose).
router.post("/auth/driver-login", async (req, res, next) => {
  try {
    const phone = text(req.body.phone, 30);
    const password = typeof req.body.password === "string" ? req.body.password.trim() : "";
    if (!phone || !password) throw badRequest("Please enter your phone number and sign-in code.");
    const [[d]] = await pool.query("SELECT d.*, p.is_active AS company_active FROM transport_drivers d JOIN transport_providers p ON p.id = d.provider_id WHERE d.phone_key = ?", [drivers.phoneKey(phone)]);
    const valid = d && d.password_hash ? await drivers.passwordMatches(password, d.password_hash) : await bcrypt.compare(password, DUMMY_HASH);
    if (!d || !valid) return res.status(401).json({ success: false, message: d && !d.password_hash ? "Your company hasn't given you a sign-in code yet. Please ask them for one." : "Incorrect phone number or sign-in code." });
    if (!d.is_active) return res.status(403).json({ success: false, message: "Your driver account is switched off. Please contact your company." });
    await startSession(req, d.provider_id, { driverId: d.id, remember: req.body.remember !== false && req.body.remember !== "false" });
    await pool.query("UPDATE transport_drivers SET last_login_at = NOW() WHERE id = ?", [d.id]);
    res.json({ success: true, data: { ...(await loadProvider(d.provider_id)), role: "driver", driver: { id: d.id, name: d.name, phone: d.phone } } });
  } catch (error) {
    next(error);
  }
});

// What a vehicle can carry and the sizes: for the registration form.
router.get("/auth/options", async (req, res, next) => {
  try {
    res.json({ success: true, data: { cargo_types: await core.cargoLabels(), sizes: core.SIZES } });
  } catch (error) {
    next(error);
  }
});

router.post("/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie(req.app.get("transportCookieName"), { path: "/api/transport" });
    res.json({ success: true });
  });
});

router.post("/auth/forgot", async (req, res, next) => {
  try {
    const email = text(req.body.email, 255);
    if (!email || !isEmail(email)) throw badRequest("Please enter a valid email address.");
    const [[p]] = await pool.query("SELECT id, name, contact_person, email FROM transport_providers WHERE email = ?", [email.toLowerCase()]);
    if (p) {
      const token = crypto.randomBytes(32).toString("hex");
      const hash = crypto.createHash("sha256").update(token).digest("hex");
      await pool.query("DELETE FROM transport_provider_resets WHERE provider_id = ? OR expires_at < NOW()", [p.id]);
      await pool.query("INSERT INTO transport_provider_resets (provider_id, token_hash, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? HOUR))", [p.id, hash, RESET_HOURS]);
      await sendEmail({
        to: p.email,
        subject: "Reset your Frontier transport password",
        heading: "Reset your password",
        paragraphs: [`Hi ${String(p.contact_person || p.name).split(/\s+/)[0]},`, `Use the button below to choose a new password. The link works for ${RESET_HOURS} hour.`, "If you didn't ask for this, you can ignore this email."],
        button: { label: "Choose a new password", url: appUrl(`/transport/reset?token=${token}`) },
      });
    }
    res.json({ success: true, message: "If that email has a transport account, we've sent a link to reset the password." });
  } catch (error) {
    next(error);
  }
});

router.post("/auth/reset", async (req, res, next) => {
  try {
    const token = typeof req.body.token === "string" ? req.body.token : "";
    const password = typeof req.body.password === "string" ? req.body.password : "";
    if (!/^[a-f0-9]{64}$/.test(token)) throw badRequest("This reset link is invalid or has expired.");
    const hash = crypto.createHash("sha256").update(token).digest("hex");
    const [[row]] = await pool.query(
      "SELECT r.provider_id, p.email, p.phone FROM transport_provider_resets r JOIN transport_providers p ON p.id = r.provider_id WHERE r.token_hash = ? AND r.used_at IS NULL AND r.expires_at > NOW()",
      [hash],
    );
    if (!row) throw badRequest("This reset link is invalid or has expired.");
    const problem = passwordRules.problem(password, { email: row.email, phone: row.phone });
    if (problem) throw validationError({ password: problem });
    await pool.query("UPDATE transport_providers SET password_hash = ? WHERE id = ?", [await bcrypt.hash(password, 12), row.provider_id]);
    await pool.query("DELETE FROM transport_provider_resets WHERE provider_id = ?", [row.provider_id]);
    res.json({ success: true, message: "Password updated. You can now sign in." });
  } catch (error) {
    next(error);
  }
});

router.get("/auth/me", requireProvider, async (req, res) => {
  res.json({ success: true, data: { ...req.provider, role: req.driver ? "driver" : "owner", driver: req.driver || null, unread: await notifications.providerUnreadCount(req.provider.id) } });
});

// The provider can change how to reach them. Their operating location, area
// and coverage are Frontier's to change (Admin > Transport providers).
router.put("/me", requireProvider, ownerOnly, async (req, res, next) => {
  try {
    const contactPerson = text(req.body.contact_person, 120);
    const phone = text(req.body.phone, 30);
    const email = text(req.body.email, 255);
    const address = text(req.body.address, 255);
    const errors = {};
    if (contactPerson === undefined) errors.contact_person = "Must be 120 characters or fewer.";
    if (!phone || !isPhone(phone)) errors.phone = "Please enter a valid phone number.";
    if (!email || !isEmail(email)) errors.email = "Please enter a valid email address.";
    else if (await emailTaken(email, req.provider.id)) errors.email = "Another transport account uses this email.";
    if (!address || address.length < 3) errors.address = "Please enter your physical address.";
    if (Object.keys(errors).length) throw validationError(errors);
    await pool.query("UPDATE transport_providers SET contact_person = ?, phone = ?, email = ?, address = ? WHERE id = ?", [contactPerson || null, phone, email.toLowerCase(), address, req.provider.id]);
    res.json({ success: true, message: "Saved.", data: await loadProvider(req.provider.id) });
  } catch (error) {
    next(error);
  }
});

router.patch("/me/password", requireProvider, async (req, res, next) => {
  try {
    const current = String(req.body.current_password || "");
    const fresh = String(req.body.new_password || "");
    if (req.driver) {
      const problem = passwordRules.problem(fresh, { phone: req.driver.phone });
      if (problem) throw validationError({ new_password: problem });
      const d = await drivers.load(req.driver.id);
      if (!(await drivers.passwordMatches(current, d.password_hash))) throw validationError({ current_password: "Your current sign-in code or password is incorrect." });
      await pool.query("UPDATE transport_drivers SET password_hash = ? WHERE id = ?", [await bcrypt.hash(fresh, 12), d.id]);
      return res.json({ success: true, message: "Password updated. Sign in with it from now on." });
    }
    const problem = passwordRules.problem(fresh, { email: req.provider.email, phone: req.provider.phone });
    if (problem) throw validationError({ new_password: problem });
    const [[row]] = await pool.query("SELECT password_hash FROM transport_providers WHERE id = ?", [req.provider.id]);
    if (!(await bcrypt.compare(current, row.password_hash))) throw validationError({ current_password: "Your current password is incorrect." });
    await pool.query("UPDATE transport_providers SET password_hash = ? WHERE id = ?", [await bcrypt.hash(fresh, 12), req.provider.id]);
    res.json({ success: true, message: "Password updated." });
  } catch (error) {
    next(error);
  }
});

// The provider's own on/off switch for new requests.
router.patch("/me/availability", requireProvider, ownerOnly, async (req, res, next) => {
  try {
    const on = req.body.available === true || req.body.available === "1" || req.body.available === "true";
    await pool.query("UPDATE transport_providers SET is_available = ? WHERE id = ?", [on ? 1 : 0, req.provider.id]);
    res.json({ success: true, message: on ? "You're available for new requests." : "You won't get new requests until you switch this back on.", data: await loadProvider(req.provider.id) });
  } catch (error) {
    next(error);
  }
});

// The provider changes how far they'd like to travel. Frontier is told and
// decides whether to change their coverage (Admin > Transport providers).
router.patch("/me/coverage", requireProvider, ownerOnly, async (req, res, next) => {
  try {
    const pref = preferredKm(req.body.preferred_coverage_km);
    if (pref.error) throw validationError({ preferred_coverage_km: pref.error });
    const p = req.provider;
    if (pref.km === p.preferred_coverage_km) return res.json({ success: true, message: "No change.", data: p });
    await pool.query("UPDATE transport_providers SET preferred_coverage_km = ?, preferred_coverage_at = NOW() WHERE id = ?", [pref.km, p.id]);
    sendEmail({
      to: recipients(),
      subject: `${p.name} asks for ${pref.km} km coverage`,
      heading: "A transport provider changed their preferred coverage",
      paragraphs: [`${p.name} would like to cover ${pref.km} km by road from their address${p.coverage_km ? ` (their coverage is ${p.coverage_km} km${p.coverage_active ? "" : ", switched off"})` : " (no coverage set yet)"}. Open their page to accept it or keep the current coverage.`],
      rows: [["Provider", p.name], ["Phone", p.phone], ["Area", `${p.district}, ${p.province}`], ["Preferred", `${pref.km} km`], ["Current", p.coverage_km ? `${p.coverage_km} km` : "Not set"]],
      button: { label: "Review coverage", url: appUrl(`/admin/transport-providers?id=${p.id}`) },
    });
    notifications.broadcastAdmin("transport", { change: "coverage_request", provider_id: p.id });
    res.json({ success: true, message: `Sent to Frontier: ${pref.km} km. Your coverage changes once Frontier confirms it.`, data: await loadProvider(p.id) });
  } catch (error) {
    next(error);
  }
});

// ------------------------------------------------------------- documents
router.get("/me/documents", requireProvider, ownerOnly, async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      "SELECT x.id, x.doc_type, x.original_name, x.mime, x.size_bytes, x.created_at, d.name AS driver_name FROM transport_provider_documents x LEFT JOIN transport_drivers d ON d.id = x.driver_id WHERE x.provider_id = ? ORDER BY x.driver_id IS NOT NULL, d.name, x.id",
      [req.provider.id],
    );
    res.json({ success: true, data: rows.map((d) => ({ ...d, type_label: DOC_TYPES[d.doc_type] || d.doc_type })), types: DOC_TYPES });
  } catch (error) {
    next(error);
  }
});

router.post("/me/documents", requireProvider, ownerOnly, uploadDocuments, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    if (!(req.files || []).length) throw validationError({ documents: "Please choose a file." });
    await conn.beginTransaction();
    await storeDocuments(conn, req.provider.id, req.files, docTypesOf(req.body));
    await conn.commit();
    sendEmail({ to: recipients(), subject: `New documents from ${req.provider.name}`, heading: "A transport provider added documents", paragraphs: [`${req.provider.name} added ${req.files.length} document${req.files.length === 1 ? "" : "s"}.`], button: { label: "Review", url: appUrl(`/admin/transport-providers?id=${req.provider.id}`) } });
    res.json({ success: true, message: "Uploaded. Frontier will review it." });
  } catch (error) {
    await conn.rollback().catch(() => {});
    next(error);
  } finally {
    conn.release();
  }
});

function sendPrivate(res, row) {
  const file = row && privateDocumentPath(row.file_name);
  if (!file || !fs.existsSync(file)) throw notFound("File not found.");
  res.set({ "Content-Type": row.mime || "application/octet-stream", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": `inline; filename="${String(row.original_name || row.file_name).replace(/[^\w.\- ]/g, "_")}"` });
  res.sendFile(file);
}

router.get("/me/documents/:id", requireProvider, ownerOnly, async (req, res, next) => {
  try {
    const [[row]] = await pool.query("SELECT * FROM transport_provider_documents WHERE id = ? AND provider_id = ?", [positiveInt(req.params.id) || 0, req.provider.id]);
    sendPrivate(res, row);
  } catch (error) {
    next(error);
  }
});

// -------------------------------------------------------------- vehicles
async function vehiclesOf(providerId, id = null) {
  const [vehicles] = await pool.query(
    `SELECT v.*, (SELECT b.id FROM transport_bookings b WHERE b.vehicle_id = v.id AND b.status IN (?) LIMIT 1) AS busy_booking,
       (SELECT d.name FROM transport_drivers d WHERE d.vehicle_id = v.id LIMIT 1) AS driver_name
     FROM transport_vehicles v WHERE v.provider_id = ? ${id ? "AND v.id = ?" : ""} ORDER BY v.status, v.id`,
    [core.VEHICLE_BUSY, providerId, ...(id ? [id] : [])],
  );
  if (!vehicles.length) return [];
  const ids = vehicles.map((v) => v.id);
  const [cargo] = await pool.query("SELECT * FROM transport_vehicle_cargo WHERE vehicle_id IN (?)", [ids]);
  const [files] = await pool.query("SELECT id, vehicle_id, kind, image_path, thumb_path, original_name, mime, created_at FROM transport_vehicle_files WHERE vehicle_id IN (?) ORDER BY id", [ids]);
  return vehicles.map((v) => ({
    id: v.id,
    registration: v.registration,
    vehicle_type: v.vehicle_type,
    size_class: v.size_class,
    size_label: core.sizeLabel(v.size_class),
    capacity_note: v.capacity_note,
    status: v.status,
    busy_booking: v.busy_booking ? { id: v.busy_booking, reference: core.bookingRef(v.busy_booking) } : null,
    driver_name: v.driver_name || null,
    cargo: cargo.filter((c) => c.vehicle_id === v.id).map((c) => ({ key: c.cargo_key, max: Number(c.max_quantity) })),
    photos: files.filter((f) => f.vehicle_id === v.id && f.kind === "photo").map((f) => ({ id: f.id, image_path: f.image_path, thumb_path: f.thumb_path })),
    documents: files.filter((f) => f.vehicle_id === v.id && f.kind === "document").map((f) => ({ id: f.id, original_name: f.original_name, mime: f.mime, created_at: f.created_at })),
    created_at: v.created_at,
  }));
}

async function vehiclePayload(body, providerId, exceptId = 0) {
  const registration = text(body.registration, 30);
  const type = text(body.vehicle_type, 60);
  const size = core.SIZE_KEYS.includes(body.size_class) ? body.size_class : null;
  const note = text(body.capacity_note, 255);
  const labels = await core.cargoLabels();
  const errors = {};
  const reg = registration ? registration.toUpperCase().replace(/\s+/g, " ") : null;
  if (!reg || reg.length < 3) errors.registration = "Please enter the registration number.";
  else {
    const [[taken]] = await pool.query("SELECT provider_id FROM transport_vehicles WHERE registration = ? AND id <> ?", [reg, exceptId]);
    if (taken) errors.registration = Number(taken.provider_id) === Number(providerId) ? "You've already registered this vehicle." : "This vehicle is registered by another provider. Please contact Frontier.";
  }
  if (!type || type.length < 2) errors.vehicle_type = "Please enter the vehicle name, e.g. Toyota Hilux.";
  if (!size) errors.size_class = "Please choose the vehicle size.";
  if (note === undefined) errors.capacity_note = "Must be 255 characters or fewer.";
  const cargo = [];
  for (const l of labels) {
    const raw = body[`cargo_${l.key}`];
    if (raw === undefined || raw === "" || raw === null) continue;
    const n = Number.parseInt(raw, 10);
    if (!Number.isInteger(n) || n < 1 || n > 100000) errors[`cargo_${l.key}`] = "Enter a number from 1.";
    else cargo.push({ key: l.key, max: n });
  }
  return { errors, data: { registration: reg, vehicle_type: type, size_class: size, capacity_note: note || null }, cargo };
}

async function saveVehicleFiles(conn, vehicleId, files) {
  const savedPhotos = [];
  const savedDocs = [];
  try {
    for (const f of (files && files.photos) || []) {
      const p = await saveImage(f.buffer);
      savedPhotos.push(p);
      await conn.query("INSERT INTO transport_vehicle_files (vehicle_id, kind, image_path, thumb_path) VALUES (?, 'photo', ?, ?)", [vehicleId, p.image_path, p.thumb_path]);
    }
    for (const f of (files && files.documents) || []) {
      const d = await savePrivateDocument(f);
      savedDocs.push(d.file_name);
      await conn.query("INSERT INTO transport_vehicle_files (vehicle_id, kind, file_name, original_name, mime) VALUES (?, 'document', ?, ?, ?)", [vehicleId, d.file_name, String(f.originalname || "").slice(0, 255), d.mime]);
    }
  } catch (error) {
    deleteImageFiles(...savedPhotos.flatMap((p) => [p.image_path, p.thumb_path]));
    deletePrivateDocuments(...savedDocs);
    throw error;
  }
  return { savedPhotos, savedDocs };
}

router.get("/vehicles", requireProvider, async (req, res, next) => {
  try {
    res.json({ success: true, data: await vehiclesOf(req.provider.id), cargo_types: await core.cargoLabels(), sizes: core.SIZES });
  } catch (error) {
    next(error);
  }
});

router.post("/vehicles", requireProvider, ownerOnly, uploadVehicleFiles, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const { errors, data, cargo } = await vehiclePayload(req.body, req.provider.id);
    if (!((req.files && req.files.photos) || []).length) errors.photos = "Please add at least one photo of the vehicle.";
    // Owner-drivers have one vehicle; more vehicles means registering as a company.
    if (req.provider.kind !== "company") {
      const [[n]] = await pool.query("SELECT COUNT(*) AS n FROM transport_vehicles WHERE provider_id = ?", [req.provider.id]);
      if (Number(n.n) >= 1) throw new HttpError(409, "Owner-drivers have one vehicle. Edit it, or ask Frontier to register you as a company to add more.");
    }
    if (Object.keys(errors).length) throw validationError(errors);
    await conn.beginTransaction();
    const [r] = await conn.query("INSERT INTO transport_vehicles (provider_id, registration, vehicle_type, size_class, capacity_note) VALUES (?, ?, ?, ?, ?)", [req.provider.id, data.registration, data.vehicle_type, data.size_class, data.capacity_note]);
    for (const c of cargo) await conn.query("INSERT INTO transport_vehicle_cargo (vehicle_id, cargo_key, max_quantity) VALUES (?, ?, ?)", [r.insertId, c.key, c.max]);
    await saveVehicleFiles(conn, r.insertId, req.files);
    await conn.commit();
    notifications.broadcastAdmin("transport", { change: "vehicle", provider_id: req.provider.id });
    res.status(201).json({ success: true, message: "Vehicle added.", data: (await vehiclesOf(req.provider.id, r.insertId))[0] });
  } catch (error) {
    await conn.rollback().catch(() => {});
    if (error.code === "ER_DUP_ENTRY") return next(validationError({ registration: "This vehicle is already registered." }));
    next(error);
  } finally {
    conn.release();
  }
});

async function ownVehicle(providerId, id) {
  const [[v]] = await pool.query("SELECT * FROM transport_vehicles WHERE id = ? AND provider_id = ?", [id || 0, providerId]);
  if (!v) throw notFound("Vehicle not found.");
  return v;
}

async function vehicleBusy(id) {
  const [[b]] = await pool.query("SELECT id FROM transport_bookings WHERE vehicle_id = ? AND status IN (?) LIMIT 1", [id, core.VEHICLE_BUSY]);
  return b || null;
}

router.put("/vehicles/:id", requireProvider, ownerOnly, uploadVehicleFiles, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const v = await ownVehicle(req.provider.id, positiveInt(req.params.id));
    const { errors, data, cargo } = await vehiclePayload(req.body, req.provider.id, v.id);
    if (Object.keys(errors).length) throw validationError(errors);
    if (await vehicleBusy(v.id)) throw new HttpError(409, "This vehicle is on a delivery. You can edit it once the delivery is done.");
    await conn.beginTransaction();
    await conn.query("UPDATE transport_vehicles SET registration = ?, vehicle_type = ?, size_class = ?, capacity_note = ? WHERE id = ?", [data.registration, data.vehicle_type, data.size_class, data.capacity_note, v.id]);
    await conn.query("DELETE FROM transport_vehicle_cargo WHERE vehicle_id = ?", [v.id]);
    for (const c of cargo) await conn.query("INSERT INTO transport_vehicle_cargo (vehicle_id, cargo_key, max_quantity) VALUES (?, ?, ?)", [v.id, c.key, c.max]);
    await saveVehicleFiles(conn, v.id, req.files);
    await conn.commit();
    res.json({ success: true, message: "Vehicle saved.", data: (await vehiclesOf(req.provider.id, v.id))[0] });
  } catch (error) {
    await conn.rollback().catch(() => {});
    next(error);
  } finally {
    conn.release();
  }
});

router.patch("/vehicles/:id/status", requireProvider, ownerOnly, async (req, res, next) => {
  try {
    const v = await ownVehicle(req.provider.id, positiveInt(req.params.id));
    const status = req.body.status === "inactive" ? "inactive" : "active";
    if (status === "inactive" && (await vehicleBusy(v.id))) throw new HttpError(409, "This vehicle is on a delivery. You can deactivate it once the delivery is done.");
    await pool.query("UPDATE transport_vehicles SET status = ? WHERE id = ?", [status, v.id]);
    res.json({ success: true, message: status === "active" ? "Vehicle active." : "Vehicle deactivated.", data: (await vehiclesOf(req.provider.id, v.id))[0] });
  } catch (error) {
    next(error);
  }
});

router.delete("/vehicles/:id/files/:fileId", requireProvider, ownerOnly, async (req, res, next) => {
  try {
    const v = await ownVehicle(req.provider.id, positiveInt(req.params.id));
    const [[f]] = await pool.query("SELECT * FROM transport_vehicle_files WHERE id = ? AND vehicle_id = ?", [positiveInt(req.params.fileId) || 0, v.id]);
    if (!f) throw notFound("File not found.");
    if (f.kind === "photo") {
      const [[n]] = await pool.query("SELECT COUNT(*) AS n FROM transport_vehicle_files WHERE vehicle_id = ? AND kind = 'photo'", [v.id]);
      if (Number(n.n) <= 1) throw badRequest("A vehicle needs at least one photo. Add another before removing this one.");
    }
    await pool.query("DELETE FROM transport_vehicle_files WHERE id = ?", [f.id]);
    if (f.kind === "photo") deleteImageFiles(f.image_path, f.thumb_path);
    else deletePrivateDocuments(f.file_name);
    res.json({ success: true, data: (await vehiclesOf(req.provider.id, v.id))[0] });
  } catch (error) {
    next(error);
  }
});

router.get("/vehicles/:id/files/:fileId", requireProvider, ownerOnly, async (req, res, next) => {
  try {
    const v = await ownVehicle(req.provider.id, positiveInt(req.params.id));
    const [[f]] = await pool.query("SELECT * FROM transport_vehicle_files WHERE id = ? AND vehicle_id = ? AND kind = 'document'", [positiveInt(req.params.fileId) || 0, v.id]);
    sendPrivate(res, f);
  } catch (error) {
    next(error);
  }
});

// --------------------------------------------------------------- drivers
// A company's drivers (D: drivers). Only companies have them.
function companyOnly(req, res, next) {
  if (req.provider.kind === "company") return next();
  return res.status(403).json({ success: false, message: "Drivers are for transport companies." });
}
// One vehicle per driver, one driver per vehicle.
async function vehicleForDriver(providerId, vehicleId, exceptDriverId = 0) {
  if (!vehicleId) return { id: null };
  const [[v]] = await pool.query("SELECT id FROM transport_vehicles WHERE id = ? AND provider_id = ?", [vehicleId, providerId]);
  if (!v) return { error: "Please choose one of your vehicles." };
  const [[other]] = await pool.query("SELECT name FROM transport_drivers WHERE vehicle_id = ? AND id <> ?", [vehicleId, exceptDriverId]);
  if (other) return { error: `This vehicle is ${other.name}'s. Each driver has their own vehicle.` };
  return { id: v.id };
}
async function ownDriver(providerId, id) {
  const d = await drivers.load(id);
  if (!d || Number(d.provider_id) !== Number(providerId)) throw notFound("Driver not found.");
  return d;
}

router.get("/drivers", requireProvider, ownerOnly, companyOnly, async (req, res, next) => {
  try {
    res.json({ success: true, data: await drivers.listOf(req.provider.id) });
  } catch (error) {
    next(error);
  }
});

// Adds a driver and makes their sign-in code, shown once to share with them.
router.post("/drivers", requireProvider, ownerOnly, companyOnly, async (req, res, next) => {
  try {
    const { errors, data } = await drivers.driverPayload(req.body);
    const veh = await vehicleForDriver(req.provider.id, positiveInt(req.body.vehicle_id));
    if (veh.error) errors.vehicle_id = veh.error;
    if (Object.keys(errors).length) throw validationError(errors);
    const [r] = await pool.query("INSERT INTO transport_drivers (provider_id, name, phone, phone_key, licence_number, vehicle_id) VALUES (?, ?, ?, ?, ?, ?)", [req.provider.id, data.name, data.phone, data.phone_key, data.licence_number, veh.id]);
    const code = await drivers.setCode(r.insertId);
    res.status(201).json({ success: true, message: "Driver added.", data: (await drivers.listOf(req.provider.id, r.insertId))[0], code });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") return next(validationError({ phone: "This phone number is already registered as a driver." }));
    next(error);
  }
});

router.put("/drivers/:id", requireProvider, ownerOnly, companyOnly, async (req, res, next) => {
  try {
    const d = await ownDriver(req.provider.id, positiveInt(req.params.id));
    const { errors, data } = await drivers.driverPayload(req.body, { exceptId: d.id });
    const veh = await vehicleForDriver(req.provider.id, positiveInt(req.body.vehicle_id), d.id);
    if (veh.error) errors.vehicle_id = veh.error;
    if (Object.keys(errors).length) throw validationError(errors);
    await pool.query("UPDATE transport_drivers SET name = ?, phone = ?, phone_key = ?, licence_number = ?, vehicle_id = ? WHERE id = ?", [data.name, data.phone, data.phone_key, data.licence_number, veh.id, d.id]);
    res.json({ success: true, message: "Driver saved.", data: (await drivers.listOf(req.provider.id, d.id))[0] });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") return next(validationError({ phone: "This phone number is already registered as a driver." }));
    next(error);
  }
});

// The driver's papers (NRC, driver's licence, passport), added by the company.
router.post("/drivers/:id/documents", requireProvider, ownerOnly, companyOnly, uploadDocuments, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const d = await ownDriver(req.provider.id, positiveInt(req.params.id));
    if (!(req.files || []).length) throw validationError({ documents: "Please choose a file." });
    await conn.beginTransaction();
    await storeDocuments(conn, req.provider.id, req.files, docTypesOf(req.body), d.id);
    await conn.commit();
    res.status(201).json({ success: true, message: "Uploaded. Frontier will review it.", data: (await drivers.listOf(req.provider.id, d.id))[0] });
  } catch (error) {
    await conn.rollback().catch(() => {});
    next(error);
  } finally {
    conn.release();
  }
});

// A new sign-in code: the old one stops working (also signs nobody out by itself).
router.post("/drivers/:id/code", requireProvider, ownerOnly, companyOnly, async (req, res, next) => {
  try {
    const d = await ownDriver(req.provider.id, positiveInt(req.params.id));
    const code = await drivers.setCode(d.id);
    res.json({ success: true, message: "New sign-in code made. The old one no longer works.", data: (await drivers.listOf(req.provider.id, d.id))[0], code });
  } catch (error) {
    next(error);
  }
});

// Switched off: the driver is signed out and can't sign in.
router.patch("/drivers/:id/status", requireProvider, ownerOnly, companyOnly, async (req, res, next) => {
  try {
    const d = await ownDriver(req.provider.id, positiveInt(req.params.id));
    const active = req.body.active === true || req.body.active === "1" || req.body.active === "true";
    if (!active) {
      const [[busy]] = await pool.query("SELECT id FROM transport_bookings WHERE driver_id = ? AND status IN (?) LIMIT 1", [d.id, core.VEHICLE_BUSY]);
      if (busy) throw new HttpError(409, `${d.name} is on delivery ${core.bookingRef(busy.id)}. Give it to another driver first, or wait until it's done.`);
    }
    await pool.query("UPDATE transport_drivers SET is_active = ? WHERE id = ?", [active ? 1 : 0, d.id]);
    res.json({ success: true, message: active ? `${d.name} can sign in again.` : `${d.name} is switched off and can't sign in.`, data: (await drivers.listOf(req.provider.id, d.id))[0] });
  } catch (error) {
    next(error);
  }
});

// ------------------------------------------------------------- deliveries
router.get("/summary", requireProvider, async (req, res, next) => {
  try {
    const id = req.provider.id;
    const [[c]] = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM transport_offers o JOIN transport_bookings b ON b.id = o.booking_id WHERE o.provider_id = ? AND o.status = 'offered' AND b.status IN (?)) AS requests,
         (SELECT COUNT(*) FROM transport_bookings WHERE provider_id = ? AND status IN (?)) AS active,
         (SELECT COUNT(*) FROM transport_bookings WHERE provider_id = ? AND status = 'completed') AS completed,
         (SELECT COALESCE(SUM(provider_earning), 0) FROM transport_bookings WHERE provider_id = ? AND status = 'completed' AND provider_paid_at IS NULL) AS owed,
         (SELECT COALESCE(SUM(provider_earning), 0) FROM transport_bookings WHERE provider_id = ? AND provider_paid_at IS NOT NULL) AS paid,
         (SELECT ROUND(AVG(stars), 1) FROM transport_ratings WHERE provider_id = ? AND hidden = 0) AS rating,
         (SELECT COUNT(*) FROM transport_ratings WHERE provider_id = ? AND hidden = 0) AS ratings,
         (SELECT COUNT(*) FROM transport_vehicles WHERE provider_id = ? AND status = 'active') AS vehicles`,
      [id, bookings.ACCEPTABLE, id, [...core.GROUPS.accepted, ...core.GROUPS.active, "disputed"], id, id, id, id, id, id],
    );
    const data = Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v === null ? null : Number(v)]));
    if (req.driver) {
      const [[mine]] = await pool.query(
        "SELECT SUM(status IN (?)) AS active, SUM(status = 'completed') AS completed FROM transport_bookings WHERE provider_id = ? AND driver_id = ?",
        [[...core.GROUPS.accepted, ...core.GROUPS.active, "disputed"], id, req.driver.id],
      );
      Object.assign(data, { active: Number(mine.active) || 0, completed: Number(mine.completed) || 0, owed: null, paid: null });
    }
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

// Requests sent to this provider that are still open.
router.get("/requests", requireProvider, requireApproved, async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT b.*, o.status AS offer_status, o.offered_at, o.pickup_km, o.dest_km
       FROM transport_offers o JOIN transport_bookings b ON b.id = o.booking_id
       WHERE o.provider_id = ? AND o.status = 'offered' AND b.status IN (?)
       ORDER BY o.offered_at DESC LIMIT 100`,
      [req.provider.id, bookings.ACCEPTABLE],
    );
    res.json({ success: true, data: rows.map((b) => ({ ...views.row(b, "provider"), offered_at: b.offered_at, pickup_km: b.pickup_km === null ? null : Number(b.pickup_km) })) });
  } catch (error) {
    next(error);
  }
});

router.get("/bookings", requireProvider, async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT b.*, d.name AS driver_name FROM transport_bookings b LEFT JOIN transport_drivers d ON d.id = b.driver_id
       WHERE b.provider_id = ? ${req.driver ? "AND b.driver_id = ?" : ""} ORDER BY COALESCE(b.completed_at, b.updated_at) DESC, b.id DESC LIMIT 300`,
      [req.provider.id, ...(req.driver ? [req.driver.id] : [])],
    );
    res.json({ success: true, data: rows.map((b) => ({ ...views.row(b, "provider"), driver_name: b.driver_name || null })) });
  } catch (error) {
    next(error);
  }
});

// One delivery: the full details once it's theirs, or just the request.
async function forProvider(req) {
  const id = positiveInt(req.params.id);
  const b = id ? await bookings.loadBooking(id) : null;
  if (!b) throw notFound("Delivery not found.");
  if (Number(b.provider_id) === Number(req.provider.id)) {
    if (req.driver && Number(b.driver_id) !== Number(req.driver.id)) throw notFound("This delivery is with another of your company's drivers.");
    return { b, offer: null };
  }
  const [[offer]] = await pool.query("SELECT * FROM transport_offers WHERE booking_id = ? AND provider_id = ?", [b.id, req.provider.id]);
  if (!offer) throw notFound("Delivery not found.");
  return { b, offer };
}

router.get("/bookings/:id", requireProvider, async (req, res, next) => {
  try {
    const { b, offer } = await forProvider(req);
    const mine = req.driver ? await drivers.load(req.driver.id) : null;
    const data = await views.detail(b, "provider", { offer: offer || null });
    data.can = offer
      ? { accept: offer.status === "offered" && bookings.ACCEPTABLE.includes(b.status) && req.provider.status === "approved" && req.provider.is_active, decline: offer.status === "offered" && bookings.ACCEPTABLE.includes(b.status) }
      : await providerActions(b);
    data.comments = { collection: bookings.COLLECTION_NOTES, delivery: bookings.DELIVERY_NOTES };
    // Which of their vehicles could take it.
    if (data.can.accept) {
      data.vehicles = await vehicleChoices(req.provider.id, b);
      // A company driver drives their own vehicle only.
      if (mine) data.vehicles = data.vehicles.filter((v) => Number(v.id) === Number(mine.vehicle_id));
    }
    // Companies: their drivers, to choose who does it (D: drivers).
    data.role = req.driver ? "driver" : "owner";
    if (!req.driver && req.provider.kind === "company") {
      data.drivers = (await drivers.listOf(req.provider.id)).filter((x) => x.is_active).map((x) => ({ id: x.id, name: x.name, phone: x.phone, vehicle: x.vehicle, busy: Boolean(x.busy_booking && x.busy_booking.id !== b.id) }));
      data.can.assign_driver = !offer && !["completed", "cancelled", "refund_pending", "refunded"].includes(b.status);
    }
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

async function providerActions(b) {
  const subs = await bookings.submissionsOf(pool, b.id);
  return {
    collect: bookings.COLLECTING.includes(b.status) && !subs.has("provider_collection"),
    start: b.status === "collection_confirmed",
    share_location: bookings.MOVING.includes(b.status),
    arrive: false,
    deliver: bookings.TRACKING.includes(b.status),
  };
}

// The provider's active vehicles, marked whether each can take this booking.
async function vehicleChoices(providerId, b) {
  const matching = require("../lib/transport/matching");
  const { job } = await matching.jobOf(pool, b);
  const [p] = await matching.providersWithVehicles(pool, { providerIds: [providerId], excludeBooking: b.id });
  return (p ? p.vehicles : []).filter((v) => v.status === "active").map((v) => ({
    id: v.id, registration: v.registration, vehicle_type: v.vehicle_type, size_label: core.sizeLabel(v.size_class), busy: v.busy, fits: core.vehicleFits(v.cargo, job.load) && (!job.size || v.size_class === job.size), wrong_size: Boolean(job.size && v.size_class !== job.size),
  }));
}

router.post("/bookings/:id/accept", requireProvider, requireApproved, async (req, res, next) => {
  try {
    const vehicleId = positiveInt(req.body.vehicle_id);
    if (!vehicleId) throw validationError({ vehicle_id: "Please choose the vehicle you'll use." });
    const bookingId = positiveInt(req.params.id);
    // Who drives: the driver who accepts, or the one the company chooses.
    let driver = null;
    if (req.driver) {
      const d = await drivers.load(req.driver.id);
      if (!d.vehicle_id) throw new HttpError(409, "Your company hasn't given you a vehicle yet. Please ask them to.");
      if (Number(d.vehicle_id) !== Number(vehicleId)) throw validationError({ vehicle_id: "Please use your own vehicle." });
      driver = req.driver;
    } else if (positiveInt(req.body.driver_id)) {
      const d = await ownDriver(req.provider.id, positiveInt(req.body.driver_id));
      if (!d.is_active) throw validationError({ driver_id: "This driver is switched off." });
      if (d.vehicle_id && Number(d.vehicle_id) !== Number(vehicleId)) throw validationError({ driver_id: `${d.name} drives their own vehicle. Choose it, or another driver.` });
      driver = d;
    }
    await bookings.accept(req.provider.id, bookingId, vehicleId);
    if (driver) await setDriver(bookingId, driver, req.who);
    res.json({ success: true, message: "Accepted. The seller and buyer have been told." });
  } catch (error) {
    next(error);
  }
});

// The company gives a delivery to one of its drivers (or takes it back: null).
async function setDriver(bookingId, driver, who) {
  await pool.query("UPDATE transport_bookings SET driver_id = ? WHERE id = ?", [driver ? driver.id : null, bookingId]);
  await core.logEvent(pool, bookingId, { event: "driver_assigned", actor: "provider", actorName: who.name, detail: driver ? `Driver: ${driver.name} (${driver.phone}).` : "No driver assigned." });
}
router.patch("/bookings/:id/driver", requireProvider, ownerOnly, companyOnly, async (req, res, next) => {
  try {
    const b = await bookings.loadBooking(positiveInt(req.params.id));
    if (!b || Number(b.provider_id) !== Number(req.provider.id)) throw notFound("Delivery not found.");
    if (["completed", "cancelled", "refund_pending", "refunded"].includes(b.status)) throw new HttpError(409, "This delivery is finished.");
    let d = null;
    if (positiveInt(req.body.driver_id)) {
      d = await ownDriver(req.provider.id, positiveInt(req.body.driver_id));
      if (!d.is_active) throw validationError({ driver_id: "This driver is switched off." });
    }
    // Each driver drives their own vehicle: a different driver means their
    // vehicle goes, which is only possible before the goods are collected.
    if (d && d.vehicle_id && Number(d.vehicle_id) !== Number(b.vehicle_id)) {
      if (!["provider_accepted", "vehicle_selected", "awaiting_collection"].includes(b.status)) throw validationError({ driver_id: `The goods are already in ${b.vehicle_registration}. Only its driver can take this delivery now.` });
      const choice = (await vehicleChoices(req.provider.id, b)).find((v) => Number(v.id) === Number(d.vehicle_id));
      if (!choice || choice.busy) throw validationError({ driver_id: `${d.name}'s vehicle is on another delivery.` });
      if (!choice.fits) throw validationError({ driver_id: `${d.name}'s vehicle ${choice.registration} can't take this delivery${choice.wrong_size ? " (not the size the buyer chose)" : ""}.` });
      const [[v]] = await pool.query("SELECT registration, vehicle_type FROM transport_vehicles WHERE id = ?", [d.vehicle_id]);
      await pool.query("UPDATE transport_bookings SET vehicle_id = ?, vehicle_registration = ?, vehicle_type = ? WHERE id = ?", [d.vehicle_id, v.registration, v.vehicle_type, b.id]);
      await core.logEvent(pool, b.id, { event: "vehicle_selected", actor: "provider", actorName: req.who.name, detail: `Vehicle ${v.registration} (${v.vehicle_type}).` });
    }
    await setDriver(b.id, d, req.who);
    notifications.notifyProvider(req.provider.id, { type: "delivery", title: d ? `${core.bookingRef(b.id)} is with ${d.name}` : `${core.bookingRef(b.id)} has no driver`, link: `/transport/?booking=${b.id}` });
    res.json({ success: true, message: d ? `${core.bookingRef(b.id)} is now with ${d.name}.` : "Driver removed from this delivery." });
  } catch (error) {
    next(error);
  }
});

router.post("/bookings/:id/decline", requireProvider, ownerOnly, async (req, res, next) => {
  try {
    await bookings.decline(req.provider.id, positiveInt(req.params.id), req.body.reason);
    res.json({ success: true, message: "Declined." });
  } catch (error) {
    next(error);
  }
});

// Delivery steps: a company's driver only on the deliveries given to them.
async function onlyAssigned(req, res, next) {
  if (!req.driver) return next();
  try {
    const [[b]] = await pool.query("SELECT provider_id, driver_id FROM transport_bookings WHERE id = ?", [positiveInt(req.params.id) || 0]);
    if (b && Number(b.provider_id) === Number(req.provider.id) && Number(b.driver_id) === Number(req.driver.id)) return next();
    return res.status(403).json({ success: false, message: "This delivery is with another of your company's drivers." });
  } catch (error) {
    return next(error);
  }
}

router.post("/bookings/:id/collection", requireProvider, requireApproved, onlyAssigned, uploadTransportPhotos, async (req, res, next) => {
  try {
    await bookings.providerCollected(req.who, positiveInt(req.params.id), req.files, req.body);
    res.json({ success: true, message: "Collected. Tap Start delivery when you leave." });
  } catch (error) {
    next(error);
  }
});

router.post("/bookings/:id/start", requireProvider, requireApproved, onlyAssigned, async (req, res, next) => {
  try {
    await bookings.start(req.who, positiveInt(req.params.id), req.body);
    res.json({ success: true, message: "Delivery started. Keep this page open so your location is shared." });
  } catch (error) {
    next(error);
  }
});

router.post("/bookings/:id/location", requireProvider, onlyAssigned, async (req, res, next) => {
  try {
    const r = await bookings.recordLocation(req.who, positiveInt(req.params.id), req.body);
    res.json({ success: true, data: r });
  } catch (error) {
    next(error);
  }
});

router.post("/bookings/:id/arrive", requireProvider, requireApproved, onlyAssigned, async (req, res, next) => {
  try {
    await bookings.arrive(req.who, positiveInt(req.params.id), req.body);
    res.json({ success: true, message: "Arrival recorded. Tap Delivered once you've handed the goods over." });
  } catch (error) {
    next(error);
  }
});

router.post("/bookings/:id/delivery", requireProvider, requireApproved, onlyAssigned, uploadTransportPhotos, async (req, res, next) => {
  try {
    await bookings.providerDelivered(req.who, positiveInt(req.params.id), req.files, req.body);
    res.json({ success: true, message: "Delivered. The buyer has been told." });
  } catch (error) {
    next(error);
  }
});

router.get("/bookings/:id/track", requireProvider, async (req, res, next) => {
  try {
    const { b, offer } = await forProvider(req);
    if (offer) throw notFound("Delivery not found.");
    res.json({ success: true, data: await views.track(b.id, req.query.after) });
  } catch (error) {
    next(error);
  }
});

router.get("/ratings", requireProvider, async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      "SELECT r.booking_id, r.stars, r.feedback, r.created_at FROM transport_ratings r WHERE r.provider_id = ? AND r.hidden = 0 ORDER BY r.id DESC LIMIT 200",
      [req.provider.id],
    );
    res.json({ success: true, data: rows.map((r) => ({ ...r, reference: core.bookingRef(r.booking_id) })) });
  } catch (error) {
    next(error);
  }
});

router.get("/meta", requireProvider, async (req, res, next) => {
  try {
    res.json({ success: true, data: { cargo_types: await core.cargoLabels(), doc_types: DOC_TYPES, provinces: PROVINCES } });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------- notifications
router.get("/notifications", requireProvider, async (req, res, next) => {
  try {
    const [rows] = await pool.query("SELECT id, type, title, body, link, read_at, created_at FROM transport_provider_notifications WHERE provider_id = ? ORDER BY id DESC LIMIT 50", [req.provider.id]);
    res.json({ success: true, data: rows, unread: await notifications.providerUnreadCount(req.provider.id) });
  } catch (error) {
    next(error);
  }
});

router.post("/notifications/read", requireProvider, async (req, res, next) => {
  try {
    await pool.query("UPDATE transport_provider_notifications SET read_at = NOW() WHERE provider_id = ? AND read_at IS NULL", [req.provider.id]);
    res.json({ success: true, unread: 0 });
  } catch (error) {
    next(error);
  }
});

router.get("/events", requireProvider, (req, res) => notifications.subscribeProvider(req.provider.id, req, res));

// A one-time link to choose a password: for providers an admin adds (D: admin adds providers).
async function passwordLink(providerId, hours = 72) {
  const token = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  await pool.query("DELETE FROM transport_provider_resets WHERE provider_id = ? OR expires_at < NOW()", [providerId]);
  await pool.query("INSERT INTO transport_provider_resets (provider_id, token_hash, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? HOUR))", [providerId, hash, hours]);
  return appUrl(`/transport/reset?token=${token}`);
}

module.exports = router;
module.exports.DOC_TYPES = DOC_TYPES;
module.exports.registrationPayload = registrationPayload;
module.exports.emailTaken = emailTaken;
module.exports.storeDocuments = storeDocuments;
module.exports.docTypesOf = docTypesOf;
module.exports.vehiclePayload = vehiclePayload;
module.exports.saveVehicleFiles = saveVehicleFiles;
module.exports.vehicleBusy = vehicleBusy;
module.exports.passwordLink = passwordLink;
module.exports.sendPrivate = sendPrivate;
module.exports.vehiclesOf = vehiclesOf;
