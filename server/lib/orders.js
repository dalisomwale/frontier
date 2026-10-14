// Shared helpers for "Buy Now" orders.

const ORDER_STATUSES = ["new", "confirmed", "paid", "completed", "cancelled"];
const STATUS_LABELS = {
  new: "New",
  confirmed: "Awaiting payment",
  paid: "Paid",
  completed: "Completed",
  cancelled: "Cancelled",
};
// Stock comes off the listing when the order is placed, and goes back if the
// order is cancelled (and off again if it is reopened).
const STOCK_STATUSES = ["new", "confirmed", "paid", "completed"];

const DELIVERY_LABELS = { collect: "Collect from farm", deliver: "Deliver to me" };
const PAYMENT_LABELS = { mobile_money: "Mobile money", bank_transfer: "Bank transfer", card: "Card" };
const CARD_LABELS = { visa: "Visa", mastercard: "Mastercard" };
// Banks offered at checkout; "Other bank" lets the buyer type the name.
const BANKS = ["Zanaco", "Stanbic Bank", "Absa Bank", "FNB Zambia", "Access Bank", "Standard Chartered", "Indo Zambia Bank", "Ecobank"];
const OPERATOR_LABELS = { airtel: "Airtel Money", mtn: "MTN Mobile Money", zamtel: "Zamtel Kwacha" };

// "Mobile money (Airtel Money, 0977 123 456)" / "Bank transfer"
function paymentText(order) {
  if (order.payment_method === "card") {
    const brand = CARD_LABELS[order.card_brand] || "Card";
    return order.card_last4 ? `${brand} card ending ${order.card_last4}` : `${brand} card`;
  }
  if (order.payment_method === "bank_transfer") {
    const parts = [order.payment_bank, order.payment_account ? `account ${order.payment_account}` : null].filter(Boolean);
    return parts.length ? `Bank transfer (${parts.join(", ")})` : "Bank transfer";
  }
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
  CARD_LABELS,
  BANKS,
  paymentText,
  orderRef,
  kwacha,
  headCount,
  parseOrderRef,
};
