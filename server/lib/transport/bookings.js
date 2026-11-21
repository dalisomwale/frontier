// Transport bookings: every step of a delivery, from checkout to completion.
//
//   checkout (Include Transport)  insertBookings()   one booking per pickup point
//   payment confirmed             onPaid()           sent to eligible providers
//   provider accepts + vehicle    accept()           (or Frontier assigns one)
//   seller ready / documents      sellerReady(), submitCollection("seller")
//   provider documents            submitCollection("provider")
//   seller confirms collection    confirmCollection()
//   provider starts               start()  ->  GPS: recordLocation()
//   provider arrives / documents  arrive(), submitDelivery()
//   buyer confirms or disputes    confirmDelivery(), dispute()
//   Frontier                      release(), cancel(), resolve(), markRefunded(), markProviderPaid()
//
// Each step runs in a transaction with the booking row locked, and the status
// only changes through core.transition(), which refuses skipped steps and
// changes someone else made meanwhile. Photos are added, never replaced: each
// party's record of each step is kept as it was submitted.
//
// When the buyer confirms, the booking's orders are recorded as delivered,
// received and handed over in one go, so the seller's payout continues
// exactly as for self-collected orders (Admin > Payouts).
const pool = require("../../db");
const core = require("./core");
const notify = require("./notify");
const matching = require("./matching");
const txlog = require("../txlog");
const { saveImage, deleteImageFiles, TRANSPORT_PHOTOS } = require("../../middleware/upload");
const { HttpError, badRequest, notFound } = require("../validate");
const { orderRef, kwacha, headCount } = require("../orders");

const { STATUS_LABELS, bookingRef, conflict } = core;
const ACCEPTABLE = ["payment_confirmed", "awaiting_provider", "awaiting_reassignment"];
const COLLECTING = ["awaiting_collection", "collection_submitted"];
const TRACKING = ["in_transit", "arrived"];
const MIN_PHOTOS = 1;
const checkoutRef = (id) => `FMC-${1000 + Number(id)}`;

function invalid(errors, message = "Please correct the highlighted fields.") {
  const e = new HttpError(422, message);
  e.errors = errors;
  return e;
}

async function loadBooking(id, conn = pool) {
  const [[b]] = await conn.query("SELECT * FROM transport_bookings WHERE id = ?", [id]);
  return b || null;
}

const liveOrders = (orders) => orders.filter((o) => o.status !== "cancelled");

// ------------------------------------------------------------------ photos
async function savePhotos(files, { label = "photo" } = {}) {
  const list = files || [];
  if (list.length < MIN_PHOTOS) throw invalid({ images: `Please add at least one ${label}.` });
  if (list.length > TRANSPORT_PHOTOS) throw badRequest(`Please add no more than ${TRANSPORT_PHOTOS} photos.`);
  const saved = [];
  try {
    for (const f of list) saved.push(await saveImage(f.buffer));
  } catch (error) {
    deleteImageFiles(...saved.flatMap((p) => [p.image_path, p.thumb_path]));
    throw error;
  }
  return saved;
}
const dropPhotos = (saved) => deleteImageFiles(...(saved || []).flatMap((p) => [p.image_path, p.thumb_path]));

async function storePhotos(conn, bookingId, stage, party, saved, point) {
  for (const p of saved) {
    await conn.query(
      "INSERT INTO transport_photos (booking_id, stage, party, image_path, thumb_path, lat, lng) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [bookingId, stage, party, p.image_path, p.thumb_path, point ? point.lat : null, point ? point.lng : null],
    );
  }
}

async function insertSubmission(conn, bookingId, { stage, party, actorName, note, discrepancy, point }) {
  try {
    await conn.query(
      "INSERT INTO transport_submissions (booking_id, stage, party, actor_name, note, discrepancy, lat, lng) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [bookingId, stage, party, actorName ? String(actorName).slice(0, 150) : null, note || null, discrepancy ? 1 : 0, point ? point.lat : null, point ? point.lng : null],
    );
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") throw conflict("This step has already been recorded. Each party's record is kept as it was submitted.");
    throw error;
  }
}

async function submissionsOf(conn, bookingId) {
  const [rows] = await conn.query("SELECT * FROM transport_submissions WHERE booking_id = ?", [bookingId]);
  return new Map(rows.map((r) => [r.stage, r]));
}

async function quantitiesOf(conn, bookingId, stage) {
  const [rows] = await conn.query("SELECT order_id, quantity FROM transport_quantities WHERE booking_id = ? AND stage = ?", [bookingId, stage]);
  return new Map(rows.map((r) => [Number(r.order_id), Number(r.quantity)]));
}

// Per-order quantities from a form: qty_<orderId> (and id_<orderId> for
// livestock identification). Each must be a whole number from 0 to `max`.
function readQuantities(body, orders, maxOf, { withIds = false } = {}) {
  const errors = {};
  const out = [];
  for (const o of orders) {
    const raw = body[`qty_${o.id}`];
    const n = Number.parseInt(raw, 10);
    const max = maxOf(o);
    if (raw === undefined || raw === "" || !Number.isInteger(n) || String(n) !== String(raw).trim() || n < 0) {
      errors[`qty_${o.id}`] = "Please enter the number.";
    } else if (n > max) {
      errors[`qty_${o.id}`] = `No more than ${max}.`;
    }
    const ids = withIds ? String(body[`id_${o.id}`] || "").trim().slice(0, 500) : "";
    out.push({ order: o, quantity: n, ids: ids || null, expected: max });
  }
  return { errors, list: out };
}

function readPoint(body) {
  return core.point(body.lat, body.lng);
}

function cleanNote(value, max = 1000) {
  const s = String(value || "").trim();
  return s ? s.slice(0, max) : null;
}

// --------------------------------------------------------------- checkout
// Inside the checkout transaction: one booking per journey in the plan,
// linked to the orders it carries. `created`: [{ id, l: { seller_id } }].
async function insertBookings(conn, { checkoutId, buyerId, dest, plan, created }) {
  const ids = [];
  for (const g of plan.groups) {
    const orders = created.filter((o) => Number(o.l.seller_id || 0) === Number(g.seller_id || 0));
    if (!orders.length) continue;
    const [r] = await conn.query(
      `INSERT INTO transport_bookings
         (checkout_id, buyer_id, seller_id, pickup_label, pickup_address, pickup_district, pickup_province, pickup_phone, pickup_lat, pickup_lng,
          dest_province, dest_district, dest_address, dest_notes, dest_lat, dest_lng, contact_name, contact_phone,
          distance_km, duration_min, route_geometry, routing_provider, band_id, band_min_km, band_max_km, base_fee, per_km, fee,
          commission_pct, platform_commission, provider_earning, cargo_summary, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_payment')`,
      [checkoutId, buyerId || null, g.seller_id || null, String(g.pickup.label).slice(0, 150), g.pickup.address, g.pickup.district, g.pickup.province, g.pickup.phone,
        g.pickup.lat, g.pickup.lng, dest.province, dest.district, dest.address, dest.notes, dest.lat, dest.lng, dest.contact_name, dest.contact_phone,
        g.distance_km, g.duration_min, g.geometry && g.geometry.length ? JSON.stringify(g.geometry) : null, g.routing_provider,
        g.band.id, g.band.min_km, g.band.max_km, g.band.base_fee, g.band.per_km, g.fee,
        g.commission_pct || 0, g.commission || 0, g.earning, String(g.cargo_summary || "").slice(0, 500)],
    );
    const bookingId = r.insertId;
    ids.push(bookingId);
    const address = `${dest.address}, ${dest.district}, ${dest.province}`.slice(0, 300);
    for (const o of orders) {
      await conn.query("INSERT INTO transport_booking_orders (booking_id, order_id) VALUES (?, ?)", [bookingId, o.id]);
      await conn.query("UPDATE orders SET transport_booking_id = ?, delivery = 'deliver', delivery_address = ? WHERE id = ?", [bookingId, address, o.id]);
    }
    await core.logEvent(conn, bookingId, {
      to: "pending_payment", event: "created", actor: "customer",
      detail: `Transport booked at checkout ${checkoutRef(checkoutId)}: ${g.pickup.district || g.pickup.province || g.pickup.label} → ${dest.district}, ${dest.province}. ${g.distance_km} km by road (${g.routing_provider}), ${g.band.label} band, fee ${kwacha(g.fee)}.`,
    });
  }
  return ids;
}

