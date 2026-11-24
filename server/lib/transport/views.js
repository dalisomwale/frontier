// What each party is shown about a transport booking.
//
//   admin      everything
//   customer   their delivery: provider, vehicle, route, live position, all
//              photos and quantities. Not the seller's address or phone.
//   seller     their goods: provider, vehicle, live position, photos and
//              quantities. Not the buyer's contact details or exact address.
//   provider   before accepting: the area, distance, load and earning only.
//              Once assigned: the pickup and delivery details they need.
const pool = require("../../db");
const core = require("./core");
const routing = require("../../services/routing");
const { orderRef, headCount } = require("../orders");

const { STATUS_LABELS, GROUPS, bookingRef } = core;
const checkoutRef = (id) => `FMC-${1000 + Number(id)}`;
const num = (v) => (v === null || v === undefined ? null : Number(v));

function groupOf(status) {
  return Object.keys(GROUPS).find((g) => GROUPS[g].includes(status)) || "other";
}

// What each kind of party is called in the history.
const EVENT_LABELS = {
  created: "Transport booked at checkout",
  payment_confirmed: "Payment confirmed",
  offers_sent: "Request sent to transport providers",
  awaiting_provider: "Waiting for a provider to accept",
  no_provider: "No eligible provider yet",
  all_declined: "Every provider declined",
  declined: "A provider declined",
  accepted: "Provider accepted",
  assigned: "Provider assigned by Frontier",
  vehicle_selected: "Vehicle selected",
  awaiting_collection: "Waiting for collection",
  seller_ready: "Seller marked the goods ready",
  seller_collection: "Seller recorded the handover",
  provider_collection: "Provider recorded the collection",
  collection_confirmed: "Collection confirmed",
  in_transit: "Delivery started",
  arrived: "Arrived at the destination",
  delivery_submitted: "Provider recorded the delivery",
  awaiting_confirmation: "Waiting for the buyer to confirm",
  completed: "Delivery confirmed by the buyer",
  disputed: "Problem reported by the buyer",
  dispute_resolved: "Problem resolved by Frontier",
  released: "Reassigned by Frontier",
  cancelled: "Cancelled",
  refund_pending: "Refund pending",
  refunded: "Refunded",
  provider_paid: "Provider paid",
  provider_rated: "Provider rated",
  held: "Held by Frontier",
  unheld: "Hold released by Frontier",
  order_cancelled: "An order was cancelled",
  routing_error: "Road distances unavailable",
  unaccepted_alert: "Frontier alerted: not accepted yet",
  delay_alert: "Frontier alerted: delivery may be delayed",
  confirm_reminder: "Buyer reminded to confirm",
  heading_to_pickup: "Provider on the way to the pickup",
  near_pickup: "Provider close to the pickup",
  near_destination: "Close to the destination",
  auto_completed: "Delivery completed",
  rating_reminder: "Buyer reminded to rate",
};
// Shown to the buyer, seller and provider (the rest is for Frontier).
const SHARED_EVENTS = new Set(["created", "payment_confirmed", "accepted", "assigned", "vehicle_selected", "seller_ready", "seller_collection", "provider_collection",
  "heading_to_pickup", "near_pickup", "near_destination", "auto_completed",
  "collection_confirmed", "in_transit", "arrived", "delivery_submitted", "completed", "disputed", "dispute_resolved", "released", "cancelled", "refund_pending", "refunded"]);

// Directions from where the provider is now (or their address) to the pickup,
// while they're on their way to collect. Worked out again only when they've
// moved more than about half a kilometre.
const APPROACH = ["provider_accepted", "vehicle_selected", "awaiting_collection", "collection_submitted"];
const approachCache = new Map(); // bookingId -> { from, value }
async function approachRoute(b) {
  if (!APPROACH.includes(b.status) || !b.provider_id) return null;
  let from = null;
  let live = false;
  if (b.last_lat !== null && b.last_location_at && Date.now() - new Date(b.last_location_at).getTime() < 30 * 60000) {
    from = { lat: Number(b.last_lat), lng: Number(b.last_lng) };
    live = true;
  } else {
    const [[p]] = await pool.query("SELECT base_lat, base_lng FROM transport_providers WHERE id = ?", [b.provider_id]);
    if (p && p.base_lat !== null) from = { lat: Number(p.base_lat), lng: Number(p.base_lng) };
  }
  if (!from) return null;
  const hit = approachCache.get(b.id);
  const moved = hit ? Math.hypot((hit.from.lat - from.lat) * 111000, (hit.from.lng - from.lng) * 107000) : Infinity;
  if (hit && moved < 500) return { ...hit.value, live };
  try {
    const r = await routing.route(from, { lat: Number(b.pickup_lat), lng: Number(b.pickup_lng) });
    const value = { geometry: r.geometry, km: r.km, minutes: r.minutes };
    approachCache.set(b.id, { from, value });
    return { ...value, live };
  } catch {
    return null;
  }
}

