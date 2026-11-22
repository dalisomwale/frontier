// Admin > Transport (/api/admin/transport).
//
//   deliveries   list with filters, full history, live positions, and every
//                intervention: send to providers, assign, reassign, cancel,
//                resolve a dispute, refund, pay the provider, and the seller's
//                steps for Frontier's own stock
//   providers    registrations, documents, approval, activation, coverage
//                (set here only, never by the provider), vehicles, history,
//                ratings
//   pricing      distance bands and transport settings
//   sellers      pickup points
//   ratings      provider and platform feedback, hide / show
const express = require("express");
const pool = require("../../db");
const core = require("../../lib/transport/core");
const bookings = require("../../lib/transport/bookings");
const views = require("../../lib/transport/views");
const matching = require("../../lib/transport/matching");
const routing = require("../../services/routing");
const notifications = require("../../services/notifications");
const { sendEmail, appUrl } = require("../../services/mailer");
const { uploadTransportPhotos } = require("../../middleware/upload");
const { positiveInt, text, badRequest, notFound, HttpError, PROVINCES } = require("../../lib/validate");
const { sendPrivate, vehiclesOf, DOC_TYPES } = require("../transport");
const zambia = require("../../../public/js/zambia-districts");

const router = express.Router();

function validationError(errors) {
  const e = new HttpError(422, "Please correct the highlighted fields.");
  e.errors = errors;
  return e;
}
const adminWho = (req) => ({ party: "admin", id: req.admin.id, name: req.admin.name });
const n = (v) => (v === null || v === undefined ? null : Number(v));

