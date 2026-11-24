// A seller's pickup point: where transport providers collect their goods.
// One check for every place it is set: the seller's registration and profile,
// and the admin's Add / Edit Seller and Transport pages.
//
//   readPickup(body, province, { required })
//     -> { errors, pickup }   pickup: { district, address, lat, lng }, or null
//        when nothing was given and it isn't required.
const { text } = require("../validate");
const core = require("./core");
const zambia = require("../../../public/js/zambia-districts");

const inZambia = (p) => p.lat >= -18.2 && p.lat <= -8.1 && p.lng >= 21.8 && p.lng <= 33.8;

function readPickup(body = {}, province = null, { required = false, who = "seller" } = {}) {
  const district = text(body.pickup_district, 80);
  const address = text(body.pickup_address, 255);
  const point = core.point(body.pickup_lat, body.pickup_lng);
  const errors = {};
  // Optional and left empty: no pickup point (it can be added later).
  if (!required && !district && !address && !point) return { errors, pickup: null };
  const yours = who === "seller" ? "your" : "the seller's";
  if (!district || district.length < 2) errors.pickup_district = "Please choose the district.";
  else if (province && zambia.list(province).length && !zambia.match(province, district)) {
    errors.pickup_district = `Please choose one of ${province} Province's districts (${yours} province).`;
  } else if (!zambia.provinceOf(district)) errors.pickup_district = "Please choose a district from the list.";
  if (!address || address.length < 3) errors.pickup_address = "Please enter the address or directions to the pickup point.";
  if (!point) errors.pickup_point = "Please mark the pickup point on the map.";
  else if (!inZambia(point)) errors.pickup_point = "The pickup point must be in Zambia.";
  if (Object.keys(errors).length) return { errors, pickup: null };
  const clean = zambia.match(province, district) || zambia.match(zambia.provinceOf(district), district) || district;
  return { errors, pickup: { district: clean, address, lat: point.lat, lng: point.lng } };
}

module.exports = { readPickup, inZambia };