function parseRoute(text) {
  if (!text) return null;
  try {
    const r = JSON.parse(text);
    return Array.isArray(r) ? r : null;
  } catch {
    return null;
  }
}

async function providerSummary(providerId, conn = pool) {
  if (!providerId) return null;
  const [[p]] = await conn.query(
    `SELECT p.id, p.name, p.kind, p.contact_person, p.phone, p.email, p.province, p.district,
       (SELECT ROUND(AVG(r.stars), 1) FROM transport_ratings r WHERE r.provider_id = p.id AND r.hidden = 0) AS rating,
       (SELECT COUNT(*) FROM transport_ratings r WHERE r.provider_id = p.id AND r.hidden = 0) AS ratings,
       (SELECT COUNT(*) FROM transport_bookings b WHERE b.provider_id = p.id AND b.status = 'completed') AS completed
     FROM transport_providers p WHERE p.id = ?`,
    [providerId],
  );
  if (!p) return null;
  return { ...p, rating: p.rating === null ? null : Number(p.rating), ratings: Number(p.ratings), completed: Number(p.completed) };
}

async function photosOf(conn, bookingId) {
  const [rows] = await conn.query("SELECT id, stage, party, image_path, thumb_path, lat, lng, created_at FROM transport_photos WHERE booking_id = ? ORDER BY id", [bookingId]);
  return rows;
}

async function quantitiesRows(conn, bookingId) {
  const [rows] = await conn.query("SELECT order_id, stage, quantity, id_details, created_at FROM transport_quantities WHERE booking_id = ?", [bookingId]);
  return rows;
}