// ------------------------------------------------------------- overview
router.get("/overview", async (req, res, next) => {
  try {
    const [rows] = await pool.query("SELECT status, COUNT(*) AS n FROM transport_bookings GROUP BY status");
    const byStatus = Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
    const groups = Object.fromEntries(Object.entries(core.GROUPS).map(([g, list]) => [g, list.reduce((s, st) => s + (byStatus[st] || 0), 0)]));
    const [[p]] = await pool.query(
      `SELECT SUM(status = 'pending') AS pending, SUM(status = 'approved' AND is_active = 1) AS approved,
         SUM(status = 'suspended') AS suspended, SUM(status = 'approved' AND is_active = 1 AND coverage_active = 1 AND coverage_km > 0) AS covering
       FROM transport_providers`,
    );
    const [[v]] = await pool.query("SELECT COUNT(*) AS n FROM transport_vehicles WHERE status = 'active'");
    const [[money]] = await pool.query(
      `SELECT COALESCE(SUM(IF(paid_at IS NOT NULL AND status NOT IN ('refunded'), fee, 0)), 0) AS fees,
         COALESCE(SUM(IF(status = 'completed' AND provider_paid_at IS NULL, provider_earning, 0)), 0) AS owed_providers,
         COALESCE(SUM(IF(status = 'refund_pending', fee, 0)), 0) AS refunds_due
       FROM transport_bookings`,
    );
    const [[late]] = await pool.query("SELECT COUNT(*) AS n FROM transport_bookings WHERE status IN ('in_transit', 'arrived') AND delay_alert_at IS NOT NULL");
    const [[slow]] = await pool.query("SELECT COUNT(*) AS n FROM transport_bookings WHERE status IN (?) AND unaccepted_alert_at IS NOT NULL", [bookings.ACCEPTABLE]);
    const [[nopickup]] = await pool.query("SELECT COUNT(*) AS n FROM sellers WHERE account_status = 'approved' AND status = 'active' AND (pickup_lat IS NULL OR pickup_lng IS NULL)");
    const settings = await core.getSettings();
    const bands = await core.activeBands();
    res.json({
      success: true,
      data: {
        groups, by_status: byStatus, total: Object.values(byStatus).reduce((a, b) => a + b, 0),
        providers: { pending: n(p.pending) || 0, approved: n(p.approved) || 0, suspended: n(p.suspended) || 0, covering: n(p.covering) || 0 },
        vehicles: Number(v.n),
        money: { fees: Number(money.fees), owed_providers: Number(money.owed_providers), refunds_due: Number(money.refunds_due) },
        alerts: { delayed: Number(late.n), unaccepted: Number(slow.n), sellers_without_pickup: Number(nopickup.n) },
        routing: views.routingStatus(),
        geocoder: routing.geocoderName(),
        enabled: settings.enabled,
        bands: bands.length,
        frontier_pickup_set: Boolean(core.point(settings.frontier_pickup.lat, settings.frontier_pickup.lng)),
        statuses: core.STATUS_LABELS,
        group_statuses: core.GROUPS,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ------------------------------------------------------------ deliveries
const LIST_SQL = `
  SELECT b.*, p.name AS provider_name, c.full_name AS customer_name
  FROM transport_bookings b
  LEFT JOIN transport_providers p ON p.id = b.provider_id
  LEFT JOIN checkouts c ON c.id = b.checkout_id`;

router.get("/bookings", async (req, res, next) => {
  try {
    const where = [];
    const params = [];
    const group = req.query.group && core.GROUPS[req.query.group] ? req.query.group : null;
    if (group) { where.push("b.status IN (?)"); params.push(core.GROUPS[group]); }
    if (req.query.status && core.STATUS_LABELS[req.query.status]) { where.push("b.status = ?"); params.push(req.query.status); }
    const provider = positiveInt(req.query.provider);
    if (provider) { where.push("b.provider_id = ?"); params.push(provider); }
    const seller = req.query.seller === "frontier" ? "frontier" : positiveInt(req.query.seller);
    if (seller === "frontier") where.push("b.seller_id IS NULL");
    else if (seller) { where.push("b.seller_id = ?"); params.push(seller); }
    const buyer = positiveInt(req.query.buyer);
    if (buyer) { where.push("b.buyer_id = ?"); params.push(buyer); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.from || "")) { where.push("b.created_at >= ?"); params.push(`${req.query.from} 00:00:00`); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.to || "")) { where.push("b.created_at <= ?"); params.push(`${req.query.to} 23:59:59`); }
    if (req.query.alert === "delayed") where.push("b.status IN ('in_transit', 'arrived') AND b.delay_alert_at IS NOT NULL");
    if (req.query.alert === "unaccepted") { where.push("b.status IN (?) AND b.unaccepted_alert_at IS NOT NULL"); params.push(bookings.ACCEPTABLE); }
    const q = text(req.query.q, 100);
    if (q) {
      const ref = q.match(/^(?:TR-?)?(\d+)$/i);
      const like = `%${q}%`;
      where.push(`(${ref ? "b.id = ? OR " : ""}b.pickup_label LIKE ? OR c.full_name LIKE ? OR c.email LIKE ? OR c.phone LIKE ? OR p.name LIKE ? OR b.dest_district LIKE ? OR b.vehicle_registration LIKE ?
        OR EXISTS (SELECT 1 FROM transport_booking_orders bo WHERE bo.booking_id = b.id AND bo.order_id = ?))`);
      if (ref) params.push(Number(ref[1]) > 1000 ? Number(ref[1]) - 1000 : Number(ref[1]));
      const orderId = (q.match(/^FM-?(\d+)$/i) || [])[1];
      params.push(like, like, like, like, like, like, like, orderId ? Number(orderId) - 1000 : 0);
    }
    const [rows] = await pool.query(`${LIST_SQL} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY b.id DESC LIMIT 500`, params);
    res.json({ success: true, data: rows.map((b) => ({ ...views.row(b, "admin"), delayed: Boolean(b.delay_alert_at) && core.GROUPS.active.includes(b.status), unaccepted: Boolean(b.unaccepted_alert_at) && bookings.ACCEPTABLE.includes(b.status), provider_paid: Boolean(b.provider_paid_at) })) });
  } catch (error) {
    next(error);
  }
});

// Deliveries on the road, for the live map.
router.get("/active", async (req, res, next) => {
  try {
    const [rows] = await pool.query(`${LIST_SQL} WHERE b.status IN ('collection_confirmed', 'in_transit', 'arrived', 'delivery_submitted', 'awaiting_confirmation') ORDER BY b.started_at DESC LIMIT 200`);
    const settings = await core.getSettings();
    res.json({
      success: true,
      data: rows.map((b) => ({
        ...views.row(b, "admin"),
        last: b.last_lat !== null ? { lat: Number(b.last_lat), lng: Number(b.last_lng), at: b.last_location_at } : null,
        pickup: { lat: Number(b.pickup_lat), lng: Number(b.pickup_lng) },
        dest: { lat: Number(b.dest_lat), lng: Number(b.dest_lng) },
        stale: b.status === "in_transit" && (!b.last_location_at || new Date(b.last_location_at).getTime() < Date.now() - settings.gps_stale_minutes * 60000),
        delayed: Boolean(b.delay_alert_at),
      })),
    });
  } catch (error) {
    next(error);
  }
});

async function adminBooking(req) {
  const b = await bookings.loadBooking(positiveInt(req.params.id) || 0);
  if (!b) throw notFound("Delivery not found.");
  return b;
}

async function adminActions(b) {
  const subs = await bookings.submissionsOf(pool, b.id);
  return {
    send: bookings.ACCEPTABLE.includes(b.status),
    assign: bookings.ACCEPTABLE.includes(b.status),
    release: ["provider_accepted", "awaiting_collection", "collection_submitted"].includes(b.status) && !subs.has("provider_collection"),
    cancel: b.status === "pending_payment" || ((core.TRANSITIONS[b.status] || []).includes("refund_pending") && core.BEFORE_COLLECTION.includes(b.status)),
    resolve: b.status === "disputed",
    refunded: b.status === "refund_pending",
    pay_provider: b.status === "completed" && !b.provider_paid_at && Boolean(b.provider_id),
    // Frontier's own stock: the team does the seller's steps. For a seller's
    // goods the team can confirm on their behalf once both records are in.
    seller_ready: !b.seller_id && bookings.COLLECTING.includes(b.status) && !b.seller_ready_at,
    seller_record: !b.seller_id && bookings.COLLECTING.includes(b.status) && !subs.has("seller_collection"),
    confirm_collection: b.status === "collection_submitted" && subs.has("seller_collection") && subs.has("provider_collection"),
  };
}

router.get("/bookings/:id", async (req, res, next) => {
  try {
    const b = await adminBooking(req);
    const data = await views.detail(b, "admin");
    data.can = await adminActions(b);
    data.dispute_reasons = bookings.DISPUTE_REASONS;
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

router.get("/bookings/:id/track", async (req, res, next) => {
  try {
    const b = await adminBooking(req);
    res.json({ success: true, data: await views.track(b.id, req.query.after) });
  } catch (error) {
    next(error);
  }
});

// Every provider and why they can or can't take this delivery right now.
router.get("/bookings/:id/eligibility", async (req, res, next) => {
  try {
    const b = await adminBooking(req);
    const { job } = await matching.jobOf(pool, b);
    const list = await matching.assess(pool, job, { excludeBooking: b.id });
    res.json({
      success: true,
      data: list.map((x) => ({
        provider: { id: x.provider.id, name: x.provider.name, phone: x.provider.phone, status: x.provider.status, is_active: Boolean(x.provider.is_active), coverage_km: n(x.provider.coverage_km), district: x.provider.district, province: x.provider.province },
        eligible: x.eligible,
        reasons: x.reasons,
        pickup_km: x.pickup_km,
        dest_km: x.dest_km,
        vehicles: x.provider.vehicles.filter((v) => v.status === "active").map((v) => ({ id: v.id, registration: v.registration, vehicle_type: v.vehicle_type, busy: v.busy, fits: core.vehicleFits(v.cargo, job.load) })),
      })),
    });
  } catch (error) {
    next(error);
  }
});

const act = (fn, message) => async (req, res, next) => {
  try {
    const b = await adminBooking(req);
    const out = await fn(req, b);
    res.json({ success: true, message: typeof message === "function" ? message(out) : message });
  } catch (error) {
    next(error);
  }
};

router.post("/bookings/:id/offer", act((req, b) => bookings.sendToProviders(req.admin, b.id), (r) => (r.sent && r.sent.length
  ? `Sent to ${r.sent.length} eligible provider${r.sent.length === 1 ? "" : "s"}.`
  : r.routeError ? `Couldn't check providers: ${r.routeError}` : "No new eligible provider to send it to. You can assign one.")));
router.post("/bookings/:id/assign", act((req, b) => {
  const providerId = positiveInt(req.body.provider_id);
  const vehicleId = positiveInt(req.body.vehicle_id);
  if (!providerId || !vehicleId) throw validationError({ provider_id: "Choose a provider and one of their vehicles." });
  return bookings.accept(providerId, b.id, vehicleId, { admin: req.admin, force: req.body.force === true || req.body.force === "1" });
}, "Provider assigned. The provider, seller and buyer have been told."));
router.post("/bookings/:id/release", act((req, b) => bookings.release(req.admin, b.id, req.body.reason), "Taken back from the provider and offered again."));
router.post("/bookings/:id/cancel", act((req, b) => bookings.cancel(req.admin, b.id, req.body.reason), (b) => (b.status === "refund_pending" ? "Cancelled. The transport fee is marked for refund." : "Cancelled.")));
router.post("/bookings/:id/resolve", act((req, b) => bookings.resolve(req.admin, b.id, req.body.resolution, req.body.note), (b) => (b.status === "completed" ? "Resolved: delivery completed." : "Resolved: refund pending.")));
router.post("/bookings/:id/refunded", act((req, b) => bookings.markRefunded(req.admin, b.id, req.body.reference), "Marked as refunded. The buyer has been told."));
router.post("/bookings/:id/provider-paid", act((req, b) => bookings.markProviderPaid(req.admin, b.id, req.body.reference), "Provider marked as paid."));
router.post("/bookings/:id/seller-ready", act((req, b) => bookings.sellerReady(adminWho(req), b.id), "Marked ready. The provider has been told."));
router.post("/bookings/:id/confirm-collection", act((req, b) => bookings.confirmCollection(adminWho(req), b.id), "Collection confirmed."));
router.post("/bookings/:id/seller-collection", uploadTransportPhotos, act((req, b) => {
  if (b.seller_id) throw new HttpError(409, "The seller records their own handover.");
  return bookings.submitCollection(adminWho(req), b.id, req.files, req.body);
}, "Handover recorded."));

// ------------------------------------------------------------- providers
const PROVIDER_LIST = `
  SELECT p.*,
    (SELECT COUNT(*) FROM transport_vehicles v WHERE v.provider_id = p.id AND v.status = 'active') AS vehicles,
    (SELECT COUNT(*) FROM transport_bookings b WHERE b.provider_id = p.id AND b.status = 'completed') AS completed,
    (SELECT COUNT(*) FROM transport_bookings b WHERE b.provider_id = p.id AND b.status IN (?)) AS active,
    (SELECT COUNT(*) FROM transport_provider_documents d WHERE d.provider_id = p.id) AS documents,
    (SELECT ROUND(AVG(r.stars), 1) FROM transport_ratings r WHERE r.provider_id = p.id AND r.hidden = 0) AS rating,
    (SELECT COUNT(*) FROM transport_ratings r WHERE r.provider_id = p.id AND r.hidden = 0) AS ratings
  FROM transport_providers p`;
const ONGOING = [...core.GROUPS.accepted, ...core.GROUPS.active, "disputed"];

function providerRow(p) {
  return {
    id: p.id, kind: p.kind, name: p.name, contact_person: p.contact_person, phone: p.phone, email: p.email,
    province: p.province, district: p.district, address: p.address, base_label: p.base_label,
    base_lat: n(p.base_lat), base_lng: n(p.base_lng), registration_number: p.registration_number, licence_number: p.licence_number,
    status: p.status, is_active: Boolean(p.is_active), is_available: Boolean(p.is_available),
    coverage_km: n(p.coverage_km), coverage_active: Boolean(p.coverage_active), admin_note: p.admin_note,
    approved_at: p.approved_at, created_at: p.created_at, last_login_at: p.last_login_at,
    vehicles: n(p.vehicles), completed: n(p.completed), active: n(p.active), documents: n(p.documents),
    rating: p.rating === null || p.rating === undefined ? null : Number(p.rating), ratings: n(p.ratings) || 0,
  };
}

router.get("/providers", async (req, res, next) => {
  try {
    const where = [];
    const params = [ONGOING];
    if (["pending", "approved", "rejected", "suspended"].includes(req.query.status)) { where.push("p.status = ?"); params.push(req.query.status); }
    if (req.query.active === "0") where.push("p.is_active = 0");
    const q = text(req.query.q, 100);
    if (q) {
      where.push("(p.name LIKE ? OR p.contact_person LIKE ? OR p.phone LIKE ? OR p.email LIKE ? OR p.district LIKE ? OR EXISTS (SELECT 1 FROM transport_vehicles v WHERE v.provider_id = p.id AND v.registration LIKE ?))");
      params.push(...Array(6).fill(`%${q}%`));
    }
    const [rows] = await pool.query(`${PROVIDER_LIST} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY p.status = 'pending' DESC, p.name LIMIT 500`, params);
    const [[counts]] = await pool.query("SELECT COUNT(*) AS all_, SUM(status = 'pending') AS pending, SUM(status = 'approved') AS approved, SUM(status = 'suspended') AS suspended, SUM(status = 'rejected') AS rejected FROM transport_providers");
    res.json({ success: true, data: rows.map(providerRow), counts: { all: n(counts.all_) || 0, pending: n(counts.pending) || 0, approved: n(counts.approved) || 0, suspended: n(counts.suspended) || 0, rejected: n(counts.rejected) || 0 } });
  } catch (error) {
    next(error);
  }
});

async function loadProviderFull(id) {
  const [[p]] = await pool.query(`${PROVIDER_LIST} WHERE p.id = ?`, [ONGOING, id]);
  if (!p) throw notFound("Transport provider not found.");
  const [docs] = await pool.query("SELECT id, doc_type, original_name, mime, size_bytes, created_at FROM transport_provider_documents WHERE provider_id = ? ORDER BY id", [id]);
  const [history] = await pool.query("SELECT * FROM transport_bookings WHERE provider_id = ? ORDER BY id DESC LIMIT 200", [id]);
  const [ratings] = await pool.query("SELECT id, booking_id, stars, feedback, hidden, created_at FROM transport_ratings WHERE provider_id = ? ORDER BY id DESC LIMIT 200", [id]);
  const [[perf]] = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM transport_offers WHERE provider_id = ?) AS offered,
       (SELECT COUNT(*) FROM transport_offers WHERE provider_id = ? AND status = 'accepted') AS accepted,
       (SELECT COUNT(*) FROM transport_offers WHERE provider_id = ? AND status = 'declined') AS declined,
       (SELECT COUNT(*) FROM transport_bookings WHERE provider_id = ? AND status = 'disputed') AS disputed_now,
       (SELECT COUNT(DISTINCT d.booking_id) FROM transport_disputes d JOIN transport_bookings b ON b.id = d.booking_id WHERE b.provider_id = ?) AS disputed_ever,
       (SELECT ROUND(AVG(TIMESTAMPDIFF(MINUTE, started_at, delivery_submitted_at))) FROM transport_bookings WHERE provider_id = ? AND delivery_submitted_at IS NOT NULL AND started_at IS NOT NULL) AS avg_trip_min,
       (SELECT ROUND(AVG(duration_min)) FROM transport_bookings WHERE provider_id = ? AND delivery_submitted_at IS NOT NULL) AS avg_route_min,
       (SELECT COALESCE(SUM(provider_earning), 0) FROM transport_bookings WHERE provider_id = ? AND status = 'completed' AND provider_paid_at IS NULL) AS owed,
       (SELECT COALESCE(SUM(provider_earning), 0) FROM transport_bookings WHERE provider_id = ? AND provider_paid_at IS NOT NULL) AS paid`,
    Array(9).fill(id),
  );
  return {
    ...providerRow(p),
    documents: docs.map((d) => ({ ...d, type_label: DOC_TYPES[d.doc_type] || d.doc_type })),
    vehicle_list: await vehiclesOf(id),
    history: history.map((b) => views.row(b, "admin")),
    rating_list: ratings.map((r) => ({ ...r, hidden: Boolean(r.hidden), reference: core.bookingRef(r.booking_id) })),
    performance: Object.fromEntries(Object.entries(perf).map(([k, v]) => [k, v === null ? null : Number(v)])),
  };
}

router.get("/providers/:id", async (req, res, next) => {
  try {
    res.json({ success: true, data: await loadProviderFull(positiveInt(req.params.id) || 0), cargo_types: await core.cargoLabels() });
  } catch (error) {
    next(error);
  }
});

function providerEmail(p, subject, paragraphs) {
  return sendEmail({ to: p.email, subject, heading: subject, paragraphs: [`Hi ${String(p.contact_person || p.name).split(/\s+/)[0]},`, ...paragraphs], button: { label: "Open your transport dashboard", url: appUrl("/transport/") }, log: true });
}

// Approve, reject, suspend or reinstate a provider.
router.patch("/providers/:id/status", async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id) || 0;
    const [[p]] = await pool.query("SELECT * FROM transport_providers WHERE id = ?", [id]);
    if (!p) throw notFound("Transport provider not found.");
    const action = String(req.body.action || "");
    const note = text(req.body.note, 500) || null;
    if (["reject", "suspend"].includes(action) && !note) throw validationError({ note: "Please give a reason: the provider is told." });
    if (action === "suspend") {
      const [[busy]] = await pool.query("SELECT COUNT(*) AS n FROM transport_bookings WHERE provider_id = ? AND status IN (?)", [id, core.VEHICLE_BUSY]);
      if (Number(busy.n) && req.body.confirm_busy !== true) throw new HttpError(409, `${p.name} has ${busy.n} delivery${Number(busy.n) === 1 ? "" : "s"} in progress. Reassign ${Number(busy.n) === 1 ? "it" : "them"} first, or confirm to suspend anyway.`);
    }
    const next0 = { approve: "approved", reject: "rejected", suspend: "suspended", reinstate: "approved" }[action];
    if (!next0) throw badRequest("Unknown action.");
    if (action === "approve" && p.status === "approved") throw badRequest("Already approved.");
    if (action === "reinstate" && p.status !== "suspended") throw badRequest("Only a suspended provider can be reinstated.");
    await pool.query(
      `UPDATE transport_providers SET status = ?, admin_note = ?, approved_at = IF(? = 'approved', COALESCE(approved_at, NOW()), approved_at) WHERE id = ?`,
      [next0, note, next0, id],
    );
    if (action === "suspend" || action === "reject") {
      await pool.query("UPDATE transport_offers o JOIN transport_bookings b ON b.id = o.booking_id SET o.status = 'withdrawn', o.responded_at = NOW() WHERE o.provider_id = ? AND o.status = 'offered'", [id]);
    }
    const message = {
      approve: ["Your transport account is approved", ["Frontier has approved your account. Make sure your vehicles are added and you're marked available: you'll receive delivery requests in your area once Frontier has set your coverage."]],
      reject: ["Your transport registration was not approved", [`Frontier didn't approve your registration: ${note}`, "Please contact us if you have questions."]],
      suspend: ["Your transport account is suspended", [`Frontier has suspended your account: ${note}`, "You won't receive delivery requests while it is suspended."]],
      reinstate: ["Your transport account is active again", ["Frontier has reinstated your account. You'll receive delivery requests again."]],
    }[action];
    providerEmail(p, message[0], message[1]);
    notifications.notifyProvider(id, { type: "account", title: message[0], body: message[1].join(" "), link: "/transport/" });
    res.json({ success: true, message: `${p.name}: ${next0}.`, data: await loadProviderFull(id) });
  } catch (error) {
    next(error);
  }
});

router.patch("/providers/:id/active", async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id) || 0;
    const [[p]] = await pool.query("SELECT * FROM transport_providers WHERE id = ?", [id]);
    if (!p) throw notFound("Transport provider not found.");
    const on = req.body.is_active === true || req.body.is_active === "1";
    await pool.query("UPDATE transport_providers SET is_active = ? WHERE id = ?", [on ? 1 : 0, id]);
    if (!on) await pool.query("UPDATE transport_offers SET status = 'withdrawn', responded_at = NOW() WHERE provider_id = ? AND status = 'offered'", [id]);
    notifications.notifyProvider(id, { type: "account", title: on ? "Your account is active" : "Your account has been deactivated", body: on ? "You can receive delivery requests again." : "Frontier deactivated your account. Please contact us.", link: "/transport/" });
    res.json({ success: true, message: on ? "Activated." : "Deactivated.", data: await loadProviderFull(id) });
  } catch (error) {
    next(error);
  }
});

