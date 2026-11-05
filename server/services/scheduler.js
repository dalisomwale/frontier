// Background jobs, checked every few minutes while the app runs:
//
// 1. Payment reminders: a website mobile money payment that failed (or never
//    finished) and is still unpaid 30 minutes after the order. The buyer gets
//    "Your payment didn't go through" with a link to try again, and the team
//    gets "Unpaid order". Sent once per order.
//
// 2. Morning summary for the team (DAILY_SUMMARY_TIME, default 07:30, in
//    APP_TIMEZONE). Sent once a day, only when something needs attention.
//    Turn it off with DAILY_SUMMARY=off.
const pool = require("../db");
const emails = require("../lib/emails");
const payments = require("../lib/payments");

const EVERY_MS = 5 * 60 * 1000;
const REMINDER_AFTER_MIN = 30;

async function paymentReminders() {
  const [rows] = await pool.query(
    `SELECT * FROM orders
     WHERE payment_method = 'mobile_money' AND payment_attempts > 0 AND public_token IS NOT NULL
       AND payment_status IN ('failed', 'pending') AND payment_reminder_at IS NULL
       AND status IN ('new', 'confirmed') AND checkout_id IS NULL
       AND created_at < NOW() - INTERVAL ? MINUTE
     ORDER BY id LIMIT 20`,
    [REMINDER_AFTER_MIN],
  );
  for (let order of rows) {
    // A pending payment may have finished: ask Lenco first.
    if (order.payment_status === "pending") order = await payments.refresh({ ...order, payment_checked_at: null });
    if (!order || order.payment_status === "paid") continue;
    const [result] = await pool.query(
      "UPDATE orders SET payment_reminder_at = NOW() WHERE id = ? AND payment_reminder_at IS NULL",
      [order.id],
    );
    if (!result.affectedRows) continue;
    await emails.paymentReminder(order);
    await emails.unpaidOrder(order);
  }
  // Cart checkouts are reminded as a whole (lib/checkout.js).
  await require("../lib/checkout").sendReminders(REMINDER_AFTER_MIN);
}

function localNow() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: process.env.APP_TIMEZONE || "Africa/Lusaka",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type).value;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

async function summaryStats() {
  const one = async (sql) => Number((await pool.query(sql))[0][0].n) || 0;
  return {
    newOrders: await one("SELECT COUNT(*) AS n FROM orders WHERE created_at >= NOW() - INTERVAL 24 HOUR"),
    unpaidOrders: await one("SELECT COUNT(*) AS n FROM orders WHERE created_at >= NOW() - INTERVAL 24 HOUR AND status IN ('new', 'confirmed') AND payment_status <> 'paid'"),
    openOrders: await one("SELECT COUNT(*) AS n FROM orders WHERE status IN ('new', 'confirmed', 'paid')"),
    openInquiries: await one("SELECT COUNT(*) AS n FROM inquiries WHERE status = 'new'"),
    pendingListings: await one("SELECT COUNT(*) AS n FROM livestock WHERE review_status = 'pending'"),
    pendingSellers: await one("SELECT COUNT(*) AS n FROM sellers WHERE account_status = 'pending'"),
    paidYesterday: Number((await pool.query("SELECT COALESCE(SUM(total), 0) AS n FROM orders WHERE payment_status = 'paid' AND paid_at >= CURDATE() - INTERVAL 1 DAY AND paid_at < CURDATE()"))[0][0].n) || 0,
  };
}

async function dailySummary({ force = false } = {}) {
  if (!force && String(process.env.DAILY_SUMMARY || "on").toLowerCase() === "off") return null;
  const [h, m] = String(process.env.DAILY_SUMMARY_TIME || "07:30").split(":").map(Number);
  const now = localNow();
  if (!force && now.minutes < (h || 0) * 60 + (m || 0)) return null;
  // Claim today's summary in one step, so two app processes can't both send it.
  await pool.query("INSERT IGNORE INTO app_state (name, value) VALUES ('daily_summary_date', NULL)");
  const [claim] = await pool.query(
    "UPDATE app_state SET value = ? WHERE name = 'daily_summary_date' AND (value IS NULL OR value <> ?)",
    [now.date, now.date],
  );
  if (!claim.affectedRows && !force) return null;
  const stats = await summaryStats();
  const needsAttention = stats.newOrders || stats.openOrders || stats.openInquiries || stats.pendingListings || stats.pendingSellers;
  if (!needsAttention) return null;
  return emails.dailySummary(stats);
}

async function tick() {
  try {
    await paymentReminders();
  } catch (error) {
    console.error(`Payment reminders: ${error.message}`);
  }
  try {
    await dailySummary();
  } catch (error) {
    console.error(`Daily summary: ${error.message}`);
  }
}

function start() {
  setTimeout(tick, 30 * 1000).unref();
  setInterval(tick, EVERY_MS).unref();
}

module.exports = { start, tick, paymentReminders, dailySummary, summaryStats };
