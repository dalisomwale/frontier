// Zambian mobile money numbers: which network a number belongs to.
//
//   Airtel Money   097, 077, 057
//   MTN MoMo       096, 076, 056
//   Zamtel Kwacha  095, 075, 055
//
// Accepts 0977 123 456, 977123456, +260 977 123 456 or 260977123456.
const PREFIXES = {
  airtel: ["097", "077", "057"],
  mtn: ["096", "076", "056"],
  zamtel: ["095", "075", "055"],
};
const NAMES = { airtel: "Airtel Money", mtn: "MTN MoMo", zamtel: "Zamtel Kwacha" };

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
  if (!net) return "That isn't a Zambian mobile money number. Numbers start with 097, 096, 095, 077, 076, 075, 057, 056 or 055.";
  if (operator && net !== operator) {
    return `${NAMES[operator]} numbers start with ${PREFIXES[operator].join(", ")}. This number looks like ${NAMES[net]}: choose ${NAMES[net]} or enter a different number.`;
  }
  return "";
}

module.exports = { PREFIXES, NAMES, localNumber, networkOf, checkNumber };