// Coverage: how far from their operating location the provider takes jobs
// (both pickup and destination must be within it, by road). Frontier only.
router.patch("/providers/:id/coverage", async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id) || 0;
    const [[p]] = await pool.query("SELECT id, name FROM transport_providers WHERE id = ?", [id]);
    if (!p) throw notFound("Transport provider not found.");
    const km = req.body.coverage_km === "" || req.body.coverage_km === null || req.body.coverage_km === undefined ? null : Number(req.body.coverage_km);
    const active = req.body.coverage_active === true || req.body.coverage_active === "1";
    if (km !== null && (!Number.isFinite(km) || km <= 0 || km > 3000)) throw validationError({ coverage_km: "Enter a distance from 1 to 3000 km." });
    if (active && km === null) throw validationError({ coverage_km: "Set the distance before switching coverage on." });
    await pool.query("UPDATE transport_providers SET coverage_km = ?, coverage_active = ? WHERE id = ?", [km === null ? null : Math.round(km * 10) / 10, active ? 1 : 0, id]);
    notifications.notifyProvider(id, { type: "account", title: active ? `Your coverage: ${km} km` : "Your coverage is switched off", body: active ? `You'll receive requests where both the pickup and the destination are within ${km} km of your operating location by road.` : "You won't receive new requests until Frontier switches your coverage back on.", link: "/transport/" });
    res.json({ success: true, message: "Coverage saved.", data: await loadProviderFull(id) });
  } catch (error) {
    next(error);
  }
});

