// Zambian mobile money numbers: which network a number belongs to.
//
//   Airtel Money   097, 077, 057
//   MTN MoMo       096, 076, 056
//   Zamtel         095, 075, 055 (not taken: only Airtel and MTN are offered)
//
// Accepts 0977 123 456, 977123456, +260 977 123 456 or 260977123456.
const PREFIXES = {
  airtel: ["097", "077", "057"],
  mtn: ["096", "076", "056"],
};
const ZAMTEL = ["095", "075", "055"];
const NAMES = { airtel: "Airtel Money", mtn: "MTN MoMo" };

// "+260 977 123 456" -> "0977123456"; anything else -> null.
function localNumber(phone) {
  const d = String(phone || "").replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("260")) return `0${d.slice(3)}`;
  if (d.length === 10 && d.startsWith("0")) return d;
  if (d.length === 9 && !d.startsWith("0")) return `0${d}`;
  return null;
}

function networkOf(phone) {
  const local = localNumber(phone);
  if (!local) return null;
  return Object.keys(PREFIXES).find((op) => PREFIXES[op].includes(local.slice(0, 3))) || null;
}

// Error message, or "" when the number fits the chosen network.
function checkNumber(phone, operator) {
  const local = localNumber(phone);
  if (!local) return "Please enter a 10-digit mobile money number, e.g. 0977 123 456.";
  const net = networkOf(local);
  if (!net && ZAMTEL.includes(local.slice(0, 3))) return "Zamtel isn't available. Please use an Airtel or MTN number.";
  if (!net) return "Please use an Airtel or MTN number (097, 077, 057, 096, 076 or 056).";
  if (operator && net !== operator) {
    return `This number looks like ${NAMES[net]}. Choose ${NAMES[net]} or use another number.`;
  }
  return "";
}

module.exports = { PREFIXES, NAMES, localNumber, networkOf, checkNumber };