// The checkout's payment is confirmed (by Lipila / Lenco's status check, or
// by the team marking every order Paid). Bookings waiting for payment become
// Payment confirmed and are sent to eligible providers. Runs once per booking:
// the status change only happens from "Awaiting payment".
// shortOrderIds: paid orders whose stock had gone (held for the team).
async function onPaid(checkoutId, { shortOrderIds = [], actor = "system", actorName = null } = {}) {
  const [rows] = await pool.query("SELECT id FROM transport_bookings WHERE checkout_id = ? AND status = 'pending_payment'", [checkoutId]);
  const short = new Set(shortOrderIds.map(Number));
  const released = [];
  for (const { id } of rows) {
    let outcome = null;
    await core.withBooking(id, async (conn, b) => {
      if (b.status !== "pending_payment") return;
      const orders = liveOrders(await core.bookingOrders(conn, b.id));
      if (!orders.length) {
        await core.transition(conn, b, "cancelled", { event: "cancelled", actor, actorName, detail: "Every order in this delivery was cancelled before payment.", set: { cancelled_at: { raw: "NOW()" }, cancel_reason: "Orders cancelled" } });
        outcome = "cancelled";
        return;
      }
      const hold = orders.some((o) => short.has(Number(o.id)));
      await core.transition(conn, b, "payment_confirmed", {
        event: "payment_confirmed", actor, actorName,
        detail: `Payment confirmed for ${checkoutRef(b.checkout_id)}, including the transport fee of ${kwacha(b.fee)}.${hold ? " Held back from providers: an item sold out before the payment came through." : ""}`,
        set: { paid_at: { raw: "NOW()" }, on_hold: hold ? 1 : 0 },
      });
      outcome = hold ? "held" : "paid";
    });
    if (!outcome || outcome === "cancelled") continue;
    const b = await loadBooking(id);
    released.push(b);
    notify.customer(b, {
      title: `Payment received: finding a transport provider (${bookingRef(b.id)})`,
      body: `Your delivery from ${b.pickup_district || b.pickup_province || "the seller"} to ${b.dest_district} is paid. We'll tell you as soon as a transport provider accepts it.`,
    });
    notify.seller(b, {
      title: `Paid order for transport collection (${bookingRef(b.id)})`,
      body: `A transport provider will collect this order from your pickup point. We'll tell you who and with which vehicle once it's accepted.`,
      subject: `Paid order to be collected by transport: ${bookingRef(b.id)}`,
      heading: "A paid order will be collected by a transport provider",
      paragraphs: [
        "The buyer chose delivery. A transport provider approved by Frontier will collect the goods from your pickup point.",
        "We'll tell you who is coming and with which vehicle as soon as a provider accepts. Please have the goods ready, and record the handover with photos in your seller account when they arrive.",
      ],
      rows: [["Load", b.cargo_summary || "-"], ["Destination", `${b.dest_district}, ${b.dest_province}`]],
    });
    if (outcome === "held") {
      notify.team(b, {
        subject: `Delivery ${bookingRef(b.id)} held: an item sold out`,
        heading: "A paid delivery is held back from providers",
        paragraphs: ["One of the items in this delivery sold out before the payment came through. Sort out the order with the buyer, then send the delivery to providers (or cancel it) from the delivery page."],
      });
    }
    notify.live(b, "paid");
    if (outcome === "paid") matching.offer(b.id).catch((error) => console.error(`Transport ${bookingRef(b.id)}: offer failed (${error.message})`));
  }
  return released;
}

// An order was cancelled (Admin > Orders). A delivery that no longer carries
// anything is cancelled (before payment) or goes to refund (after payment),
// as long as the goods haven't been collected.
async function orderCancelled(orderId, { actorName = null } = {}) {
  const [[link]] = await pool.query("SELECT booking_id FROM transport_booking_orders WHERE order_id = ?", [orderId]);
  if (!link) return null;
  let changed = null;
  await core.withBooking(link.booking_id, async (conn, b) => {
    const orders = liveOrders(await core.bookingOrders(conn, b.id));
    if (orders.length) {
      await core.logEvent(conn, b.id, { event: "order_cancelled", actor: "admin", actorName, detail: `${orderRef(orderId)} was cancelled. The delivery still carries ${orders.map((o) => orderRef(o.id)).join(", ")}.` });
      return;
    }
    if (b.status === "pending_payment") {
      await core.transition(conn, b, "cancelled", { event: "cancelled", actor: "admin", actorName, detail: "Every order in this delivery was cancelled.", set: { cancelled_at: { raw: "NOW()" }, cancel_reason: "Orders cancelled" } });
      changed = "cancelled";
    } else if ((core.TRANSITIONS[b.status] || []).includes("refund_pending")) {
      await core.transition(conn, b, "refund_pending", { event: "refund_pending", actor: "admin", actorName, detail: `Every order in this delivery was cancelled. The transport fee of ${kwacha(b.fee)} is to be refunded.`, set: { cancelled_at: { raw: "NOW()" }, cancel_reason: "Orders cancelled" } });
      await conn.query("UPDATE transport_offers SET status = 'withdrawn', responded_at = NOW() WHERE booking_id = ? AND status = 'offered'", [b.id]);
      changed = "refund_pending";
    } else {
      await core.logEvent(conn, b.id, { event: "order_cancelled", actor: "admin", actorName, detail: `${orderRef(orderId)} was cancelled after collection. The delivery needs Frontier's attention.` });
    }
  });
  const b = await loadBooking(link.booking_id);
  if (changed) {
    notify.live(b, changed);
    if (b.provider_id && changed === "refund_pending") {
      notify.provider(b.provider_id, b, { title: `Delivery ${bookingRef(b.id)} was cancelled`, body: "The order was cancelled by Frontier. Please don't collect it.", subject: `Delivery ${bookingRef(b.id)} cancelled`, paragraphs: ["Frontier cancelled the order this delivery was for. Please don't go to collect it."] });
    }
  }
  return b;
}