// Frontier corrects the provider's details or operating location.
router.put("/providers/:id", async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id) || 0;
    const [[p]] = await pool.query("SELECT id FROM transport_providers WHERE id = ?", [id]);
    if (!p) throw notFound("Transport provider not found.");
    const province = text(req.body.province, 50);
    const district = text(req.body.district, 80);
    const address = text(req.body.address, 255);
    const base = core.point(req.body.base_lat, req.body.base_lng);
    const errors = {};
    if (!province || !PROVINCES.includes(province)) errors.province = "Choose a province.";
    if (!district) errors.district = "Choose the district.";
    else if (province && !zambia.match(province, district)) errors.district = `Choose one of ${province} Province's districts.`;
    if (!address) errors.address = "Enter the address.";
    if (!base) errors.base_point = "Mark the operating location on the map.";
    if (Object.keys(errors).length) throw validationError(errors);
    await pool.query("UPDATE transport_providers SET province = ?, district = ?, address = ?, base_lat = ?, base_lng = ?, base_label = ? WHERE id = ?", [province, zambia.match(province, district), address, base.lat, base.lng, text(req.body.base_label, 255) || null, id]);
    res.json({ success: true, message: "Saved.", data: await loadProviderFull(id) });
  } catch (error) {
    next(error);
  }
});

