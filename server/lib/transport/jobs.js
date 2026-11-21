// Transport background checks (run by services/scheduler.js every few minutes):
//
//   1. Paid deliveries nobody has accepted yet are sent again to providers who
//      have become eligible (approved, back in coverage, vehicle free ...).
//   2. A paid delivery still not accepted after the acceptance window: the
//      team is emailed once. The delivery is never cancelled automatically.
//   3. A delivery on the road with no GPS position for a while, or taking
//      much longer than the route should: the team is emailed once (again
//      after the provider's phone is heard from and goes quiet again).
//   4. A delivery waiting for the buyer's confirmation for a day: the buyer
//      is reminded once. A completed delivery not rated after a day: the
//      buyer is reminded once.
const pool = require("../../db");
const core = require("./core");
const notify = require("./notify");
const matching = require("./matching");

const { bookingRef } = core;

async function once(bookingId, event, detail) {
  const [[had]] = await pool.query("SELECT id FROM transport_events WHERE booking_id = ? AND event = ? LIMIT 1", [bookingId, event]);
  if (had) return false;
  await core.logEvent(pool, bookingId, { event, detail });
  return true;
}

async function reoffer() {
  const [rows] = await pool.query(
    `SELECT id FROM transport_bookings
     WHERE status IN ('payment_confirmed', 'awaiting_provider', 'awaiting_reassignment') AND on_hold = 0 AND paid_at IS NOT NULL
     ORDER BY id LIMIT 30`,
  );
  for (const { id } of rows) {
    try {
      await matching.offer(id);
    } catch (error) {
      console.error(`Transport ${bookingRef(id)}: re-offer failed (${error.message})`);
    }
  }
}

async function unaccepted(settings) {
  const [rows] = await pool.query(
    `SELECT * FROM transport_bookings
     WHERE status IN ('payment_confirmed', 'awaiting_provider', 'awaiting_reassignment') AND unaccepted_alert_at IS NULL
       AND paid_at < NOW() - INTERVAL ? MINUTE
     ORDER BY id LIMIT 20`,
    [settings.accept_window_minutes],
  );
  for (const b of rows) {
    const [claim] = await pool.query("UPDATE transport_bookings SET unaccepted_alert_at = NOW() WHERE id = ? AND unaccepted_alert_at IS NULL", [b.id]);
    if (!claim.affectedRows) continue;
    const [[offers]] = await pool.query("SELECT COUNT(*) AS sent, SUM(status = 'declined') AS declined FROM transport_offers WHERE booking_id = ?", [b.id]);
    await core.logEvent(pool, b.id, { event: "unaccepted_alert", detail: `Not accepted ${settings.accept_window_minutes} minutes after payment. Team emailed.` });
    notify.team(b, {
      subject: `Not accepted yet: paid delivery ${bookingRef(b.id)}`,
      heading: "A paid delivery hasn't been accepted",
      paragraphs: [
        `No provider has accepted this delivery ${settings.accept_window_minutes} minutes after it was paid. The request was sent to ${Number(offers.sent) || 0} provider${Number(offers.sent) === 1 ? "" : "s"}${Number(offers.declined) ? `, and ${Number(offers.declined)} declined` : ""}.`,
        "Please assign a provider from the delivery page, or contact the buyer. Nothing has been cancelled.",
      ],
      rows: [["Pickup", b.pickup_label], ["Destination", `${b.dest_district}, ${b.dest_province}`], ["Distance", `${Number(b.distance_km)} km`], ["Load", b.cargo_summary || "-"]],
    });
    notify.live(b, "unaccepted");
  }
}