// --------------------------------------------------- accepting / assigning
// A provider accepts a request with one of their vehicles, or Frontier
// assigns one (admin). Checked again here, at the moment of accepting: the
// provider must still be eligible and the vehicle free and suitable. Only one
// provider can get a booking: the row is locked and the status must still be
// open; the vehicle row is locked so it can't be put on two deliveries.
async function accept(providerId, bookingId, vehicleId, { admin = null, force = false } = {}) {
  const b0 = await loadBooking(bookingId);
  if (!b0) throw notFound("Delivery not found.");
  let offer0 = null;
  if (!admin) {
    [[offer0]] = await pool.query("SELECT status, pickup_km, dest_km FROM transport_offers WHERE booking_id = ? AND provider_id = ?", [bookingId, providerId]);
    if (!offer0) throw notFound("Delivery not found.");
    if (offer0.status !== "offered" || !ACCEPTABLE.includes(b0.status)) throw conflict("This request is no longer available: another provider has accepted it, or it was withdrawn.");
  } else if (!ACCEPTABLE.includes(b0.status)) {
    throw conflict(`A provider can't be assigned while the delivery is "${STATUS_LABELS[b0.status]}".`);
  }
  // Eligibility needs road distances: worked out before locking anything.
  const { job } = await matching.jobOf(pool, b0);
  const [check] = await matching.assess(pool, job, { providerIds: [Number(providerId)], excludeBooking: b0.id });
  if (!check) throw notFound("Transport provider not found.");
  // The routing service didn't answer just now: the road distances measured
  // when the request was sent to this provider still hold (their operating
  // location hasn't changed), so coverage is checked against those.
  const routeDown = check.reasons.filter((r) => r.startsWith("Road distance unavailable"));
  if (routeDown.length && offer0 && offer0.pickup_km !== null && offer0.dest_km !== null) {
    const cover = Number(check.provider.coverage_km);
    check.reasons = check.reasons.filter((r) => !r.startsWith("Road distance unavailable"));
    if (Number(offer0.pickup_km) > cover) check.reasons.push(`Pickup is ${Number(offer0.pickup_km)} km away; coverage is ${cover} km`);
    if (Number(offer0.dest_km) > cover) check.reasons.push(`Destination is ${Number(offer0.dest_km)} km away; coverage is ${cover} km`);
    check.eligible = !check.reasons.length;
  }
  const p = check.provider;
  const vehicle = p.vehicles.find((v) => Number(v.id) === Number(vehicleId));
  if (!vehicle) throw invalid({ vehicle_id: "Please choose one of the registered vehicles." });
  if (p.status !== "approved" || !p.is_active) throw conflict(`${p.name} isn't an approved, active provider.`);
  if (vehicle.status !== "active") throw invalid({ vehicle_id: "This vehicle is deactivated." });
  if (vehicle.busy) throw invalid({ vehicle_id: "This vehicle is on another delivery." });
  const fits = core.vehicleFits(vehicle.cargo, job.load);
  if (!force || !admin) {
    if (!check.eligible) {
      const msg = check.reasons.join("; ");
      throw conflict(admin ? `${p.name} can't take this delivery: ${msg}.` : `You can't accept this delivery right now: ${msg}.`);
    }
    if (!fits) throw invalid({ vehicle_id: "This vehicle can't carry this load. Choose another vehicle." });
  }
  const actor = admin ? "admin" : "provider";
  const actorName = admin ? admin.name : p.name;
  let withdrawn = [];
  await core.withBooking(bookingId, async (conn, b) => {
    if (!ACCEPTABLE.includes(b.status)) throw conflict("Another provider has just accepted this delivery.");
    if (!admin) {
      const [[offer]] = await conn.query("SELECT status FROM transport_offers WHERE booking_id = ? AND provider_id = ? FOR UPDATE", [b.id, providerId]);
      if (!offer || offer.status !== "offered") throw conflict("This request is no longer available.");
    }
    const [[pr]] = await conn.query("SELECT status, is_active FROM transport_providers WHERE id = ? FOR UPDATE", [providerId]);
    if (!pr || pr.status !== "approved" || !pr.is_active) throw conflict("This provider isn't approved and active.");
    const [[v]] = await conn.query("SELECT * FROM transport_vehicles WHERE id = ? AND provider_id = ? FOR UPDATE", [vehicleId, providerId]);
    if (!v || v.status !== "active") throw invalid({ vehicle_id: "This vehicle isn't available." });
    const [busy] = await conn.query("SELECT id FROM transport_bookings WHERE vehicle_id = ? AND id <> ? AND status IN (?) LIMIT 1", [v.id, b.id, core.VEHICLE_BUSY]);
    if (busy.length) throw invalid({ vehicle_id: "This vehicle has just been put on another delivery." });
    const [others] = await conn.query("SELECT provider_id FROM transport_offers WHERE booking_id = ? AND provider_id <> ? AND status = 'offered'", [b.id, providerId]);
    withdrawn = others.map((o) => o.provider_id);
    await core.transition(conn, b, "provider_accepted", {
      event: admin ? "assigned" : "accepted", actor, actorName,
      detail: admin ? `Frontier (${admin.name}) assigned ${p.name}${force && (!check.eligible || !fits) ? ` although: ${[...check.reasons, ...(fits ? [] : ["the vehicle's listed capacity doesn't cover the load"])].join("; ")}` : ""}.` : `${p.name} accepted the delivery.`,
      set: { provider_id: providerId, accepted_at: { raw: "NOW()" } },
    });
    await core.transition(conn, b, "vehicle_selected", {
      event: "vehicle_selected", actor, actorName,
      detail: `Vehicle ${v.registration} (${v.vehicle_type}) selected.`,
      set: { vehicle_id: v.id, vehicle_registration: v.registration, vehicle_type: v.vehicle_type },
    });
    await core.transition(conn, b, "awaiting_collection", { event: "awaiting_collection", actor: "system", detail: "Waiting for the goods to be collected from the seller." });
    await conn.query(
      `INSERT INTO transport_offers (booking_id, provider_id, status, responded_at) VALUES (?, ?, 'accepted', NOW())
       ON DUPLICATE KEY UPDATE status = 'accepted', responded_at = NOW()`,
      [b.id, providerId],
    );
    await conn.query("UPDATE transport_offers SET status = 'withdrawn', responded_at = NOW() WHERE booking_id = ? AND provider_id <> ? AND status = 'offered'", [b.id, providerId]);
  });
  const b = await loadBooking(bookingId);
  const vehicleText = `${b.vehicle_registration} (${b.vehicle_type})`;
  notify.customer(b, {
    title: `Transport provider assigned: ${p.name}`,
    body: `${p.name} will collect your order and deliver it with ${vehicleText}.`,
    subject: `Your delivery ${bookingRef(b.id)}: transport provider assigned`,
    heading: "A transport provider has been assigned",
    paragraphs: [`${p.name} has accepted your delivery and will collect it from the seller. You can follow the delivery in your account once it's on the way.`],
    rows: [["Provider", p.name], ["Phone", p.phone], ["Vehicle", vehicleText], ["Destination", `${b.dest_district}, ${b.dest_province}`]],
  });
  notify.seller(b, {
    title: `${p.name} will collect ${bookingRef(b.id)}`,
    body: `Vehicle ${vehicleText}. Phone ${p.phone}. Please have the goods ready and record the handover with photos.`,
    subject: `Collection by ${p.name}: ${bookingRef(b.id)}`,
    heading: "A transport provider will collect your order",
    paragraphs: [
      `${p.name} has accepted the delivery and will come to your pickup point with the vehicle below. Please agree a time with them.`,
      "When they arrive, check the goods together and record the handover in your seller account: photos and the quantities you release. The provider records their own photos too.",
    ],
    rows: [["Provider", p.name], ["Phone", p.phone], ["Vehicle", vehicleText], ["Load", b.cargo_summary || "-"]],
  });
  notify.provider(p.id, b, {
    title: admin ? `Frontier assigned you ${bookingRef(b.id)}` : `You accepted ${bookingRef(b.id)}`,
    body: `Collect from ${b.pickup_label}, ${b.pickup_district || b.pickup_province || ""}. Vehicle ${vehicleText}.`,
    subject: `${admin ? "Assigned to you" : "Accepted"}: delivery ${bookingRef(b.id)}`,
    heading: admin ? "Frontier assigned you a delivery" : "You accepted a delivery",
    paragraphs: ["The pickup and delivery details are in your dashboard. At the pickup point, check the goods and record the collection with photos and the quantities you collect before you start the delivery."],
    rows: [["Pickup", [b.pickup_label, b.pickup_address, b.pickup_district, b.pickup_province].filter(Boolean).join(", ")], ["Seller phone", b.pickup_phone || "-"], ["Destination", `${b.dest_address}, ${b.dest_district}, ${b.dest_province}`], ["Receiver", `${b.contact_name} (${b.contact_phone})`], ["Vehicle", vehicleText], ["Your earning", kwacha(b.provider_earning)]],
  });
  for (const id of withdrawn) {
    notify.provider(id, b, { title: `Request ${bookingRef(b.id)} has been taken`, body: "Another provider accepted this delivery." });
  }
  notify.team(b, {
    subject: `${admin ? "Assigned" : "Accepted"}: delivery ${bookingRef(b.id)} by ${p.name}`,
    heading: `${p.name} ${admin ? "was assigned" : "accepted"} a delivery`,
    paragraphs: [`Vehicle ${vehicleText}. Waiting for collection at ${b.pickup_label}.`],
  });
  notify.live(b, "accepted");
  return b;
}

async function decline(providerId, bookingId, reason) {
  const clean = cleanNote(reason, 255);
  const [r] = await pool.query(
    "UPDATE transport_offers SET status = 'declined', reason = ?, responded_at = NOW() WHERE booking_id = ? AND provider_id = ? AND status = 'offered'",
    [clean, bookingId, providerId],
  );
  if (!r.affectedRows) throw conflict("This request is no longer open.");
  const [[p]] = await pool.query("SELECT name FROM transport_providers WHERE id = ?", [providerId]);
  let none = false;
  await core.withBooking(bookingId, async (conn, b) => {
    await core.logEvent(conn, b.id, { event: "declined", actor: "provider", actorName: p && p.name, detail: `${p ? p.name : "A provider"} declined${clean ? `: ${clean}` : "."}` });
    if (b.status !== "awaiting_provider") return;
    const [[open]] = await conn.query("SELECT COUNT(*) AS n FROM transport_offers WHERE booking_id = ? AND status = 'offered'", [b.id]);
    if (!Number(open.n)) {
      await core.transition(conn, b, "awaiting_reassignment", { event: "all_declined", detail: "Every provider the request was sent to has declined." });
      none = true;
    }
  });
  const b = await loadBooking(bookingId);
  if (none) {
    notify.team(b, {
      subject: `Every provider declined delivery ${bookingRef(b.id)}`,
      heading: "A paid delivery needs a transport provider",
      paragraphs: ["Every provider the request was sent to has declined it. Please assign a provider from the delivery page. The request has not been cancelled, and it will be sent automatically to any provider who becomes eligible."],
      rows: [["Pickup", b.pickup_label], ["Destination", `${b.dest_district}, ${b.dest_province}`], ["Distance", `${Number(b.distance_km)} km`]],
    });
  }
  notify.live(b, "declined");
  // Someone else may have become eligible meanwhile.
  if (!b.on_hold) matching.offer(b.id).catch(() => {});
  return b;
}

