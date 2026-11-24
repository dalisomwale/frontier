// Which transport providers can take a delivery, and sending them the request.
//
// A provider is eligible when, at that moment:
//   1. Frontier approved them and their account is active;
//   2. they are available (their own on/off switch);
//   3. Frontier has switched their coverage on, and both the pickup point and
//      the destination are within their coverage distance of their operating
//      location, by road;
//   4. they have an active vehicle that isn't on another delivery and can
//      carry this load (cargo kinds and capacity).
// The coverage distance is set by Frontier only (Admin > Transport providers).
const pool = require("../../db");
const routing = require("../../services/routing");
const core = require("./core");
const notify = require("./notify");
const { kwacha } = require("../orders");

// Providers with their free vehicles and what each vehicle carries.
async function providersWithVehicles(conn, { providerIds = null, excludeBooking = 0 } = {}) {
  const [providers] = await conn.query(
    `SELECT * FROM transport_providers ${providerIds ? "WHERE id IN (?)" : ""} ORDER BY id`,
    providerIds ? [providerIds.length ? providerIds : [0]] : [],
  );
  if (!providers.length) return [];
  const [vehicles] = await conn.query(
    `SELECT v.*, EXISTS (SELECT 1 FROM transport_bookings b WHERE b.vehicle_id = v.id AND b.id <> ? AND b.status IN (?)) AS busy
     FROM transport_vehicles v WHERE v.provider_id IN (?)`,
    [excludeBooking, core.VEHICLE_BUSY, providers.map((p) => p.id)],
  );
  const [cargo] = vehicles.length
    ? await conn.query("SELECT * FROM transport_vehicle_cargo WHERE vehicle_id IN (?)", [vehicles.map((v) => v.id)])
    : [[]];
  const cargoOf = new Map();
  cargo.forEach((c) => {
    if (!cargoOf.has(c.vehicle_id)) cargoOf.set(c.vehicle_id, {});
    cargoOf.get(c.vehicle_id)[c.cargo_key] = Number(c.max_quantity);
  });
  return providers.map((p) => ({
    ...p,
    vehicles: vehicles.filter((v) => v.provider_id === p.id).map((v) => ({ ...v, busy: Boolean(v.busy), cargo: cargoOf.get(v.id) || {} })),
  }));
}

// Every provider with the reasons they can't take this delivery (none =
// eligible). job: { pickup: {lat,lng}, dest: {lat,lng}, load: {key: qty} }.
// Road distances from each provider's operating location come from the
// routing service; when it can't answer, nobody is marked eligible.
async function assess(conn, job, { providerIds = null, excludeBooking = 0 } = {}) {
  const list = await providersWithVehicles(conn, { providerIds, excludeBooking });
  const out = list.map((p) => {
    const reasons = [];
    if (p.status !== "approved") reasons.push(p.status === "pending" ? "Not approved yet" : p.status === "suspended" ? "Suspended" : "Not approved");
    if (!p.is_active) reasons.push("Deactivated by Frontier");
    if (!p.is_available) reasons.push("Marked unavailable");
    if (!p.coverage_active || !(Number(p.coverage_km) > 0)) reasons.push("Coverage not set or switched off by Frontier");
    if (!core.point(p.base_lat, p.base_lng)) reasons.push("No operating location");
    const active = p.vehicles.filter((v) => v.status === "active");
    const suitable = active.filter((v) => core.vehicleFits(v.cargo, job.load));
    const freeAny = suitable.filter((v) => !v.busy);
    // The vehicle size the buyer chose (D: vehicle sizes): only vehicles of that size count.
    const free = job.size ? freeAny.filter((v) => v.size_class === job.size) : freeAny;
    if (!active.length) reasons.push("No active vehicle");
    else if (!suitable.length) reasons.push("No vehicle that can carry this load");
    else if (!freeAny.length) reasons.push("Suitable vehicles are on other deliveries");
    else if (!free.length) reasons.push(`No free ${core.sizeLabel(job.size) || job.size} vehicle that can carry this load`);
    return {
      provider: p,
      vehicles: free,
      // Sizes of this provider's free vehicles that can carry the load (for the checkout's choice).
      sizes: [...new Set(freeAny.map((v) => v.size_class).filter(Boolean))],
      pickup_km: null,
      dest_km: null,
      reasons,
    };
  });
  // Road distance only for those otherwise eligible.
  const check = out.filter((x) => !x.reasons.length);
  if (check.length) {
    let km = null;
    let failure = null;
    try {
      km = await routing.matrix(check.map((x) => core.point(x.provider.base_lat, x.provider.base_lng)), [job.pickup, job.dest]);
    } catch (error) {
      failure = error.message;
    }
    check.forEach((x, i) => {
      if (!km) {
        x.reasons.push(`Road distance unavailable (${failure})`);
        return;
      }
      const [toPickup, toDest] = km[i];
      x.pickup_km = toPickup;
      x.dest_km = toDest;
      const cover = Number(x.provider.coverage_km);
      if (toPickup === null) x.reasons.push("No road route to the pickup point");
      else if (toPickup > cover) x.reasons.push(`Pickup is ${toPickup} km away; coverage is ${cover} km`);
      if (toDest === null) x.reasons.push("No road route to the destination");
      else if (toDest > cover) x.reasons.push(`Destination is ${toDest} km away; coverage is ${cover} km`);
    });
  }
  return out.map((x) => ({ ...x, eligible: !x.reasons.length }));
}