// Everything about one booking, for `role`. opts.offer: the provider hasn't
// been assigned (only the request is shown).
async function detail(b, role, { offer = null, conn = pool } = {}) {
  const isAdmin = role === "admin";
  const assignedProvider = role === "provider" && !offer;
  const full = isAdmin || assignedProvider;
  const orders = await core.bookingOrders(conn, b.id);
  const base = {
    id: b.id,
    reference: bookingRef(b.id),
    checkout_id: role === "customer" || isAdmin ? b.checkout_id : undefined,
    checkout_reference: role === "customer" || isAdmin ? checkoutRef(b.checkout_id) : undefined,
    status: b.status,
    status_label: STATUS_LABELS[b.status] || b.status,
    group: groupOf(b.status),
    distance_km: num(b.distance_km),
    duration_min: b.duration_min,
    cargo_summary: b.cargo_summary,
    vehicle_size: b.vehicle_size || null,
    vehicle_size_label: core.sizeLabel(b.vehicle_size),
    band: b.band_max_km === null ? `Above ${Number(b.band_min_km)} km` : `${Number(b.band_min_km)} – ${Number(b.band_max_km)} km`,
    fee: role === "provider" ? undefined : num(b.fee),
    provider_earning: role === "provider" || isAdmin ? num(b.provider_earning) : undefined,
    // Both physical addresses are shown to everyone involved; phone numbers,
    // the receiver and exact map points only to those who need them.
    pickup: {
      label: role === "customer" ? b.pickup_label.replace(/\s*\(.*\)$/, "") : b.pickup_label,
      address: b.pickup_address,
      district: b.pickup_district,
      province: b.pickup_province,
      place: core.pickupPlace(b),
      ...(full || role === "seller" ? { lat: num(b.pickup_lat), lng: num(b.pickup_lng) } : {}),
      ...(full ? { phone: b.pickup_phone } : {}),
    },
    destination: {
      address: b.dest_address,
      district: b.dest_district,
      province: b.dest_province,
      place: core.destPlace(b),
      ...(full || role === "customer" ? { notes: b.dest_notes, lat: num(b.dest_lat), lng: num(b.dest_lng), contact_name: b.contact_name, contact_phone: b.contact_phone } : {}),
    },
    times: {
      created_at: b.created_at, paid_at: b.paid_at, accepted_at: b.accepted_at, seller_ready_at: b.seller_ready_at,
      collection_confirmed_at: b.collection_confirmed_at, started_at: b.started_at, arrived_at: b.arrived_at,
      delivery_submitted_at: b.delivery_submitted_at, completed_at: b.completed_at, disputed_at: b.disputed_at,
      cancelled_at: b.cancelled_at, refunded_at: b.refunded_at,
    },
    orders: orders.map((o) => ({
      id: o.id,
      reference: orderRef(o.id),
      title: o.livestock_title,
      quantity: Number(o.quantity),
      units: headCount(o.quantity, o.animal_name, o.animal_kind),
      animal: o.animal_name,
      kind: o.animal_kind,
      thumb_path: o.thumb_path,
      cancelled: o.status === "cancelled",
      ...(role !== "provider" ? { total: Number(o.total) } : {}),
    })),
  };
  if (offer) {
    // A request the provider hasn't accepted: no addresses, contacts or exact points.
    return {
      ...base,
      offer: { status: offer.status, offered_at: offer.offered_at, pickup_km: num(offer.pickup_km), dest_km: num(offer.dest_km) },
      pickup: { address: b.pickup_address, district: b.pickup_district, province: b.pickup_province, place: core.pickupPlace(b) },
      destination: { address: b.dest_address, district: b.dest_district, province: b.dest_province, place: core.destPlace(b) },
    };
  }
  const [subs, photos, qty] = await Promise.all([
    conn.query("SELECT * FROM transport_submissions WHERE booking_id = ? ORDER BY id", [b.id]).then(([r]) => r),
    photosOf(conn, b.id),
    quantitiesRows(conn, b.id),
  ]);
  const [events] = await conn.query("SELECT * FROM transport_events WHERE booking_id = ? ORDER BY id", [b.id]);
  const [disputes] = await conn.query("SELECT * FROM transport_disputes WHERE booking_id = ? ORDER BY id", [b.id]);
  const [[rating]] = await conn.query("SELECT stars, feedback, hidden, created_at FROM transport_ratings WHERE booking_id = ?", [b.id]);
  const showPoint = isAdmin;
  const out = {
    ...base,
    provider: role === "provider" ? null : await providerSummary(b.provider_id, conn),
    vehicle: b.vehicle_registration ? { id: b.vehicle_id, registration: b.vehicle_registration, type: b.vehicle_type, size: core.sizeLabel(b.vehicle_size) } : null,
    on_hold: Boolean(b.on_hold),
    submissions: subs.map((s) => ({
      stage: s.stage, party: s.party, actor_name: s.actor_name, note: s.note, discrepancy: Boolean(s.discrepancy), created_at: s.created_at,
      ...(showPoint ? { lat: num(s.lat), lng: num(s.lng) } : {}),
    })),
    photos: photos.map((p) => ({ id: p.id, stage: p.stage, party: p.party, image_path: p.image_path, thumb_path: p.thumb_path, created_at: p.created_at, ...(showPoint ? { lat: num(p.lat), lng: num(p.lng) } : {}) })),
    quantities: qty.map((q) => ({ order_id: q.order_id, stage: q.stage, quantity: q.quantity, id_details: q.id_details, created_at: q.created_at })),
    tracking: {
      last: b.last_lat !== null ? { lat: num(b.last_lat), lng: num(b.last_lng), at: b.last_location_at } : null,
      route: parseRoute(b.route_geometry),
      approach: await approachRoute(b),
      routing_provider: b.routing_provider,
    },
    // Delivered: when it completes by itself unless the buyer reports a problem.
    auto_complete_at: b.status === "awaiting_confirmation" && b.delivery_submitted_at
      ? new Date(new Date(b.delivery_submitted_at).getTime() + (await core.getSettings(conn)).auto_complete_hours * 3600000)
      : null,
    events: events.filter((e) => isAdmin || SHARED_EVENTS.has(e.event)).map((e) => ({
      at: e.created_at, event: e.event, label: EVENT_LABELS[e.event] || e.event, actor: e.actor,
      to_status: e.to_status,
      ...(isAdmin || ["disputed", "dispute_resolved", "cancelled", "released"].includes(e.event) ? { detail: e.detail } : {}),
      ...(isAdmin ? { actor_name: e.actor_name, from_status: e.from_status } : {}),
    })),
    disputes: role === "provider" || role === "seller"
      ? disputes.map((d) => ({ reason: d.reason, status: d.status, created_at: d.created_at, resolution: d.resolution }))
      : disputes.map((d) => ({ id: d.id, reason: d.reason, description: d.description, status: d.status, resolution: d.resolution, resolution_note: d.resolution_note, resolved_by: isAdmin ? d.resolved_by : undefined, resolved_at: d.resolved_at, created_at: d.created_at })),
    rating: rating && (role !== "provider" || !rating.hidden) ? { stars: rating.stars, feedback: rating.feedback, created_at: rating.created_at, ...(isAdmin ? { hidden: Boolean(rating.hidden) } : {}) } : null,
  };
  if (isAdmin) {
    const [offers] = await conn.query(
      "SELECT o.*, p.name FROM transport_offers o JOIN transport_providers p ON p.id = o.provider_id WHERE o.booking_id = ? ORDER BY o.offered_at, o.id",
      [b.id],
    );
    out.offers = offers.map((o) => ({ provider_id: o.provider_id, name: o.name, status: o.status, reason: o.reason, pickup_km: num(o.pickup_km), dest_km: num(o.dest_km), offered_at: o.offered_at, responded_at: o.responded_at }));
    out.money = {
      fee: num(b.fee), base_fee: num(b.base_fee), per_km: num(b.per_km), commission_pct: num(b.commission_pct),
      platform_commission: num(b.platform_commission), provider_earning: num(b.provider_earning),
      provider_paid_at: b.provider_paid_at, provider_paid_ref: b.provider_paid_ref, provider_paid_by: b.provider_paid_by,
      refund_ref: b.refund_ref, cancel_reason: b.cancel_reason,
    };
    const [[c]] = await conn.query("SELECT full_name, email, phone, buyer_id FROM checkouts WHERE id = ?", [b.checkout_id]);
    out.customer = c ? { name: c.full_name, email: c.email, phone: c.phone, buyer_id: c.buyer_id } : null;
    out.seller_id = b.seller_id;
    out.alerts = { unaccepted_alert_at: b.unaccepted_alert_at, delay_alert_at: b.delay_alert_at };
  }
  return out;
}

