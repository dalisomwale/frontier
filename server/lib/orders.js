// Shared helpers for "Buy Now" orders.

const ORDER_STATUSES = ["new", "confirmed", "paid", "completed", "cancelled"];
const STATUS_LABELS = {
  new: "New",
  confirmed: "Awaiting payment",
  paid: "Paid",
  completed: "Completed",
  cancelled: "Cancelled",
};
// Stock is taken off the listing once an order is paid, and given back if it
// is cancelled (or moved back) afterwards.
const STOCK_STATUSES = ["paid", "completed"];

const DELIVERY_LABELS = { collect: "Collect from farm", deliver: "Deliver to me" };
const PAYMENT_LABELS = { mobile_money: "Mobile money", bank_transfer: "Bank transfer" };
const OPERATOR_LABELS = { airtel: "Airtel Money", mtn: "MTN Mobile Money", zamtel: "Zamtel Kwacha" };

// "Mobile money (Airtel Money, 0977 123 456)" / "Bank transfer"
function paymentText(order) {
  if (order.payment_method !== "mobile_money") return PAYMENT_LABELS[order.payment_method] || "";
  const parts = [OPERATOR_LABELS[order.mobile_operator], order.payment_phone].filter(Boolean);
  return parts.length ? `Mobile money (${parts.join(", ")})` : "Mobile money";
}

function orderRef(id) {
  return `FM-${1000 + Number(id)}`;
}

// "K 18,500" / "K 18,500.50"
function kwacha(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  return `K ${n.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

// "4 head" / "1 bird" / "200 birds"
function headCount(n, animalName) {
  const count = Number(n) || 0;
  if (animalName === "Poultry") return `${count.toLocaleString("en-US")} ${count === 1 ? "bird" : "birds"}`;
  return `${count.toLocaleString("en-US")} head`;
}

// Reads "FM-1042", "fm1042" or "42" and returns the order id.
function parseOrderRef(value) {
  const match = String(value || "").trim().match(/^(?:fm-?)?(\d+)$/i);
  if (!match) return null;
  const n = Number(match[1]);
  return n > 1000 ? n - 1000 : n;
}

module.exports = {
  ORDER_STATUSES,
  STATUS_LABELS,
  STOCK_STATUSES,
  DELIVERY_LABELS,
  PAYMENT_LABELS,
  OPERATOR_LABELS,
  paymentText,
  orderRef,
  kwacha,
  headCount,
  parseOrderRef,
};