router.get("/documents/:id", async (req, res, next) => {
  try {
    const [[row]] = await pool.query("SELECT * FROM transport_provider_documents WHERE id = ?", [positiveInt(req.params.id) || 0]);
    sendPrivate(res, row);
  } catch (error) {
    next(error);
  }
});

router.get("/vehicle-files/:id", async (req, res, next) => {
  try {
    const [[row]] = await pool.query("SELECT * FROM transport_vehicle_files WHERE id = ? AND kind = 'document'", [positiveInt(req.params.id) || 0]);
    sendPrivate(res, row);
  } catch (error) {
    next(error);
  }
});

router.patch("/vehicles/:id/status", async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id) || 0;
    const [[v]] = await pool.query("SELECT * FROM transport_vehicles WHERE id = ?", [id]);
    if (!v) throw notFound("Vehicle not found.");
    const status = req.body.status === "inactive" ? "inactive" : "active";
    if (status === "inactive") {
      const [[busy]] = await pool.query("SELECT id FROM transport_bookings WHERE vehicle_id = ? AND status IN (?) LIMIT 1", [id, core.VEHICLE_BUSY]);
      if (busy) throw new HttpError(409, `This vehicle is on delivery ${core.bookingRef(busy.id)}.`);
    }
    await pool.query("UPDATE transport_vehicles SET status = ? WHERE id = ?", [status, id]);
    res.json({ success: true, message: status === "active" ? "Vehicle active." : "Vehicle deactivated.", data: await loadProviderFull(v.provider_id) });
  } catch (error) {
    next(error);
  }
});