// Frontier takes the delivery back from the assigned provider (before they've
// recorded the collection) and offers it again.
async function release(admin, bookingId, reason) {
  const clean = cleanNote(reason, 500);
  if (!clean) throw invalid({ reason: "Please say why." });
  let old = null;
  await core.withBooking(bookingId, async (conn, b) => {
    if (!["provider_accepted", "awaiting_collection", "collection_submitted"].includes(b.status)) throw conflict(`The delivery can't be reassigned while it is "${STATUS_LABELS[b.status]}".`);
    const subs = await submissionsOf(conn, b.id);
    if (subs.has("provider_collection")) throw conflict("The provider has already recorded the collection, so the delivery can't be reassigned now.");
    old = b.provider_id;
    await core.transition(conn, b, "awaiting_reassignment", {
      event: "released", actor: "admin", actorName: admin.name, detail: `Frontier took the delivery back from the provider: ${clean}`,
      set: { provider_id: null, vehicle_id: null, vehicle_registration: null, vehicle_type: null, accepted_at: null, unaccepted_alert_at: null },
    });
    await conn.query("UPDATE transport_offers SET status = 'declined', reason = ?, responded_at = NOW() WHERE booking_id = ? AND provider_id = ?", [`Released by Frontier: ${clean}`.slice(0, 255), b.id, old]);
  });
  const b = await loadBooking(bookingId);
  if (old) notify.provider(old, b, { title: `Delivery ${bookingRef(b.id)} was reassigned`, body: `Frontier took this delivery back: ${clean}`, subject: `Delivery ${bookingRef(b.id)} reassigned`, paragraphs: [`Frontier has taken this delivery back from you: ${clean}. Please don't collect it.`] });
  notify.seller(b, { title: `Transport for ${bookingRef(b.id)} is being reassigned`, body: "The provider who accepted will no longer collect it. We'll tell you who will." });
  notify.customer(b, { title: `We're finding another transport provider (${bookingRef(b.id)})`, body: "The provider who accepted your delivery can no longer do it. We'll tell you who will." });
  notify.live(b, "released");
  if (!b.on_hold) matching.offer(b.id, { actor: "admin", actorName: admin.name }).catch(() => {});
  return b;
}

// Frontier sends a held or unassigned delivery to providers (again).
async function sendToProviders(admin, bookingId) {
  const b0 = await loadBooking(bookingId);
  if (!b0) throw notFound("Delivery not found.");
  if (!ACCEPTABLE.includes(b0.status)) throw conflict(`The delivery is "${STATUS_LABELS[b0.status]}", so it can't be sent to providers.`);
  if (b0.on_hold) {
    await core.withBooking(bookingId, async (conn, b) => {
      await conn.query("UPDATE transport_bookings SET on_hold = 0 WHERE id = ?", [b.id]);
      await core.logEvent(conn, b.id, { event: "unheld", actor: "admin", actorName: admin.name, detail: "Frontier released the hold: the delivery can go to providers." });
    });
  }
  const result = await matching.offer(bookingId, { actor: "admin", actorName: admin.name });
  return { ...result, booking: await loadBooking(bookingId) };
}

// ------------------------------------------------------------- collection
// Who is acting: { party: 'seller' | 'provider' | 'admin', id, name }.
function mustOwn(b, who) {
  if (who.party === "provider" && Number(b.provider_id) !== Number(who.id)) throw notFound("Delivery not found.");
  if (who.party === "seller" && (!b.seller_id || Number(b.seller_id) !== Number(who.id))) throw notFound("Delivery not found.");
  if (who.party === "customer" && (!b.buyer_id || Number(b.buyer_id) !== Number(who.id))) throw notFound("Delivery not found.");
}

async function sellerReady(who, bookingId) {
  await core.withBooking(bookingId, async (conn, b) => {
    mustOwn(b, who);
    if (!COLLECTING.includes(b.status)) throw conflict("The goods can be marked ready once a provider has been assigned and before they're collected.");
    if (b.seller_ready_at) throw conflict("You've already marked the goods as ready.");
    await conn.query("UPDATE transport_bookings SET seller_ready_at = NOW() WHERE id = ?", [b.id]);
    await core.logEvent(conn, b.id, { event: "seller_ready", actor: who.party === "admin" ? "admin" : "seller", actorName: who.name, detail: `${who.party === "admin" ? `Frontier (${who.name})` : who.name} marked the goods as ready for collection.` });
  });
  const b = await loadBooking(bookingId);
  if (b.provider_id) notify.provider(b.provider_id, b, { title: `Goods ready for collection: ${bookingRef(b.id)}`, body: `${b.pickup_label} says the goods are ready.`, subject: `Ready for collection: ${bookingRef(b.id)}`, paragraphs: [`${b.pickup_label} has marked the goods as ready for collection.`], rows: [["Pickup", [b.pickup_address, b.pickup_district, b.pickup_province].filter(Boolean).join(", ")], ["Seller phone", b.pickup_phone || "-"]] });
  notify.live(b, "ready");
  return b;
}

// The seller (or Frontier, for its own stock) and the provider each record
// the handover on their own: photos, the quantity of each order released /
// collected, livestock identification (provider), and any discrepancy.
async function submitCollection(who, bookingId, files, body = {}) {
  const b0 = await loadBooking(bookingId);
  if (!b0) throw notFound("Delivery not found.");
  mustOwn(b0, who);
  if (!COLLECTING.includes(b0.status)) throw conflict(`Collection can be recorded once a provider is assigned and before the delivery starts (now: "${STATUS_LABELS[b0.status]}").`);
  const isProvider = who.party === "provider";
  const stage = isProvider ? "provider_collection" : "seller_collection";
  const orders = liveOrders(await core.bookingOrders(pool, b0.id));
  const { errors, list } = readQuantities(body, orders, (o) => Number(o.quantity), { withIds: isProvider });
  const note = cleanNote(body.note);
  const flagged = ["1", "true", "on"].includes(String(body.discrepancy));
  const differs = list.some((x) => Number.isInteger(x.quantity) && x.quantity !== x.expected);
  if ((flagged || differs) && !note) errors.note = "Please describe the difference from the order.";
  if (!(files || []).length) errors.images = "Please add at least one photo of the goods.";
  if (Object.keys(errors).length) throw invalid(errors);
  const point = readPoint(body);
  const saved = await savePhotos(files, { label: "photo of the goods" });
  const party = who.party === "admin" ? "admin" : who.party;
  try {
    await core.withBooking(bookingId, async (conn, b) => {
      mustOwn(b, who);
      if (!COLLECTING.includes(b.status)) throw conflict("The collection can no longer be recorded.");
      await insertSubmission(conn, b.id, { stage, party, actorName: who.name, note, discrepancy: flagged || differs, point });
      await storePhotos(conn, b.id, stage, party, saved, point);
      for (const x of list) {
        await conn.query(
          "INSERT INTO transport_quantities (booking_id, order_id, stage, quantity, id_details) VALUES (?, ?, ?, ?, ?)",
          [b.id, x.order.id, isProvider ? "provider_collected" : "seller_release", x.quantity, x.ids],
        );
      }
      const summary = list.map((x) => `${orderRef(x.order.id)}: ${x.quantity} of ${x.expected}`).join("; ");
      const detail = `${isProvider ? `${who.name} recorded the collection` : `${who.party === "admin" ? `Frontier (${who.name})` : who.name} recorded the handover`} with ${saved.length} photo${saved.length === 1 ? "" : "s"}. ${summary}.${flagged || differs ? ` Discrepancy: ${note}` : ""}`;
      if (b.status === "awaiting_collection") {
        await core.transition(conn, b, "collection_submitted", { event: stage, actor: isProvider ? "provider" : who.party === "admin" ? "admin" : "seller", actorName: who.name, detail });
      } else {
        await core.logEvent(conn, b.id, { event: stage, actor: isProvider ? "provider" : who.party === "admin" ? "admin" : "seller", actorName: who.name, detail });
      }
    });
  } catch (error) {
    dropPhotos(saved);
    throw error;
  }
  const b = await loadBooking(bookingId);
  const subs = await submissionsOf(pool, b.id);
  const both = subs.has("seller_collection") && subs.has("provider_collection");
  if (isProvider) {
    notify.seller(b, {
      title: `${who.name} recorded the collection of ${bookingRef(b.id)}`,
      body: both ? "Both records are in. Please check them and confirm the collection so the delivery can start." : "Please record your handover too: photos and the quantities you released.",
    });
  } else if (b.provider_id) {
    notify.provider(b.provider_id, b, {
      title: `Seller recorded the handover of ${bookingRef(b.id)}`,
      body: both ? "Waiting for the seller to confirm the collection." : "Please record the collection too: your photos and the quantities you collected.",
    });
  }
  if (flagged || differs) {
    notify.team(b, {
      subject: `Collection discrepancy on delivery ${bookingRef(b.id)}`,
      heading: "A difference was reported at collection",
      paragraphs: [`${isProvider ? `The provider (${who.name})` : `The seller (${who.name})`} reported a difference from the order: ${note}`],
      rows: list.map((x) => [`${orderRef(x.order.id)} ${x.order.livestock_title}`, `${x.quantity} of ${x.expected}`]),
    });
  }
  notify.live(b, stage);
  return b;
}

