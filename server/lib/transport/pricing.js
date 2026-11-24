// Transport at checkout: where the goods are picked up, how far they travel
// by road, and what that costs under Frontier's price bands.
//
// A cart is split by pickup point: one journey (and later one booking) per
// seller, from that seller's pickup point to the buyer's destination. Frontier's
// own stock is picked up from Frontier's pickup point (Admin > Transport
// pricing). Journeys are never combined: each one is priced and carried on
// its own.
//
// Nothing the browser sends is trusted: the server works out every distance
// and fee itself, both for the quote and again when the order is placed.
const pool = require("../../db");
const routing = require("../../services/routing");
const core = require("./core");
const matching = require("./matching");
const { PROVINCES, text, isPhone } = require("../validate");
const zambia = require("../../../public/js/zambia-districts");
const where = (pk) => core.placeText(pk.address, pk.district, pk.province) || "the pickup point";

// Roughly Zambia, with a margin: a pin far outside is a mistake.
const ZAMBIA = { minLat: -18.3, maxLat: -8.0, minLng: 21.8, maxLng: 33.9 };
function inZambia(p) {
  return p && p.lat >= ZAMBIA.minLat && p.lat <= ZAMBIA.maxLat && p.lng >= ZAMBIA.minLng && p.lng <= ZAMBIA.maxLng;
}

// The buyer's delivery details from the checkout form.
function cleanDestination(body = {}) {
  const province = text(body.dest_province, 50);
  const district = text(body.dest_district, 80);
  const address = text(body.dest_address, 255);
  const notes = text(body.dest_notes, 255);
  const contactName = text(body.contact_name, 120);
  const contactPhone = text(body.contact_phone, 30);
  const point = core.point(body.dest_lat, body.dest_lng);
  const errors = {};
  if (!province || !PROVINCES.includes(province)) errors.dest_province = "Please choose the province.";
  if (!district || district.length < 2) errors.dest_district = district === undefined ? "District must be 80 characters or fewer." : "Please choose the district.";
  else if (province && PROVINCES.includes(province) && !zambia.match(province, district)) errors.dest_district = `Please choose one of ${province} Province's districts.`;
  if (!address || address.length < 3) errors.dest_address = address === undefined ? "Address must be 255 characters or fewer." : "Please enter the delivery address or directions.";
  if (notes === undefined) errors.dest_notes = "Notes must be 255 characters or fewer.";
  if (!point) errors.dest_point = "Please mark the delivery point on the map.";
  else if (!inZambia(point)) errors.dest_point = "The delivery point must be in Zambia.";
  if (!contactName || contactName.length < 2) errors.contact_name = "Please enter the name of the person receiving the delivery.";
  if (!contactPhone || !isPhone(contactPhone)) errors.contact_phone = "Please enter a valid phone number, e.g. 0977 123 456.";
  return {
    errors,
    dest: { province, district: (province && zambia.match(province, district)) || district, address, notes: notes || null, lat: point && point.lat, lng: point && point.lng, contact_name: contactName, contact_phone: contactPhone },
  };
}

// Where a seller's goods are picked up. null when it hasn't been set.
async function pickupFor(sellerId, settings, conn = pool) {
  if (!sellerId) {
    const fp = settings.frontier_pickup;
    const p = core.point(fp.lat, fp.lng);
    if (!p) return null;
    return { label: fp.label, address: fp.address || null, district: fp.district || null, province: fp.province || null, phone: fp.phone || null, ...p };
  }
  const [[s]] = await conn.query(
    "SELECT id, name, business_name, phone, province, address, pickup_district, pickup_address, pickup_lat, pickup_lng FROM sellers WHERE id = ?",
    [sellerId],
  );
  if (!s) return null;
  const p = core.point(s.pickup_lat, s.pickup_lng);
  if (!p) return null;
  return {
    label: s.business_name ? `${s.business_name} (${s.name})` : s.name,
    address: s.pickup_address || s.address || null,
    district: s.pickup_district || null,
    province: s.province || null,
    phone: s.phone || null,
    ...p,
  };
}

const sellerLabelOf = (item) => item.seller_label || "Frontier Farms";

// Why transport can't be offered at all right now (shown to the buyer), or null.
async function unavailableReason() {
  const settings = await core.getSettings();
  if (!settings.enabled) return { reason: "Transport isn't available at the moment. Please choose self-collection.", settings };
  if (!routing.enabled()) return { reason: "Transport isn't available at the moment. Please choose self-collection.", admin: routing.problem(), settings };
  const bands = await core.activeBands();
  if (!bands.length) return { reason: "Transport isn't available at the moment. Please choose self-collection.", admin: "No active transport price bands.", settings };
  return { reason: null, settings, bands };
}