// --------------------------------------------------------------- pricing
router.get("/bands", async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      "SELECT b.*, (SELECT COUNT(*) FROM transport_bookings t WHERE t.band_id = b.id) AS used FROM transport_price_bands b ORDER BY b.min_km, b.id",
    );
    const list = rows.map((r) => ({ ...core.bandView(r), used: Number(r.used), updated_at: r.updated_at }));
    res.json({ success: true, data: list, gaps: core.bandGaps(list) });
  } catch (error) {
    next(error);
  }
});

function bandPayload(body) {
  const min = Number(body.min_km);
  const max = body.max_km === "" || body.max_km === null || body.max_km === undefined ? null : Number(body.max_km);
  const base = Number(body.base_fee);
  const perKm = body.per_km === "" || body.per_km === undefined ? 0 : Number(body.per_km);
  const errors = {};
  if (!Number.isFinite(min) || min < 0) errors.min_km = "Enter a distance from 0.";
  if (max !== null && (!Number.isFinite(max) || max <= min)) errors.max_km = "Must be more than the 'from' distance, or empty for no upper limit.";
  if (!Number.isFinite(base) || base < 0) errors.base_fee = "Enter the fee (0 or more).";
  if (!Number.isFinite(perKm) || perKm < 0) errors.per_km = "Enter 0 or more.";
  if (Number.isFinite(base) && Number.isFinite(perKm) && base === 0 && perKm === 0) errors.base_fee = "A band needs a fee, a price per km, or both.";
  return { errors, data: { min_km: Math.round(min * 10) / 10, max_km: max === null ? null : Math.round(max * 10) / 10, base_fee: Math.round(base * 100) / 100, per_km: Math.round(perKm * 100) / 100, is_active: body.is_active === false || body.is_active === "0" ? 0 : 1 } };
}

async function checkOverlap(candidate, exceptId = 0) {
  const [rows] = await pool.query("SELECT * FROM transport_price_bands WHERE is_active = 1 AND id <> ?", [exceptId]);
  const list = [...rows.map(core.bandView), ...(candidate.is_active ? [{ ...candidate, id: exceptId || 0, is_active: true }] : [])];
  const problem = core.overlapProblem(list);
  if (problem) throw validationError({ min_km: problem });
}

