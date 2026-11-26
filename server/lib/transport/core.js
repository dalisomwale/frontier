// Transport: the parts every other transport module uses.
//
//   settings        Frontier's own pickup point, acceptance window, commission ...
//   price bands     distance-based prices set by Frontier (never by providers)
//   statuses        the booking lifecycle and which changes are allowed
//   transition()    the only way a booking's status changes (logged in
//                   transport_events, guarded against concurrent changes)
//   cargo           what a booking carries, and whether a vehicle can take it
const pool = require("../../db");
const { HttpError } = require("../validate");

// ---------------------------------------------------------------- settings
const DEFAULT_SETTINGS = {
  enabled: "1",
  accept_window_minutes: "60",
  gps_stale_minutes: "15",
  commission_pct: "0",
  auto_complete_hours: "24",
  frontier_pickup_label: "Frontier Farms & Consult",
  frontier_pickup_address: "",
  frontier_pickup_district: "",
  frontier_pickup_province: "",
  frontier_pickup_phone: "",
  frontier_pickup_lat: "",
  frontier_pickup_lng: "",
  // Price of each vehicle size, as a percentage of the distance price (100 = the band price).
  size_pct_bike: "100",
  size_pct_small: "100",
  size_pct_medium: "100",
  size_pct_large: "100",
  size_pct_extra_large: "100",
};

// Vehicle sizes: providers give each vehicle one; buyers choose one at
// checkout. hint: example vehicles of that size.
// capacities: the load ranges (kg) a provider picks from for that size.
const SIZES = [
  { key: "bike", label: "Bike", hint: "Motorbike, Cargo Tricycle, Bicycle with Carrier", capacities: ["Up to 50 kg", "50–100 kg", "100–200 kg", "200–300 kg"] },
  { key: "small", label: "Small", hint: "Pickup, Panel Van, Minibus", capacities: ["300–500 kg", "500–1,000 kg", "1,000–1,500 kg"] },
  { key: "medium", label: "Medium", hint: "Mitsubishi Canter, Toyota Dyna, Isuzu NPR", capacities: ["1,500–3,000 kg", "3,000–5,000 kg", "5,000–8,000 kg"] },
  { key: "large", label: "Large", hint: "Isuzu FTR, UD Truck, Hino 500", capacities: ["8,000–12,000 kg", "12,000–16,000 kg", "16,000–20,000 kg"] },
  { key: "extra_large", label: "Extra Large", hint: "Horse and Trailer, Interlink, Flatbed Trailer", capacities: ["20,000–30,000 kg", "30,000–40,000 kg", "Over 40,000 kg"] },
];
const SIZE_KEYS = SIZES.map((x) => x.key);
const sizeLabel = (k) => (SIZES.find((x) => x.key === k) || {}).label || null;

async function getSettings(conn = pool) {
  const [rows] = await conn.query("SELECT name, value FROM transport_settings");
  const out = { ...DEFAULT_SETTINGS };
  rows.forEach((r) => { if (r.name in out) out[r.name] = r.value ?? ""; });
  const num = (v, d) => (Number.isFinite(Number(v)) && String(v) !== "" ? Number(v) : d);
  return {
    enabled: out.enabled === "1",
    accept_window_minutes: Math.max(5, num(out.accept_window_minutes, 60)),
    gps_stale_minutes: Math.max(2, num(out.gps_stale_minutes, 15)),
    commission_pct: Math.min(100, Math.max(0, num(out.commission_pct, 0))),
    auto_complete_hours: Math.min(168, Math.max(0, Math.round(num(out.auto_complete_hours, 24)))),
    size_pct: Object.fromEntries(SIZE_KEYS.map((k) => [k, Math.min(1000, Math.max(1, num(out[`size_pct_${k}`], 100)))])),
    frontier_pickup: {
      label: out.frontier_pickup_label || "Frontier Farms & Consult",
      address: out.frontier_pickup_address || "",
      district: out.frontier_pickup_district || "",
      province: out.frontier_pickup_province || "",
      phone: out.frontier_pickup_phone || "",
      lat: out.frontier_pickup_lat === "" ? null : num(out.frontier_pickup_lat, null),
      lng: out.frontier_pickup_lng === "" ? null : num(out.frontier_pickup_lng, null),
    },
  };
}