// GPS positions after `afterId` (oldest first), for the tracking map.
async function track(bookingId, afterId = 0, limit = 1000) {
  const [rows] = await pool.query(
    "SELECT id, lat, lng, accuracy_m, speed_mps, heading, recorded_at FROM transport_locations WHERE booking_id = ? AND id > ? ORDER BY id LIMIT ?",
    [bookingId, Number(afterId) || 0, Math.min(5000, Number(limit) || 1000)],
  );
  return rows.map((r) => ({ id: Number(r.id), lat: Number(r.lat), lng: Number(r.lng), accuracy: num(r.accuracy_m), speed: num(r.speed_mps), heading: num(r.heading), at: r.recorded_at }));
}

// A short row for lists.
function row(b, role) {
  return {
    id: b.id,
    reference: bookingRef(b.id),
    status: b.status,
    status_label: STATUS_LABELS[b.status] || b.status,
    group: groupOf(b.status),
    created_at: b.created_at,
    updated_at: b.updated_at,
    paid_at: b.paid_at,
    from: core.pickupPlace(b),
    pickup_label: role === "customer" ? undefined : b.pickup_label,
    to: core.destPlace(b),
    distance_km: num(b.distance_km),
    cargo_summary: b.cargo_summary,
    vehicle_size_label: core.sizeLabel(b.vehicle_size),
    fee: role === "provider" ? undefined : num(b.fee),
    provider_earning: role === "provider" || role === "admin" ? num(b.provider_earning) : undefined,
    vehicle_registration: b.vehicle_registration,
    provider_name: b.provider_name,
    seller_label: role === "admin" ? b.pickup_label : undefined,
    customer_name: role === "admin" ? b.customer_name : undefined,
    last_location_at: b.last_location_at,
    on_hold: Boolean(b.on_hold),
    started_at: b.started_at,
    completed_at: b.completed_at,
  };
}

function routingStatus() {
  return { enabled: routing.enabled(), provider: routing.provider(), problem: routing.problem() };
}

module.exports = { detail, track, row, groupOf, providerSummary, EVENT_LABELS, routingStatus, checkoutRef };