async function delayed(settings) {
  const stale = settings.gps_stale_minutes;
  const [rows] = await pool.query(
    `SELECT * FROM transport_bookings
     WHERE status IN ('in_transit', 'arrived') AND delay_alert_at IS NULL AND (
       COALESCE(last_location_at, started_at) < NOW() - INTERVAL ? MINUTE
       OR (status = 'in_transit' AND started_at < NOW() - INTERVAL GREATEST(COALESCE(duration_min, 60) * 2, COALESCE(duration_min, 60) + 120) MINUTE)
     )
     ORDER BY id LIMIT 20`,
    [stale],
  );
  for (const b of rows) {
    const [claim] = await pool.query("UPDATE transport_bookings SET delay_alert_at = NOW() WHERE id = ? AND delay_alert_at IS NULL", [b.id]);
    if (!claim.affectedRows) continue;
    const quiet = !b.last_location_at || new Date(b.last_location_at).getTime() < Date.now() - stale * 60 * 1000;
    const why = quiet
      ? `No GPS position from the provider's phone ${b.last_location_at ? `since ${new Date(b.last_location_at).toLocaleString("en-GB", { timeZone: process.env.APP_TIMEZONE || "Africa/Lusaka" })}` : "since the delivery started"}.`
      : `The delivery has taken much longer than the route's estimate of ${b.duration_min || "?"} minutes.`;
    await core.logEvent(pool, b.id, { event: "delay_alert", detail: `${why} Team emailed.` });
    notify.team(b, {
      subject: `Check delivery ${bookingRef(b.id)}: ${quiet ? "no GPS updates" : "running late"}`,
      heading: "A delivery may be delayed",
      paragraphs: [why, "Please contact the provider. The last known position is on the delivery page."],
    });
    require("../../services/notifications").pingAdmins("transport-location", { booking_id: b.id, change: "delay" });
  }
}

async function reminders() {
  const [waiting] = await pool.query(
    "SELECT * FROM transport_bookings WHERE status = 'awaiting_confirmation' AND delivery_submitted_at < NOW() - INTERVAL 24 HOUR ORDER BY id LIMIT 20",
  );
  for (const b of waiting) {
    if (!(await once(b.id, "confirm_reminder", "Buyer reminded to confirm the delivery."))) continue;
    notify.customer(b, {
      title: `Please confirm your delivery (${bookingRef(b.id)})`,
      body: "The provider recorded the delivery yesterday. Please confirm it, or report a problem.",
      subject: `Reminder: please confirm your delivery ${bookingRef(b.id)}`,
      heading: "Please confirm your delivery",
      paragraphs: ["The transport provider recorded your delivery more than a day ago. Please check it in your account and confirm, or report a problem if something isn't right. The order is only completed once you confirm."],
    });
    notify.team(b, { subject: `Buyer hasn't confirmed delivery ${bookingRef(b.id)}`, heading: "A delivery is waiting for the buyer's confirmation", paragraphs: ["The buyer hasn't confirmed or reported a problem a day after delivery. They've been reminded. You may want to call them."] });
  }
  const [unrated] = await pool.query(
    `SELECT b.* FROM transport_bookings b
     WHERE b.status = 'completed' AND b.completed_at < NOW() - INTERVAL 24 HOUR AND b.completed_at > NOW() - INTERVAL 14 DAY AND b.buyer_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM transport_ratings r WHERE r.booking_id = b.id)
     ORDER BY b.id LIMIT 20`,
  );
  for (const b of unrated) {
    if (!(await once(b.id, "rating_reminder", "Buyer reminded to rate the delivery."))) continue;
    notify.customer(b, { title: `How was your delivery? (${bookingRef(b.id)})`, body: "Rate the transport provider and Frontier Marketplace: it takes a minute." });
  }
}

async function tick() {
  const settings = await core.getSettings();
  for (const [name, job] of [["re-offer", reoffer], ["unaccepted", () => unaccepted(settings)], ["delays", () => delayed(settings)], ["reminders", reminders]]) {
    try {
      await job();
    } catch (error) {
      console.error(`Transport ${name}: ${error.message}`);
    }
  }
}

module.exports = { tick, reoffer, unaccepted, delayed, reminders };