async function saveSettings(values) {
  const entries = Object.entries(values).filter(([k]) => k in DEFAULT_SETTINGS);
  for (const [name, value] of entries) {
    await pool.query(
      "INSERT INTO transport_settings (name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)",
      [name, value === null || value === undefined ? "" : String(value)],
    );
  }
  return getSettings();
}

// -------------------------------------------------------------- price bands
const round2 = (n) => Math.round(Number(n) * 100) / 100;

async function activeBands(conn = pool) {
  const [rows] = await conn.query("SELECT * FROM transport_price_bands WHERE is_active = 1 ORDER BY min_km, id");
  return rows.map(bandView);
}

function bandView(b) {
  return {
    id: b.id,
    min_km: Number(b.min_km),
    max_km: b.max_km === null ? null : Number(b.max_km),
    base_fee: Number(b.base_fee),
    per_km: Number(b.per_km),
    is_active: Boolean(b.is_active),
    label: bandLabel(b),
  };
}

function bandLabel(b) {
  const min = Number(b.min_km);
  return b.max_km === null || b.max_km === undefined ? `Above ${min} km` : `${min} – ${Number(b.max_km)} km`;
}

// The band for a distance: min_km <= km < max_km (the last band may be open-ended).
function bandFor(km, bands) {
  return bands.find((b) => km >= b.min_km && (b.max_km === null || km < b.max_km)) || null;
}

// pct: the chosen vehicle size's price, as a percentage of the band price.
function priceFor(km, bands, commissionPct = 0, pct = 100) {
  const band = bandFor(km, bands);
  if (!band) return null;
  const fee = round2(((band.base_fee + band.per_km * km) * pct) / 100);
  const commission = round2((fee * commissionPct) / 100);
  return { band, fee, commission, earning: round2(fee - commission) };
}

// Active bands must not overlap. Returns a message, or null.
function overlapProblem(bands) {
  const list = [...bands].filter((b) => b.is_active).sort((a, b) => a.min_km - b.min_km);
  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1];
    if (prev.max_km === null || prev.max_km > list[i].min_km) {
      return `The bands ${bandLabel(prev)} and ${bandLabel(list[i])} overlap. Each distance may only fall in one active band.`;
    }
  }
  return null;
}

// Distances no active band covers (shown to the admin).
function bandGaps(bands) {
  const list = [...bands].filter((b) => b.is_active).sort((a, b) => a.min_km - b.min_km);
  const gaps = [];
  let reach = 0;
  for (const b of list) {
    if (b.min_km > reach) gaps.push(`${reach} – ${b.min_km} km`);
    if (b.max_km === null) return gaps;
    reach = Math.max(reach, b.max_km);
  }
  gaps.push(`above ${reach} km`);
  return gaps;
}

// ----------------------------------------------------------------- statuses
const STATUS_LABELS = {
  pending_payment: "Awaiting payment",
  payment_confirmed: "Payment confirmed",
  awaiting_provider: "Awaiting provider acceptance",
  provider_accepted: "Provider assigned",
  vehicle_selected: "Vehicle selected",
  awaiting_collection: "Awaiting collection",
  collection_submitted: "Collection documentation submitted",
  collection_confirmed: "Collection confirmed",
  in_transit: "In transit",
  arrived: "Arrived at destination",
  delivery_submitted: "Delivery documentation submitted",
  awaiting_confirmation: "Awaiting customer confirmation",
  completed: "Completed",
  awaiting_reassignment: "Awaiting reassignment",
  disputed: "Delivery disputed",
  cancelled: "Cancelled",
  refund_pending: "Refund pending",
  refunded: "Refunded",
};