// The seller confirms the collection once both records are in.
async function confirmCollection(who, bookingId) {
  await core.withBooking(bookingId, async (conn, b) => {
    mustOwn(b, who);
    if (b.status !== "collection_submitted") throw conflict(b.status === "awaiting_collection" ? "Both you and the provider need to record the collection first." : `The collection can't be confirmed now ("${STATUS_LABELS[b.status]}").`);
    const subs = await submissionsOf(conn, b.id);
    if (!subs.has("seller_collection")) throw conflict("Please record your handover (photos and quantities) first.");
    if (!subs.has("provider_collection")) throw conflict("The provider hasn't recorded the collection yet.");
    const collected = await quantitiesOf(conn, b.id, "provider_collected");
    const total = [...collected.values()].reduce((s, n) => s + n, 0);
    if (!total) throw conflict("The provider recorded nothing collected. Please contact Frontier.");
    await core.transition(conn, b, "collection_confirmed", {
      event: "collection_confirmed", actor: who.party === "admin" ? "admin" : "seller", actorName: who.name,
      detail: `${who.party === "admin" ? `Frontier (${who.name})` : who.name} confirmed the collection. The provider can start the delivery.`,
      set: { collection_confirmed_at: { raw: "NOW()" } },
    });
  });
  const b = await loadBooking(bookingId);
  notify.provider(b.provider_id, b, { title: `Collection confirmed: you can start ${bookingRef(b.id)}`, body: "Press Start delivery when you leave, and keep the dashboard open so your location is shared." });
  notify.customer(b, { title: `Your order has been collected (${bookingRef(b.id)})`, body: `${b.vehicle_registration ? `Vehicle ${b.vehicle_registration}` : "The provider"} has collected your order. You can follow it once the delivery starts.`, subject: `Your order has been collected: ${bookingRef(b.id)}`, heading: "Your order has been collected", paragraphs: ["The transport provider has collected your order from the seller. You'll be told when the delivery starts, and you can follow it in your account."] });
  notify.live(b, "collection_confirmed");
  return b;
}

// -------------------------------------------------------------- delivery
async function start(who, bookingId, body = {}) {
  const point = readPoint(body);
  await core.withBooking(bookingId, async (conn, b) => {
    mustOwn(b, who);
    if (b.status !== "collection_confirmed") throw conflict(b.status === "collection_submitted" ? "Wait for the seller to confirm the collection." : `The delivery can't start now ("${STATUS_LABELS[b.status]}").`);
    await core.transition(conn, b, "in_transit", { event: "in_transit", actor: "provider", actorName: who.name, detail: `${who.name} started the delivery.`, set: { started_at: { raw: "NOW()" }, delay_alert_at: null } });
    if (point) await recordPoint(conn, b, who.id, { ...point, accuracy: body.accuracy, speed: body.speed, heading: body.heading, recorded_at: body.recorded_at });
  });
  const b = await loadBooking(bookingId);
  notify.customer(b, { title: `Your delivery is on its way (${bookingRef(b.id)})`, body: "Follow it live in your order.", subject: `On its way: delivery ${bookingRef(b.id)}`, heading: "Your delivery is on its way", paragraphs: ["The transport provider has started the delivery. You can see where it is in your account; the position comes from the provider's phone."], rows: [["Vehicle", `${b.vehicle_registration} (${b.vehicle_type})`]] });
  notify.seller(b, { title: `Delivery ${bookingRef(b.id)} has started`, body: "You can follow it in your orders." });
  notify.live(b, "in_transit");
  return b;
}

// A GPS position from the provider's phone. Stored only while the delivery
// is on the road, for the assigned provider. Times come from the phone,
// within reason (not in the future, not more than an hour old).
function cleanFix(body) {
  const p = core.point(body.lat, body.lng);
  if (!p) return null;
  const num = (v, lo, hi) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Math.min(hi, Math.max(lo, Number(v))));
  let at = body.recorded_at ? new Date(Number(body.recorded_at) || body.recorded_at) : new Date();
  if (Number.isNaN(at.getTime()) || at.getTime() > Date.now() + 2 * 60 * 1000 || at.getTime() < Date.now() - 60 * 60 * 1000) at = new Date();
  return { ...p, accuracy: num(body.accuracy, 0, 99999), speed: num(body.speed, 0, 200), heading: num(body.heading, 0, 360), recorded_at: at };
}

async function recordPoint(conn, b, providerId, raw) {
  const fix = raw.recorded_at instanceof Date ? raw : cleanFix(raw);
  if (!fix) return null;
  await conn.query(
    "INSERT INTO transport_locations (booking_id, provider_id, lat, lng, accuracy_m, speed_mps, heading, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [b.id, providerId, fix.lat, fix.lng, fix.accuracy, fix.speed, fix.heading, fix.recorded_at],
  );
  await conn.query("UPDATE transport_bookings SET last_lat = ?, last_lng = ?, last_location_at = ? WHERE id = ?", [fix.lat, fix.lng, fix.recorded_at, b.id]);
  return fix;
}

const lastSaved = new Map(); // bookingId -> ms, so a phone sending too often is thinned
async function recordLocation(who, bookingId, body = {}) {
  const fix = cleanFix(body);
  if (!fix) throw badRequest("The location sent is not valid.");
  const b = await loadBooking(bookingId);
  if (!b) throw notFound("Delivery not found.");
  mustOwn(b, who);
  if (!TRACKING.includes(b.status)) throw conflict("Your location is only shared while the delivery is on its way.");
  const last = lastSaved.get(b.id) || 0;
  if (Date.now() - last < 5000) return { saved: false };
  lastSaved.set(b.id, Date.now());
  const [r] = await pool.query(
    "UPDATE transport_bookings SET last_lat = ?, last_lng = ?, last_location_at = ?, delay_alert_at = IF(delay_alert_at IS NOT NULL AND ? > delay_alert_at, NULL, delay_alert_at) WHERE id = ? AND provider_id = ? AND status IN (?)",
    [fix.lat, fix.lng, fix.recorded_at, fix.recorded_at, b.id, who.id, TRACKING],
  );
  if (!r.affectedRows) throw conflict("Your location is only shared while the delivery is on its way.");
  await pool.query(
    "INSERT INTO transport_locations (booking_id, provider_id, lat, lng, accuracy_m, speed_mps, heading, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [b.id, who.id, fix.lat, fix.lng, fix.accuracy, fix.speed, fix.heading, fix.recorded_at],
  );
  const data = { booking_id: b.id, change: "location", lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy, at: fix.recorded_at.toISOString() };
  const notifications = require("../../services/notifications");
  if (b.buyer_id) notifications.pingBuyer(b.buyer_id, "transport", data);
  if (b.seller_id) notifications.pingSeller(b.seller_id, "transport", data);
  notifications.pingAdmins("transport-location", data);
  return { saved: true };
}