router.post("/bands", async (req, res, next) => {
  try {
    const { errors, data } = bandPayload(req.body);
    if (Object.keys(errors).length) throw validationError(errors);
    await checkOverlap(data);
    await pool.query("INSERT INTO transport_price_bands (min_km, max_km, base_fee, per_km, is_active) VALUES (?, ?, ?, ?, ?)", [data.min_km, data.max_km, data.base_fee, data.per_km, data.is_active]);
    res.status(201).json({ success: true, message: "Price band added." });
  } catch (error) {
    next(error);
  }
});

// Changing a band never changes bookings already made: each stores the price it was charged.
router.put("/bands/:id", async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id) || 0;
    const [[row]] = await pool.query("SELECT id FROM transport_price_bands WHERE id = ?", [id]);
    if (!row) throw notFound("Price band not found.");
    const { errors, data } = bandPayload(req.body);
    if (Object.keys(errors).length) throw validationError(errors);
    await checkOverlap(data, id);
    await pool.query("UPDATE transport_price_bands SET min_km = ?, max_km = ?, base_fee = ?, per_km = ?, is_active = ? WHERE id = ?", [data.min_km, data.max_km, data.base_fee, data.per_km, data.is_active, id]);
    res.json({ success: true, message: "Price band saved. Deliveries already booked keep their price." });
  } catch (error) {
    next(error);
  }
});

router.patch("/bands/:id", async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id) || 0;
    const [[row]] = await pool.query("SELECT * FROM transport_price_bands WHERE id = ?", [id]);
    if (!row) throw notFound("Price band not found.");
    const on = req.body.is_active === true || req.body.is_active === "1";
    if (on) await checkOverlap({ ...core.bandView(row), is_active: true }, id);
    await pool.query("UPDATE transport_price_bands SET is_active = ? WHERE id = ?", [on ? 1 : 0, id]);
    res.json({ success: true, message: on ? "Band switched on." : "Band switched off." });
  } catch (error) {
    next(error);
  }
});

router.delete("/bands/:id", async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id) || 0;
    const [[used]] = await pool.query("SELECT COUNT(*) AS n FROM transport_bookings WHERE band_id = ?", [id]);
    if (Number(used.n)) throw new HttpError(409, "This band has been used for deliveries, so it's kept for the records. Switch it off instead.");
    await pool.query("DELETE FROM transport_price_bands WHERE id = ?", [id]);
    res.json({ success: true, message: "Price band removed." });
  } catch (error) {
    next(error);
  }
});

// What a distance would cost with the active bands (for the admin to check).
router.get("/bands/price", async (req, res, next) => {
  try {
    const km = Number(req.query.km);
    if (!Number.isFinite(km) || km < 0) throw badRequest("Enter a distance.");
    const settings = await core.getSettings();
    const price = core.priceFor(km, await core.activeBands(), settings.commission_pct);
    res.json({ success: true, data: price ? { band: price.band.label, fee: price.fee, commission: price.commission, earning: price.earning } : null });
  } catch (error) {
    next(error);
  }
});

router.get("/settings", async (req, res, next) => {
  try {
    res.json({ success: true, data: await core.getSettings(), routing: views.routingStatus(), geocoder: routing.geocoderName() });
  } catch (error) {
    next(error);
  }
});

router.put("/settings", async (req, res, next) => {
  try {
    const b = req.body || {};
    const errors = {};
    const window = Number(b.accept_window_minutes);
    const stale = Number(b.gps_stale_minutes);
    const pct = Number(b.commission_pct);
    if (!Number.isFinite(window) || window < 5 || window > 10080) errors.accept_window_minutes = "From 5 minutes to 7 days.";
    if (!Number.isFinite(stale) || stale < 2 || stale > 720) errors.gps_stale_minutes = "From 2 to 720 minutes.";
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) errors.commission_pct = "From 0 to 100.";
    const point = core.point(b.frontier_pickup_lat, b.frontier_pickup_lng);
    if ((b.frontier_pickup_lat || b.frontier_pickup_lng) && !point) errors.frontier_pickup_point = "Mark the pickup point on the map.";
    if (b.frontier_pickup_district && b.frontier_pickup_province && !zambia.match(b.frontier_pickup_province, b.frontier_pickup_district)) errors.frontier_pickup_district = `Choose one of ${b.frontier_pickup_province} Province's districts.`;
    if (Object.keys(errors).length) throw validationError(errors);
    const clip = (v, max) => String(v || "").trim().slice(0, max);
    const saved = await core.saveSettings({
      enabled: b.enabled === true || b.enabled === "1" ? "1" : "0",
      accept_window_minutes: String(Math.round(window)),
      gps_stale_minutes: String(Math.round(stale)),
      commission_pct: String(Math.round(pct * 100) / 100),
      frontier_pickup_label: clip(b.frontier_pickup_label, 150) || "Frontier Farms & Consult",
      frontier_pickup_address: clip(b.frontier_pickup_address, 255),
      frontier_pickup_district: zambia.match(b.frontier_pickup_province, b.frontier_pickup_district) || clip(b.frontier_pickup_district, 80),
      frontier_pickup_province: PROVINCES.includes(b.frontier_pickup_province) ? b.frontier_pickup_province : "",
      frontier_pickup_phone: clip(b.frontier_pickup_phone, 30),
      frontier_pickup_lat: point ? String(point.lat) : "",
      frontier_pickup_lng: point ? String(point.lng) : "",
    });
    res.json({ success: true, message: "Transport settings saved.", data: saved });
  } catch (error) {
    next(error);
  }
});