// Allowed status changes. Anything else is refused by transition().
const TRANSITIONS = {
  pending_payment: ["payment_confirmed", "cancelled"],
  payment_confirmed: ["awaiting_provider", "awaiting_reassignment", "provider_accepted", "refund_pending"],
  awaiting_provider: ["provider_accepted", "awaiting_reassignment", "refund_pending"],
  awaiting_reassignment: ["awaiting_provider", "provider_accepted", "refund_pending"],
  provider_accepted: ["vehicle_selected", "awaiting_reassignment", "refund_pending"],
  vehicle_selected: ["awaiting_collection"],
  awaiting_collection: ["collection_submitted", "awaiting_reassignment", "refund_pending"],
  collection_submitted: ["collection_confirmed", "awaiting_reassignment", "refund_pending"],
  collection_confirmed: ["in_transit"],
  in_transit: ["arrived"],
  arrived: ["delivery_submitted"],
  delivery_submitted: ["awaiting_confirmation"],
  awaiting_confirmation: ["completed", "disputed"],
  disputed: ["completed", "refund_pending"],
  refund_pending: ["refunded"],
  completed: [],
  cancelled: [],
  refunded: [],
};

// Groups used by lists and filters.
const GROUPS = {
  unpaid: ["pending_payment"],
  pending: ["payment_confirmed", "awaiting_provider", "awaiting_reassignment"],
  accepted: ["provider_accepted", "vehicle_selected", "awaiting_collection", "collection_submitted", "collection_confirmed"],
  active: ["in_transit", "arrived", "delivery_submitted", "awaiting_confirmation"],
  completed: ["completed"],
  disputed: ["disputed"],
  closed: ["cancelled", "refund_pending", "refunded"],
};
// A vehicle on one of these bookings is busy.
const VEHICLE_BUSY = ["provider_accepted", "vehicle_selected", "awaiting_collection", "collection_submitted", "collection_confirmed", "in_transit", "arrived", "delivery_submitted"];
// Before the goods leave the seller.
const BEFORE_COLLECTION = ["pending_payment", "payment_confirmed", "awaiting_provider", "awaiting_reassignment", "provider_accepted", "awaiting_collection", "collection_submitted"];

const ACTOR_KINDS = ["system", "customer", "seller", "provider", "admin"];

function conflict(message) {
  return new HttpError(409, message);
}

async function logEvent(conn, bookingId, { from = null, to = null, event, actor = "system", actorName = null, detail = "" }) {
  await conn.query(
    "INSERT INTO transport_events (booking_id, from_status, to_status, event, actor, actor_name, detail) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [bookingId, from, to, String(event).slice(0, 40), ACTOR_KINDS.includes(actor) ? actor : "system", actorName ? String(actorName).slice(0, 150) : null, String(detail || "").slice(0, 1000)],
  );
}

// Changes a booking's status: checks the change is allowed, applies it only
// if nobody changed the booking meanwhile, and logs it. `set` holds other
// columns to update in the same statement (values, or { raw: "NOW()" }).
async function transition(conn, booking, to, { event, actor = "system", actorName = null, detail = "", set = {} } = {}) {
  const from = booking.status;
  if (!(TRANSITIONS[from] || []).includes(to)) {
    throw conflict(`This delivery can't go from "${STATUS_LABELS[from] || from}" to "${STATUS_LABELS[to] || to}".`);
  }
  const cols = ["status = ?"];
  const params = [to];
  for (const [col, value] of Object.entries(set)) {
    if (!/^[a-z_]+$/.test(col)) throw new Error(`Bad column ${col}`);
    if (value && typeof value === "object" && value.raw === "NOW()") cols.push(`${col} = NOW()`);
    else {
      cols.push(`${col} = ?`);
      params.push(value);
    }
  }
  const [result] = await conn.query(`UPDATE transport_bookings SET ${cols.join(", ")} WHERE id = ? AND status = ?`, [...params, booking.id, from]);
  if (!result.affectedRows) throw conflict("This delivery was just updated by someone else. Please refresh and try again.");
  await logEvent(conn, booking.id, { from, to, event: event || to, actor, actorName, detail });
  booking.status = to;
  return booking;
}

// Runs fn(conn, booking) in a transaction with the booking row locked.
async function withBooking(bookingId, fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[booking]] = await conn.query("SELECT * FROM transport_bookings WHERE id = ? FOR UPDATE", [bookingId]);
    if (!booking) throw new HttpError(404, "Delivery not found.");
    const out = await fn(conn, booking);
    await conn.commit();
    return out;
  } catch (error) {
    await conn.rollback().catch(() => {});
    throw error;
  } finally {
    conn.release();
  }
}

