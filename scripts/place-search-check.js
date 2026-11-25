#!/usr/bin/env node
// Checks place search for the maps (the address -> pin lookup at checkout).
//
//   npm run maps:check                 searches "Kabulonga, Lusaka"
//   npm run maps:check -- "Cairo Road"  searches what you give it
//
// Shows which geocoder .env sets up and its real answer or error, then the
// two OpenStreetMap backups. Nothing is changed.
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const routing = require("../server/services/routing");

const q = process.argv.slice(2).join(" ").trim() || "Kabulonga, Lusaka";
const show = (rows) => (rows.length ? rows.slice(0, 4).map((r) => `    ${r.label}  (${r.lat}, ${r.lng})`).join("\n") : "    (nothing found)");

(async () => {
  const name = routing.geocoderName();
  console.log(`Searching: "${q}"\n`);
  console.log(`Main geocoder: ${name === "photon" || !name ? "none set up (ROUTING_PROVIDER ors/google, or NOMINATIM_URL)" : name}`);
  if (name && name !== "photon") {
    const saved = process.env.PLACE_SEARCH_FALLBACK;
    process.env.PLACE_SEARCH_FALLBACK = "off";
    try {
      console.log(show(await routing.geocode(q, { strict: true })));
    } catch (error) {
      console.log(`    FAILED: ${error.message}`);
      if (name === "google") console.log("    Tip: enable the Geocoding API for this key in Google Cloud Console (APIs & Services > Library).");
      if (name === "ors") console.log("    Tip: check ORS_API_KEY and its daily quota at openrouteservice.org (Dashboard).");
    }
    process.env.PLACE_SEARCH_FALLBACK = saved;
  }
  for (const [label, fn] of [["OpenStreetMap backup 1 (Photon)", routing.photon], ["OpenStreetMap backup 2 (Nominatim)", routing.osmSearch]]) {
    console.log(`\n${label}:`);
    try {
      console.log(show(await fn(q)));
    } catch (error) {
      console.log(`    FAILED: ${error.message}`);
    }
  }
  console.log(/^(off|0|false|no)$/i.test(String(process.env.PLACE_SEARCH_FALLBACK || "")) ? "\nThe backup is OFF (PLACE_SEARCH_FALLBACK)." : "\nThe backup is on: it answers whenever the main geocoder fails or finds nothing.");
})();