async function arrive(who, bookingId, body = {}) {
  await core.withBooking(bookingId, async (conn, b) => {
    mustOwn(b, who);
    if (b.status !== "in_transit") throw conflict(`You can mark arrival while the delivery is in transit (now: "${STATUS_LABELS[b.status]}").`);
    await core.transition(conn, b, "arrived", { event: "arrived", actor: "provider", actorName: who.name, detail: `${who.name} arrived at the destination.`, set: { arrived_at: { raw: "NOW()" } } });
    const fix = cleanFix(body);
    if (fix) await recordPoint(conn, b, who.id, fix);
  });
  const b = await loadBooking(bookingId);
  notify.customer(b, { title: `The transport provider has arrived (${bookingRef(b.id)})`, body: "Please check the goods with them. You'll be asked to confirm once they've recorded the delivery." });
  notify.seller(b, { title: `Delivery ${bookingRef(b.id)} has arrived at the destination`, body: b.dest_district });
  notify.live(b, "arrived");
  return b;
}

// The provider records what they delivered (photos and quantities) and the
// delivery goes to the buyer to confirm.
async function submitDelivery(who, bookingId, files, body = {}) {
  const b0 = await loadBooking(bookingId);
  if (!b0) throw notFound("Delivery not found.");
  mustOwn(b0, who);
  if (b0.status !== "arrived") throw conflict(b0.status === "in_transit" ? "Mark that you've arrived first." : `The delivery can't be recorded now ("${STATUS_LABELS[b0.status]}").`);
  const orders = liveOrders(await core.bookingOrders(pool, b0.id));
  const collected = await quantitiesOf(pool, b0.id, "provider_collected");
  const { errors, list } = readQuantities(body, orders, (o) => collected.get(Number(o.id)) ?? Number(o.quantity));
  const note = cleanNote(body.note);
  const differs = list.some((x) => Number.isInteger(x.quantity) && x.quantity !== x.expected);
  if (differs && !note) errors.note = "Please explain the difference from what you collected.";
  if (!(files || []).length) errors.images = "Please add at least one photo of the delivered goods.";
  if (Object.keys(errors).length) throw invalid(errors);
  const point = readPoint(body);
  const saved = await savePhotos(files, { label: "photo of the delivered goods" });
  try {
    await core.withBooking(bookingId, async (conn, b) => {
      mustOwn(b, who);
      if (b.status !== "arrived") throw conflict("The delivery can no longer be recorded.");
      await insertSubmission(conn, b.id, { stage: "provider_delivery", party: "provider", actorName: who.name, note, discrepancy: differs, point });
      await storePhotos(conn, b.id, "provider_delivery", "provider", saved, point);
      for (const x of list) {
        await conn.query("INSERT INTO transport_quantities (booking_id, order_id, stage, quantity) VALUES (?, ?, 'provider_delivered', ?)", [b.id, x.order.id, x.quantity]);
      }
      const summary = list.map((x) => `${orderRef(x.order.id)}: ${x.quantity} delivered of ${x.expected} collected`).join("; ");
      await core.transition(conn, b, "delivery_submitted", { event: "delivery_submitted", actor: "provider", actorName: who.name, detail: `${who.name} recorded the delivery with ${saved.length} photo${saved.length === 1 ? "" : "s"}. ${summary}.${differs ? ` Note: ${note}` : ""}`, set: { delivery_submitted_at: { raw: "NOW()" } } });
      await core.transition(conn, b, "awaiting_confirmation", { event: "awaiting_confirmation", actor: "system", detail: "Waiting for the buyer to check the goods and confirm." });
    });
  } catch (error) {
    dropPhotos(saved);
    throw error;
  }
  const b = await loadBooking(bookingId);
  notify.customer(b, {
    title: `Please confirm your delivery (${bookingRef(b.id)})`,
    body: "Check the goods, add your photos and confirm, or report a problem.",
    subject: `Please confirm your delivery ${bookingRef(b.id)}`,
    heading: "Your delivery is waiting for your confirmation",
    paragraphs: ["The transport provider has recorded the delivery. Please check the goods, then open your order to add a few photos and confirm, or report a problem if anything isn't right.", "The order is only completed once you confirm."],
  });
  notify.seller(b, { title: `Delivery ${bookingRef(b.id)} recorded`, body: "Waiting for the buyer to confirm." });
  if (differs) notify.team(b, { subject: `Delivery difference reported on ${bookingRef(b.id)}`, heading: "The provider delivered a different quantity", paragraphs: [note], rows: list.map((x) => [`${orderRef(x.order.id)} ${x.order.livestock_title}`, `${x.quantity} delivered of ${x.expected} collected`]) });
  notify.live(b, "awaiting_confirmation");
  return b;
}

// The booking's orders are delivered, received and handed over, as one step:
// the seller's payout follows (Admin > Payouts). Frontier's own stock has no
// seller to pay, so it completes straight away.
async function completeOrders(conn, b, note) {
  const orders = liveOrders(await core.bookingOrders(conn, b.id));
  const by = `Transport ${bookingRef(b.id)}`;
  for (const o of orders) {
    await conn.query(
      `UPDATE orders SET sent_method = 'delivered', sent_at = COALESCE(sent_at, ?), sent_by = COALESCE(sent_by, ?),
         received_at = COALESCE(received_at, NOW()), received_note = COALESCE(received_note, ?), handover_method = 'delivered',
         handed_over_at = COALESCE(handed_over_at, NOW()), handed_over_by = COALESCE(handed_over_by, ?),
         status = IF(seller_id IS NULL, 'completed', status)
       WHERE id = ? AND status NOT IN ('cancelled', 'completed')`,
      [b.collection_confirmed_at || b.started_at || new Date(), by, note ? String(note).slice(0, 500) : null, by, o.id],
    );
  }
  return orders;
}

function afterCompleted(b, orders, { viaDispute = false } = {}) {
  const notifications = require("../../services/notifications");
  notify.customer(b, {
    title: `Delivery ${bookingRef(b.id)} is complete`,
    body: "Thank you. Please rate the transport provider and your experience with Frontier Marketplace.",
    subject: `Delivery complete: ${bookingRef(b.id)}`,
    heading: "Thank you, your delivery is complete",
    paragraphs: ["Thank you for confirming your delivery. It would help us a lot if you rated the transport provider and your experience with Frontier Marketplace: it takes a minute."],
  });
  notify.seller(b, {
    title: `Delivery ${bookingRef(b.id)} confirmed by the buyer`,
    body: "The order is handed over. Frontier will now pay you.",
    subject: `Delivered and confirmed: ${bookingRef(b.id)}`,
    heading: "The buyer confirmed the delivery",
    paragraphs: ["The buyer has confirmed they received the goods. The order is marked as handed over and Frontier will now process your payment."],
  });
  if (b.provider_id) {
    notify.provider(b.provider_id, b, {
      title: `Delivery ${bookingRef(b.id)} confirmed`,
      body: `${viaDispute ? "Frontier completed the delivery after reviewing the buyer's report." : "The buyer confirmed the delivery."} Your earning: ${kwacha(b.provider_earning)}.`,
      subject: `Delivery confirmed: ${bookingRef(b.id)}`,
      paragraphs: [`The delivery has been ${viaDispute ? "completed by Frontier after reviewing the buyer's report" : "confirmed by the buyer"}. Thank you.`],
      rows: [["Your earning", kwacha(b.provider_earning)]],
    });
  }
  notify.team(b, {
    subject: `Delivery complete: ${bookingRef(b.id)}`,
    heading: "A delivery is complete",
    paragraphs: [
      `${viaDispute ? "The dispute was resolved as delivered." : "The buyer confirmed the delivery."} The orders are handed over: ${b.seller_id ? "the seller can now be paid (Admin > Payouts)." : "Frontier's own stock, nothing to pay."} The provider is owed ${kwacha(b.provider_earning)}.`,
    ],
    rows: orders.map((o) => [orderRef(o.id), `${o.livestock_title} · ${kwacha(o.total)}`]),
  });
  orders.forEach((o) => {
    txlog.record({ checkoutId: b.checkout_id, orderId: o.id, reference: orderRef(o.id), event: "transport_delivered", actor: "buyer", detail: `${orderRef(o.id)} (${o.livestock_title}) delivered by transport ${bookingRef(b.id)} and confirmed${viaDispute ? " by Frontier after a dispute" : " by the buyer"}. ${b.seller_id ? "The seller can now be paid." : "Order Completed."}` });
    notifications.broadcastAdmin("order", { id: o.id, checkout_id: b.checkout_id, change: "handed_over" });
  });
  if (b.buyer_id) notifications.pingBuyer(b.buyer_id, "order", { checkout_id: b.checkout_id });
  notify.live(b, "completed");
}