// Prices transport for priced cart items (from checkout.quote: available
// items with seller_id, animal_id, animal_kind, quantity) to `dest`.
// Returns { available, reason, groups, transport_total }; each group is one
// journey: { seller_id, seller_label, pickup, distance_km, fee, ... , problem }.
// checkProviders: also checks that at least one provider could take it now.
// size: the vehicle size the buyer chose (small ... extra_large); when it isn't
// given or can't be had, the smallest size that every journey can have is used.
async function plan(items, dest, { checkProviders = true, size = null } = {}) {
  const base = await unavailableReason();
  if (base.reason) return { available: false, reason: base.reason, admin_reason: base.admin || null, groups: [], transport_total: 0 };
  const { settings, bands } = base;
  const destPoint = { lat: Number(dest.lat), lng: Number(dest.lng) };
  const bySeller = new Map();
  for (const it of items) {
    const key = it.seller_id ? Number(it.seller_id) : 0;
    if (!bySeller.has(key)) bySeller.set(key, { seller_id: key || null, seller_label: sellerLabelOf(it), items: [] });
    bySeller.get(key).items.push(it);
  }
  const groups = [];
  for (const g of bySeller.values()) {
    const out = { ...g, pickup: null, distance_km: null, duration_min: null, geometry: null, routing_provider: null, band: null, fee: null, commission: null, earning: null, load: core.loadOf(g.items), cargo_summary: "", providers: null, problem: null };
    groups.push(out);
    out.pickup = await pickupFor(g.seller_id, settings);
    if (!out.pickup) {
      out.problem = g.seller_id
        ? `${g.seller_label} hasn't set a pickup point for transport yet.`
        : "Frontier's pickup point for transport hasn't been set yet.";
      continue;
    }
    if (!Object.keys(out.load).length) {
      out.problem = "These items can't be carried by our transport providers.";
      continue;
    }
    let r;
    try {
      r = await routing.route(out.pickup, destPoint);
    } catch (error) {
      out.problem = error.noRoute
        ? `There's no road route from ${where(out.pickup)} to the delivery point.`
        : "We couldn't work out the road distance just now. Please try again in a moment.";
      out.routing_error = error.message;
      continue;
    }
    out.distance_km = r.km;
    out.duration_min = r.minutes;
    out.geometry = r.geometry;
    out.routing_provider = r.provider;
    const price = core.priceFor(r.km, bands, settings.commission_pct);
    if (!price) {
      out.problem = `Transport isn't priced for a ${r.km} km journey. Please choose self-collection or contact us.`;
      continue;
    }
    out.band = price.band;
    out.fee = price.fee;
    out.commission = price.commission;
    out.earning = price.earning;
    out.commission_pct = settings.commission_pct;
  }
  const labels = await core.cargoLabels();
  groups.forEach((g) => { g.cargo_summary = core.loadText(g.load, labels); });
  if (checkProviders) {
    for (const g of groups.filter((x) => !x.problem)) {
      const found = await matching.assess(pool, { pickup: g.pickup, dest: destPoint, load: g.load });
      const eligible = found.filter((x) => x.eligible);
      g.providers = eligible.length;
      // Vehicle sizes a provider covering this journey has free, able to carry the load.
      g.sizes = [...new Set(eligible.flatMap((x) => x.sizes || []))];
      if (found.some((x) => x.reasons.some((rr) => rr.startsWith("Road distance unavailable")))) {
        g.problem = "We couldn't check which transport providers are free just now. Please try again in a moment.";
      } else if (!g.providers || !g.sizes.length) {
        g.problem = `No transport provider covers the journey from ${where(g.pickup)} to your delivery point with a suitable vehicle right now. Please choose self-collection or contact us.`;
      }
    }
  }
  // Sizes the whole order can have (one size for every journey), and the size used.
  const priced = groups.filter((g) => !g.problem);
  const possible = checkProviders
    ? core.SIZE_KEYS.filter((k) => priced.length && priced.every((g) => (g.sizes || []).includes(k)))
    : [...core.SIZE_KEYS];
  if (checkProviders && priced.length === groups.length && groups.length && !possible.length) {
    groups[0].problem = "There isn't one vehicle size that can collect from every seller in your cart right now. Please order from one seller at a time, or choose self-collection.";
  }
  const chosen = possible.includes(size) ? size : possible[0] || null;
  const pctOf = (k) => settings.size_pct[k] || 100;
  for (const g of groups.filter((x) => !x.problem && x.distance_km !== null)) {
    const p = core.priceFor(g.distance_km, bands, settings.commission_pct, chosen ? pctOf(chosen) : 100);
    Object.assign(g, { fee: p.fee, commission: p.commission, earning: p.earning, size_pct: chosen ? pctOf(chosen) : 100 });
  }
  const ok = groups.length > 0 && groups.every((g) => !g.problem);
  const totalFor = (k) => core.round2(priced.reduce((s, g) => s + core.priceFor(g.distance_km, bands, settings.commission_pct, pctOf(k)).fee, 0));
  return {
    available: ok,
    reason: ok ? null : (groups.find((g) => g.problem) || {}).problem || "Transport isn't available for this cart.",
    groups,
    vehicle_size: ok ? chosen : null,
    size_options: core.SIZES.map((x) => ({
      ...x,
      available: ok && possible.includes(x.key),
      fee_total: ok && possible.includes(x.key) ? totalFor(x.key) : null,
    })),
    transport_total: ok ? core.round2(groups.reduce((s, g) => s + g.fee, 0)) : 0,
  };
}

// What the buyer's browser is shown: no pickup addresses or coordinates.
function publicPlan(p) {
  return {
    available: p.available,
    reason: p.reason,
    transport_total: p.transport_total,
    vehicle_size: p.vehicle_size || null,
    size_options: p.size_options || [],
    journeys: p.groups.map((g) => ({
      seller: g.seller_label,
      from: g.pickup ? where(g.pickup) : null,
      items: g.items.map((i) => i.title),
      distance_km: g.distance_km,
      duration_min: g.duration_min,
      band: g.band ? g.band.label : null,
      fee: g.fee,
      problem: g.problem,
    })),
  };
}

module.exports = { cleanDestination, pickupFor, plan, publicPlan, unavailableReason, inZambia };