// --------------------------------------------------------------- sellers
router.get("/sellers", async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, name, business_name, phone, province, address, pickup_district, pickup_address, pickup_lat, pickup_lng, account_status, status
       FROM sellers WHERE password_hash IS NOT NULL OR EXISTS (SELECT 1 FROM livestock l WHERE l.seller_id = sellers.id)
       ORDER BY (pickup_lat IS NULL) DESC, COALESCE(business_name, name) LIMIT 1000`,
    );
    res.json({ success: true, data: rows.map((s) => ({ ...s, pickup_lat: n(s.pickup_lat), pickup_lng: n(s.pickup_lng), has_pickup: s.pickup_lat !== null && s.pickup_lng !== null })) });
  } catch (error) {
    next(error);
  }
});

router.put("/sellers/:id/pickup", async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id) || 0;
    const [[s]] = await pool.query("SELECT id, province FROM sellers WHERE id = ?", [id]);
    if (!s) throw notFound("Seller not found.");
    const district = text(req.body.pickup_district, 80);
    const address = text(req.body.pickup_address, 255);
    const point = core.point(req.body.pickup_lat, req.body.pickup_lng);
    const errors = {};
    if (!district) errors.pickup_district = "Choose the district.";
    else if (s.province && zambia.list(s.province).length && !zambia.match(s.province, district)) errors.pickup_district = `Choose one of ${s.province} Province's districts (the seller's province).`;
    else if (!zambia.provinceOf(district)) errors.pickup_district = "Choose a district from the list.";
    if (!address) errors.pickup_address = "Enter the address or directions.";
    if (!point) errors.pickup_point = "Mark the pickup point on the map.";
    if (Object.keys(errors).length) throw validationError(errors);
    await pool.query("UPDATE sellers SET pickup_district = ?, pickup_address = ?, pickup_lat = ?, pickup_lng = ? WHERE id = ?", [zambia.match(s.province, district) || zambia.match(zambia.provinceOf(district), district), address, point.lat, point.lng, id]);
    res.json({ success: true, message: "Pickup point saved." });
  } catch (error) {
    next(error);
  }
});

// --------------------------------------------------------------- ratings
router.get("/ratings", async (req, res, next) => {
  try {
    const type = req.query.type === "platform" ? "platform" : "provider";
    if (type === "platform") {
      const [rows] = await pool.query(
        `SELECT r.*, c.full_name, c.email FROM platform_ratings r LEFT JOIN checkouts c ON c.id = r.checkout_id ORDER BY r.id DESC LIMIT 500`,
      );
      const [[avg]] = await pool.query("SELECT ROUND(AVG(stars), 2) AS avg, COUNT(*) AS n, SUM(delivery_option = 'transport') AS transport, SUM(delivery_option = 'collect') AS collect FROM platform_ratings WHERE hidden = 0");
      return res.json({
        success: true,
        data: rows.map((r) => ({ id: r.id, checkout_id: r.checkout_id, reference: `FMC-${1000 + Number(r.checkout_id)}`, buyer: r.full_name, email: r.email, delivery_option: r.delivery_option, stars: r.stars, feedback: r.feedback, hidden: Boolean(r.hidden), created_at: r.created_at })),
        summary: { average: avg.avg === null ? null : Number(avg.avg), count: Number(avg.n), transport: n(avg.transport) || 0, collect: n(avg.collect) || 0 },
      });
    }
    const [rows] = await pool.query(
      `SELECT r.*, p.name AS provider_name, c.full_name FROM transport_ratings r
       JOIN transport_providers p ON p.id = r.provider_id
       LEFT JOIN transport_bookings b ON b.id = r.booking_id
       LEFT JOIN checkouts c ON c.id = b.checkout_id
       ORDER BY r.id DESC LIMIT 500`,
    );
    const [[avg]] = await pool.query("SELECT ROUND(AVG(stars), 2) AS avg, COUNT(*) AS n FROM transport_ratings WHERE hidden = 0");
    res.json({
      success: true,
      data: rows.map((r) => ({ id: r.id, booking_id: r.booking_id, reference: core.bookingRef(r.booking_id), provider_id: r.provider_id, provider: r.provider_name, buyer: r.full_name, stars: r.stars, feedback: r.feedback, hidden: Boolean(r.hidden), created_at: r.created_at })),
      summary: { average: avg.avg === null ? null : Number(avg.avg), count: Number(avg.n) },
    });
  } catch (error) {
    next(error);
  }
});

// Hidden feedback stays on record but no longer counts in averages or shows to the provider.
router.patch("/ratings/:type/:id", async (req, res, next) => {
  try {
    const table = req.params.type === "platform" ? "platform_ratings" : req.params.type === "provider" ? "transport_ratings" : null;
    if (!table) throw notFound("Not found.");
    const hidden = req.body.hidden === true || req.body.hidden === "1";
    const [r] = await pool.query(`UPDATE ${table} SET hidden = ? WHERE id = ?`, [hidden ? 1 : 0, positiveInt(req.params.id) || 0]);
    if (!r.affectedRows) throw notFound("Rating not found.");
    res.json({ success: true, message: hidden ? "Hidden. It no longer counts in the averages." : "Shown again." });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