// The buyer checks the goods and confirms, with their own photos.
async function confirmDelivery(buyer, bookingId, files, body = {}) {
  const b0 = await loadBooking(bookingId);
  if (!b0) throw notFound("Delivery not found.");
  mustOwn(b0, { party: "customer", id: buyer.id });
  if (b0.status !== "awaiting_confirmation") throw conflict(b0.status === "completed" ? "You've already confirmed this delivery." : "You can confirm once the provider has recorded the delivery.");
  const errors = {};
  if (!["1", "true", "on"].includes(String(body.agree))) errors.agree = "Please tick the box to confirm you've received the goods.";
  if (!(files || []).length) errors.images = "Please add at least one photo of what you received.";
  if (Object.keys(errors).length) throw invalid(errors);
  const note = cleanNote(body.note, 500);
  const saved = await savePhotos(files, { label: "photo of what you received" });
  let orders = [];
  try {
    await core.withBooking(bookingId, async (conn, b) => {
      mustOwn(b, { party: "customer", id: buyer.id });
      if (b.status !== "awaiting_confirmation") throw conflict("This delivery has already been confirmed or reported.");
      await insertSubmission(conn, b.id, { stage: "customer_delivery", party: "customer", actorName: buyer.full_name, note, discrepancy: false });
      await storePhotos(conn, b.id, "customer_delivery", "customer", saved, null);
      await core.transition(conn, b, "completed", { event: "completed", actor: "customer", actorName: buyer.full_name, detail: `${buyer.full_name} confirmed the delivery with ${saved.length} photo${saved.length === 1 ? "" : "s"}${note ? `: "${note}"` : "."}`, set: { completed_at: { raw: "NOW()" } } });
      orders = await completeOrders(conn, b, note);
    });
  } catch (error) {
    dropPhotos(saved);
    throw error;
  }
  const b = await loadBooking(bookingId);
  afterCompleted(b, orders);
  return b;
}

const DISPUTE_REASONS = { missing: "Products missing", quantity: "Wrong quantity", damaged: "Damaged or injured", condition: "Not in the expected condition", other: "Something else" };

// The buyer reports a problem. The delivery is not completed: Frontier
// investigates and resolves it.
async function dispute(buyer, bookingId, files, body = {}) {
  const b0 = await loadBooking(bookingId);
  if (!b0) throw notFound("Delivery not found.");
  mustOwn(b0, { party: "customer", id: buyer.id });
  if (b0.status !== "awaiting_confirmation") throw conflict(b0.status === "disputed" ? "You've already reported a problem with this delivery." : "You can report a problem once the provider has recorded the delivery.");
  const reason = Object.keys(DISPUTE_REASONS).includes(body.reason) ? body.reason : null;
  const description = cleanNote(body.description, 2000);
  const errors = {};
  if (!reason) errors.reason = "Please choose what's wrong.";
  if (!description || description.length < 10) errors.description = "Please describe the problem (at least a sentence).";
  if (!(files || []).length) errors.images = "Please add at least one photo showing the problem.";
  if (Object.keys(errors).length) throw invalid(errors);
  const saved = await savePhotos(files, { label: "photo showing the problem" });
  try {
    await core.withBooking(bookingId, async (conn, b) => {
      mustOwn(b, { party: "customer", id: buyer.id });
      if (b.status !== "awaiting_confirmation") throw conflict("This delivery has already been confirmed or reported.");
      await insertSubmission(conn, b.id, { stage: "customer_delivery", party: "customer", actorName: buyer.full_name, note: description, discrepancy: true });
      await storePhotos(conn, b.id, "customer_delivery", "customer", saved, null);
      await conn.query("INSERT INTO transport_disputes (booking_id, buyer_id, reason, description) VALUES (?, ?, ?, ?)", [b.id, buyer.id, reason, description]);
      await core.transition(conn, b, "disputed", { event: "disputed", actor: "customer", actorName: buyer.full_name, detail: `${buyer.full_name} reported a problem (${DISPUTE_REASONS[reason]}): ${description}`.slice(0, 1000), set: { disputed_at: { raw: "NOW()" } } });
    });
  } catch (error) {
    dropPhotos(saved);
    throw error;
  }
  const b = await loadBooking(bookingId);
  notify.team(b, {
    subject: `Delivery problem reported: ${bookingRef(b.id)} (${DISPUTE_REASONS[reason]})`,
    heading: "A buyer reported a problem with a delivery",
    paragraphs: [`${buyer.full_name} reported: ${description}`, "The delivery has not been completed. Please review the seller's, provider's and buyer's photos and quantities on the delivery page, then resolve it."],
    rows: [["Problem", DISPUTE_REASONS[reason]], ["Buyer", `${buyer.full_name} (${buyer.phone || buyer.email})`]],
  });
  if (b.provider_id) notify.provider(b.provider_id, b, { title: `Problem reported on ${bookingRef(b.id)}`, body: `The buyer reported: ${DISPUTE_REASONS[reason]}. Frontier will review it and may contact you.`, subject: `Problem reported on delivery ${bookingRef(b.id)}`, paragraphs: [`The buyer reported a problem (${DISPUTE_REASONS[reason]}). Frontier will review the records and may contact you.`] });
  notify.seller(b, { title: `Problem reported on ${bookingRef(b.id)}`, body: `The buyer reported: ${DISPUTE_REASONS[reason]}. Frontier will review it.` });
  notify.customer(b, { title: `We've received your report (${bookingRef(b.id)})`, body: "Our team will review it and contact you." });
  notify.live(b, "disputed");
  return b;
}

// Frontier resolves a dispute: delivered after all (completes it), or refund.
async function resolve(admin, bookingId, resolution, note) {
  const clean = cleanNote(note);
  if (!["completed", "refund"].includes(resolution)) throw invalid({ resolution: "Please choose how it was resolved." });
  if (!clean) throw invalid({ note: "Please explain the outcome: the buyer, seller and provider are told." });
  let orders = [];
  await core.withBooking(bookingId, async (conn, b) => {
    if (b.status !== "disputed") throw conflict("Only a disputed delivery can be resolved.");
    await conn.query("UPDATE transport_disputes SET status = 'resolved', resolution = ?, resolution_note = ?, resolved_by = ?, resolved_at = NOW() WHERE booking_id = ? AND status = 'open'", [resolution, clean, admin.name, b.id]);
    if (resolution === "completed") {
      await core.transition(conn, b, "completed", { event: "dispute_resolved", actor: "admin", actorName: admin.name, detail: `Dispute resolved by ${admin.name}: delivered. ${clean}`, set: { completed_at: { raw: "NOW()" } } });
      orders = await completeOrders(conn, b, `Resolved by Frontier: ${clean}`);
    } else {
      await core.transition(conn, b, "refund_pending", { event: "dispute_resolved", actor: "admin", actorName: admin.name, detail: `Dispute resolved by ${admin.name}: refund. ${clean}` });
    }
  });
  const b = await loadBooking(bookingId);
  if (resolution === "completed") afterCompleted(b, orders, { viaDispute: true });
  else {
    notify.customer(b, { title: `Your report on ${bookingRef(b.id)} was resolved: refund`, body: clean, subject: `Your delivery report: refund (${bookingRef(b.id)})`, paragraphs: [`We've reviewed your report. Outcome: refund. ${clean}`, "We'll contact you about the refund."] });
    notify.seller(b, { title: `Report on ${bookingRef(b.id)} resolved: refund`, body: clean });
    if (b.provider_id) notify.provider(b.provider_id, b, { title: `Report on ${bookingRef(b.id)} resolved`, body: clean });
    notify.live(b, "refund_pending");
  }
  return b;
}