const eligibleOnly = async (conn, job, opts) => (await assess(conn, job, opts)).filter((x) => x.eligible);

async function jobOf(conn, booking) {
  const orders = (await core.bookingOrders(conn, booking.id)).filter((o) => o.status !== "cancelled");
  return {
    orders,
    job: {
      pickup: core.point(booking.pickup_lat, booking.pickup_lng),
      dest: core.point(booking.dest_lat, booking.dest_lng),
      load: core.loadOf(orders),
      size: booking.vehicle_size || null,
    },
  };
}

// Sends the request to every eligible provider who hasn't had it yet, and
// moves the booking on: Awaiting provider acceptance when someone has it,
// Awaiting reassignment (and the team is told) when nobody can take it.
// Safe to run again (the scheduler does, for new or newly free providers).
async function offer(bookingId, { actor = "system", actorName = null } = {}) {
  let sent = [];
  let booking = null;
  let none = false;
  let routeError = null;
  const OPEN = ["payment_confirmed", "awaiting_provider", "awaiting_reassignment"];
  const [[b0]] = await pool.query("SELECT * FROM transport_bookings WHERE id = ?", [bookingId]);
  if (!b0 || !OPEN.includes(b0.status) || b0.on_hold) return { sent: [] };
  // Road distances are looked up before the booking is locked, so a slow
  // routing service never holds up a provider accepting.
  const { job } = await jobOf(pool, b0);
  const all = await assess(pool, job, { excludeBooking: b0.id });
  await core.withBooking(bookingId, async (conn, b) => {
    booking = b;
    if (!OPEN.includes(b.status) || b.on_hold) return;
    if (all.some((x) => x.reasons.some((r) => r.startsWith("Road distance unavailable")))) {
      routeError = all.find((x) => x.reasons.some((r) => r.startsWith("Road distance unavailable"))).reasons.find((r) => r.startsWith("Road distance"));
    }
    const eligible = all.filter((x) => x.eligible);
    const [had] = await conn.query("SELECT provider_id, status FROM transport_offers WHERE booking_id = ?", [b.id]);
    const before = new Map(had.map((o) => [o.provider_id, o.status]));
    // Providers who haven't had it, or whose offer was only withdrawn because
    // someone else accepted (the delivery is open again). Never those who
    // declined or were taken off it.
    const fresh = eligible.filter((x) => !before.has(x.provider.id) || before.get(x.provider.id) === "withdrawn");
    for (const x of fresh) {
      await conn.query(
        `INSERT INTO transport_offers (booking_id, provider_id, pickup_km, dest_km) VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE status = 'offered', reason = NULL, responded_at = NULL, offered_at = NOW(), pickup_km = VALUES(pickup_km), dest_km = VALUES(dest_km)`,
        [b.id, x.provider.id, x.pickup_km, x.dest_km],
      );
    }
    sent = fresh.map((x) => x.provider.id);
    const open = had.filter((o) => o.status === "offered").length + fresh.length;
    if (fresh.length) {
      await core.logEvent(conn, b.id, { event: "offers_sent", actor, actorName, detail: `Request sent to ${fresh.length} eligible provider${fresh.length === 1 ? "" : "s"}: ${fresh.map((x) => x.provider.name).join(", ")}.` });
    }
    if (open && b.status !== "awaiting_provider") {
      await core.transition(conn, b, "awaiting_provider", { event: "awaiting_provider", actor, actorName, detail: "Waiting for a provider to accept.", set: { offers_sent_at: { raw: "NOW()" } } });
    } else if (open && fresh.length) {
      await conn.query("UPDATE transport_bookings SET offers_sent_at = COALESCE(offers_sent_at, NOW()) WHERE id = ?", [b.id]);
    } else if (!open && b.status !== "awaiting_reassignment" && !routeError) {
      none = true;
      await core.transition(conn, b, "awaiting_reassignment", {
        event: "no_provider", actor, actorName,
        detail: `No eligible provider right now. ${all.length ? all.map((x) => `${x.provider.name}: ${x.reasons.join("; ")}`).join(" | ").slice(0, 700) : "No providers registered."}`,
      });
    } else if (routeError && b.status === "payment_confirmed") {
      await core.logEvent(conn, b.id, { event: "routing_error", actor: "system", detail: `Could not check providers: ${routeError}. Will try again.` });
    }
  });
  if (!booking) return { sent: [] };
  if (sent.length) {
    const [[b]] = await pool.query("SELECT * FROM transport_bookings WHERE id = ?", [bookingId]);
    for (const id of sent) {
      notify.provider(id, b, {
        title: `New delivery request ${core.bookingRef(b.id)}`,
        body: `${core.pickupPlace(b)} → ${core.destPlace(b)} · ${Number(b.distance_km)} km · ${b.cargo_summary || ""}`.trim(),
        subject: `New delivery request ${core.bookingRef(b.id)}: ${Number(b.distance_km)} km`,
        heading: "A new delivery request for you",
        paragraphs: ["A paid delivery is waiting for a transport provider. The first provider to accept it gets it. Open your dashboard to see the details and choose the vehicle."],
        rows: [
          ["Pickup", core.pickupPlace(b)],
          ["Destination", core.destPlace(b)],
          ["Road distance", `${Number(b.distance_km)} km`],
          ["Load", b.cargo_summary || "-"],
          ["Your earning", kwacha(b.provider_earning)],
        ],
      });
    }
    notify.live(b, "offers");
  }
  if (none) {
    const [[b]] = await pool.query("SELECT * FROM transport_bookings WHERE id = ?", [bookingId]);
    notify.team(b, {
      subject: `No transport provider for ${core.bookingRef(b.id)}`,
      heading: "A paid delivery has no eligible provider",
      paragraphs: ["No approved, available provider covers this pickup and destination with a suitable free vehicle. Please assign a provider from the delivery page, or contact the buyer. The request has not been cancelled."],
      rows: [["Pickup", `${b.pickup_label}, ${core.pickupPlace(b)}`], ["Destination", core.destPlace(b)], ["Distance", `${Number(b.distance_km)} km`], ["Load", b.cargo_summary || "-"]],
    });
    notify.live(b, "no_provider");
  }
  return { sent, none, routeError };
}

module.exports = { assess, eligibleOnly, offer, jobOf, providersWithVehicles };