// -------------------------------------------------------------------- cargo
// What an order carries: an animal category ('a<id>') or feed ('feed').
const cargoKeyOf = (o) => (o.animal_kind === "feed" ? "feed" : o.animal_id ? `a${o.animal_id}` : null);

// { key: quantity } for a list of orders/lines with animal_id, animal_kind, quantity.
function loadOf(items) {
  const load = {};
  for (const it of items) {
    const k = cargoKeyOf(it);
    if (!k) continue;
    load[k] = (load[k] || 0) + Number(it.quantity || 0);
  }
  return load;
}

// A vehicle takes any load its size allows: the buyer chose the size, and
// the size is matched separately. Per-animal load limits are no longer set,
// so any an older version stored are ignored here.
function vehicleFits(cargo, load) {
  return Object.keys(load).length > 0;
}

async function cargoLabels(conn = pool) {
  const [animals] = await conn.query("SELECT id, name FROM animals WHERE kind = 'livestock' ORDER BY sort_order, name");
  return [...animals.map((a) => ({ key: `a${a.id}`, label: a.name, unit: a.name === "Poultry" ? "birds" : "head" })), { key: "feed", label: "Feed", unit: "bags" }];
}

function loadText(load, labels) {
  return Object.entries(load).map(([k, q]) => {
    const l = labels.find((x) => x.key === k);
    return `${q} ${l ? (l.key === "feed" ? "bags of feed" : `${l.unit === "birds" ? (q === 1 ? "bird" : "birds") : "head"} of ${l.label.toLowerCase()}`) : k}`;
  }).join(", ");
}

// Orders a booking carries, with what each one is.
async function bookingOrders(conn, bookingId) {
  const [rows] = await conn.query(
    `SELECT o.*, a.id AS animal_id, a.name AS animal_name, a.kind AS animal_kind,
       (SELECT li.thumb_path FROM livestock_images li WHERE li.livestock_id = o.livestock_id ORDER BY li.sort_order, li.id LIMIT 1) AS thumb_path
     FROM transport_booking_orders bo
     JOIN orders o ON o.id = bo.order_id
     LEFT JOIN livestock l ON l.id = o.livestock_id
     LEFT JOIN categories c ON c.id = l.category_id
     LEFT JOIN animals a ON a.id = c.animal_id
     WHERE bo.booking_id = ? ORDER BY o.id`,
    [bookingId],
  );
  return rows;
}

const bookingRef = (id) => `TR-${1000 + Number(id)}`;
// "Plot 1, Great East Rd, Chongwe, Lusaka": the physical address with its
// district and province, without repeating a part already written.
function placeText(...parts) {
  const out = [];
  for (const raw of parts) {
    const part = String(raw || "").trim();
    if (!part) continue;
    const seen = out.join(", ").toLowerCase();
    if (seen.split(/,\s*/).includes(part.toLowerCase())) continue;
    out.push(part);
  }
  return out.join(", ");
}
const pickupPlace = (b) => placeText(b.pickup_address, b.pickup_district, b.pickup_province) || b.pickup_label;
const destPlace = (b) => placeText(b.dest_address, b.dest_district, b.dest_province);
const isNum = (v) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));
function point(lat, lng) {
  return isNum(lat) && isNum(lng) && Math.abs(Number(lat)) <= 90 && Math.abs(Number(lng)) <= 180 && !(Number(lat) === 0 && Number(lng) === 0)
    ? { lat: Number(lat), lng: Number(lng) }
    : null;
}

module.exports = {
  DEFAULT_SETTINGS, getSettings, saveSettings,
  activeBands, bandView, bandLabel, bandFor, priceFor, overlapProblem, bandGaps, round2,
  STATUS_LABELS, TRANSITIONS, GROUPS, VEHICLE_BUSY, BEFORE_COLLECTION,
  logEvent, transition, withBooking, conflict,
  cargoKeyOf, loadOf, vehicleFits, cargoLabels, loadText, bookingOrders,
  bookingRef, point, placeText, pickupPlace, destPlace,
  SIZES, SIZE_KEYS, sizeLabel,
};