// Frontier cancels a delivery: before payment it is simply cancelled; once
// paid (and before the goods are collected) the transport fee goes to refund.
async function cancel(admin, bookingId, reason) {
  const clean = cleanNote(reason, 500);
  if (!clean) throw invalid({ reason: "Please say why." });
  let to = null;
  let provider = null;
  await core.withBooking(bookingId, async (conn, b) => {
    provider = b.provider_id;
    if (b.status === "pending_payment") to = "cancelled";
    else if ((core.TRANSITIONS[b.status] || []).includes("refund_pending") && core.BEFORE_COLLECTION.includes(b.status)) to = "refund_pending";
    else throw conflict(`A delivery that is "${STATUS_LABELS[b.status]}" can't be cancelled.`);
    await core.transition(conn, b, to, { event: "cancelled", actor: "admin", actorName: admin.name, detail: `Cancelled by ${admin.name}: ${clean}${to === "refund_pending" ? ` The transport fee of ${kwacha(b.fee)} is to be refunded.` : ""}`, set: { cancelled_at: { raw: "NOW()" }, cancel_reason: clean } });
    await conn.query("UPDATE transport_offers SET status = 'withdrawn', responded_at = NOW() WHERE booking_id = ? AND status = 'offered'", [b.id]);
  });
  const b = await loadBooking(bookingId);
  notify.customer(b, { title: `Delivery ${bookingRef(b.id)} was cancelled`, body: clean, subject: `Delivery ${bookingRef(b.id)} cancelled`, paragraphs: [`Your delivery was cancelled: ${clean}`, ...(to === "refund_pending" ? [`We'll refund the transport fee of ${kwacha(b.fee)} and contact you about it.`] : [])] });
  notify.seller(b, { title: `Transport for ${bookingRef(b.id)} was cancelled`, body: clean });
  if (provider) notify.provider(provider, b, { title: `Delivery ${bookingRef(b.id)} was cancelled`, body: clean, subject: `Delivery ${bookingRef(b.id)} cancelled`, paragraphs: [`Frontier cancelled this delivery: ${clean}. Please don't collect it.`] });
  notify.live(b, to);
  return b;
}

async function markRefunded(admin, bookingId, reference) {
  const ref = cleanNote(reference, 150);
  if (!ref) throw invalid({ reference: "Please enter the refund reference." });
  await core.withBooking(bookingId, async (conn, b) => {
    if (b.status !== "refund_pending") throw conflict("Only a delivery waiting for a refund can be marked refunded.");
    await core.transition(conn, b, "refunded", { event: "refunded", actor: "admin", actorName: admin.name, detail: `${admin.name} marked the refund as done (reference ${ref}).`, set: { refunded_at: { raw: "NOW()" }, refund_ref: ref } });
  });
  const b = await loadBooking(bookingId);
  notify.customer(b, { title: `Refund done for ${bookingRef(b.id)}`, body: `Reference ${ref}.`, subject: `Refund for delivery ${bookingRef(b.id)}`, paragraphs: [`We've refunded you for this delivery. Reference: ${ref}.`] });
  notify.live(b, "refunded");
  return b;
}

async function markProviderPaid(admin, bookingId, reference) {
  const ref = cleanNote(reference, 150);
  if (!ref) throw invalid({ reference: "Please enter the payment reference." });
  await core.withBooking(bookingId, async (conn, b) => {
    if (b.status !== "completed") throw conflict("The provider can be paid once the delivery is completed.");
    if (b.provider_paid_at) throw conflict("The provider has already been marked as paid.");
    await conn.query("UPDATE transport_bookings SET provider_paid_at = NOW(), provider_paid_ref = ?, provider_paid_by = ? WHERE id = ?", [ref, admin.name.slice(0, 150), b.id]);
    await core.logEvent(conn, b.id, { event: "provider_paid", actor: "admin", actorName: admin.name, detail: `${admin.name} paid the provider ${kwacha(b.provider_earning)} (reference ${ref}).` });
  });
  const b = await loadBooking(bookingId);
  notify.provider(b.provider_id, b, { title: `You've been paid for ${bookingRef(b.id)}`, body: `${kwacha(b.provider_earning)}, reference ${ref}.`, subject: `Payment for delivery ${bookingRef(b.id)}`, paragraphs: [`Frontier has paid you ${kwacha(b.provider_earning)} for this delivery.`], rows: [["Reference", ref]] });
  notify.live(b, "provider_paid");
  return b;
}

// ----------------------------------------------------------------- ratings
// One rating of the provider per completed delivery, by its buyer.
async function rateProvider(buyer, bookingId, body = {}) {
  const b = await loadBooking(bookingId);
  if (!b) throw notFound("Delivery not found.");
  mustOwn(b, { party: "customer", id: buyer.id });
  if (b.status !== "completed" || !b.provider_id) throw conflict("You can rate the provider once the delivery is complete.");
  const stars = Number.parseInt(body.stars, 10);
  if (!(stars >= 1 && stars <= 5)) throw invalid({ stars: "Please choose 1 to 5 stars." });
  const feedback = cleanNote(body.feedback);
  try {
    await pool.query("INSERT INTO transport_ratings (booking_id, provider_id, buyer_id, stars, feedback) VALUES (?, ?, ?, ?, ?)", [b.id, b.provider_id, buyer.id, stars, feedback]);
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") throw conflict("You've already rated this delivery.");
    throw error;
  }
  await core.logEvent(pool, b.id, { event: "provider_rated", actor: "customer", actorName: buyer.full_name, detail: `${buyer.full_name} rated the provider ${stars}/5.` });
  notify.provider(b.provider_id, b, { title: `New rating for ${bookingRef(b.id)}: ${stars}/5`, body: feedback || "No comment." });
  notify.live(b, "rated");
  return { stars, feedback };
}

// Whether the buyer can rate Frontier for a checkout (once per purchase):
// with transport, once a delivery is complete; with self-collection, once
// they've confirmed they received an order (the existing handover).
async function platformRatingState(buyerId, checkoutId) {
  const [[c]] = await pool.query("SELECT id, buyer_id, delivery_option FROM checkouts WHERE id = ?", [checkoutId]);
  if (!c || Number(c.buyer_id) !== Number(buyerId)) return null;
  const [[rated]] = await pool.query("SELECT stars, feedback, created_at FROM platform_ratings WHERE checkout_id = ?", [checkoutId]);
  let eligible;
  if (c.delivery_option === "transport") {
    const [[n]] = await pool.query("SELECT COUNT(*) AS n FROM transport_bookings WHERE checkout_id = ? AND status = 'completed'", [checkoutId]);
    eligible = Number(n.n) > 0;
  } else {
    const [[n]] = await pool.query("SELECT COUNT(*) AS n FROM orders WHERE checkout_id = ? AND (received_at IS NOT NULL OR (status = 'completed' AND payment_status = 'paid'))", [checkoutId]);
    eligible = Number(n.n) > 0;
  }
  return { checkout_id: c.id, delivery_option: c.delivery_option, eligible, rated: rated || null };
}

async function ratePlatform(buyer, checkoutId, body = {}) {
  const state = await platformRatingState(buyer.id, checkoutId);
  if (!state) throw notFound("Order not found.");
  if (state.rated) throw conflict("You've already rated this purchase. Thank you!");
  if (!state.eligible) throw conflict(state.delivery_option === "transport" ? "You can rate us once your delivery is complete." : "You can rate us once you've confirmed you received your order.");
  const stars = Number.parseInt(body.stars, 10);
  if (!(stars >= 1 && stars <= 5)) throw invalid({ stars: "Please choose 1 to 5 stars." });
  const feedback = cleanNote(body.feedback);
  try {
    await pool.query("INSERT INTO platform_ratings (checkout_id, buyer_id, delivery_option, stars, feedback) VALUES (?, ?, ?, ?, ?)", [checkoutId, buyer.id, state.delivery_option, stars, feedback]);
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") throw conflict("You've already rated this purchase. Thank you!");
    throw error;
  }
  txlog.record({ checkoutId, event: "platform_rated", actor: "buyer", detail: `${buyer.full_name} rated Frontier Marketplace ${stars}/5${feedback ? `: "${feedback.slice(0, 200)}"` : "."}` });
  require("../../services/notifications").broadcastAdmin("rating", { checkout_id: checkoutId });
  return { stars, feedback };
}

module.exports = {
  ACCEPTABLE, COLLECTING, TRACKING, DISPUTE_REASONS,
  loadBooking, insertBookings, onPaid, orderCancelled,
  accept, decline, release, sendToProviders,
  sellerReady, submitCollection, confirmCollection,
  start, recordLocation, arrive, submitDelivery,
  confirmDelivery, dispute, resolve, cancel, markRefunded, markProviderPaid,
  rateProvider, platformRatingState, ratePlatform,
  submissionsOf, quantitiesOf,
};
