#!/usr/bin/env node
// End-to-end check of transport: seller pickup points (registration, admin add/edit), the
// admin adding and editing transport providers, their papers and vehicles, vehicle sizes
// (checkout choice, price, matching, accepting) and the payment page's delivery tracker.
//
//   DB_HOST=127.0.0.1 DB_PORT=3306 DB_USER=... DB_PASSWORD=... DB_NAME=frontier_test npm run test:transport
//
// Runs the real app against a TEST database (its name must end in "_test"; run
// `npm run db:setup` against it first). Only the road-distance service and Lipila are stood in
// for, so nothing leaves the machine and no money moves.
const path = require("path");

if (!/_test$/.test(process.env.DB_NAME || "")) {
  console.error('Refusing to run: DB_NAME must end in "_test" (this test adds and changes data).');
  process.exit(1);
}
Object.assign(process.env, {
  NODE_ENV: "test",
  SESSION_SECRET: process.env.SESSION_SECRET || "test-only-session-secret-0123456789-abcdef",
  APP_URL: "http://localhost",
  LIPILA_API_KEY: "test-key",
  LIPILA_ENV: "sandbox",
  ROUTING_PROVIDER: "osrm",
  OSRM_URL: "http://routing.test",
  SMTP_HOST: "",
});
const root = path.join(__dirname, "..");
const R = (p) => require(path.join(root, p));

// Road distances: straight line × 1.3 (a stand-in for the routing service).
const routing = R("server/services/routing.js");
const km = (a, b) => {
  const toR = (d) => (d * Math.PI) / 180;
  const dLat = toR(b.lat - a.lat);
  const dLng = toR(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * 6371 * Math.asin(Math.sqrt(h)) * 1.3 * 100) / 100;
};
Object.assign(routing, {
  enabled: () => true,
  provider: () => "osrm",
  problem: () => null,
  geocoderName: () => null,
  geocode: async () => [],
  route: async (a, b) => ({ km: km(a, b), minutes: Math.round(km(a, b)), geometry: [[a.lat, a.lng], [b.lat, b.lng]], provider: "test" }),
  matrix: async (src, dst) => src.map((s) => dst.map((d) => km(s, d))),
});
// Lipila: the PIN prompt goes out, and the status check says it was paid.
const lipila = R("server/services/lipila.js");
Object.assign(lipila, {
  enabled: () => true,
  cardsEnabled: () => false,
  collect: async () => ({ status: "pending", identifier: "LIP-1", raw: null }),
  checkStatus: async () => ({ status: "paid", currency: "ZMW", raw: null }),
});

const bcrypt = require("bcrypt");
const sharp = require("sharp");
const app = R("server/server.js");
const pool = R("server/db.js");

let failures = 0;
const ok = (cond, msg, extra) => {
  if (cond) console.log(`  PASS ${msg}`);
  else {
    failures += 1;
    console.log(`  FAIL ${msg}${extra !== undefined ? ` -> ${JSON.stringify(extra).slice(0, 400)}` : ""}`);
  }
};

function client(base, header) {
  const jar = new Map();
  return async (method, url, body, { form = false } = {}) => {
    const headers = { [header]: "1", Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") };
    let payload;
    if (form) payload = body;
    else if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + url, { method, headers, body: payload, redirect: "manual" });
    for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: res.status, body: data };
  };
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const q = (sql, p) => pool.query(sql, p).then(([rows]) => rows);
  const stamp = Date.now();
  const tag = String(stamp % 100000);
  try {
    const pw = await bcrypt.hash("Admin#Pass123", 10);
    await q("INSERT INTO admins (name, email, password_hash) VALUES ('Test Admin', ?, ?)", [`admin${stamp}@test.zm`, pw]);
    const admin = client(base, "X-Frontier-Admin");
    ok((await admin("POST", "/api/admin/auth/login", { email: `admin${stamp}@test.zm`, password: "Admin#Pass123" })).status === 200, "admin signs in");

    // ------------------------------------------------------------ pickup points
    console.log("Seller pickup points");
    const seller = client(base, "X-Frontier-Seller");
    const reg = (email, extra) =>
      seller("POST", "/api/seller/auth/register", {
        name: "Grace Banda", business_name: "Banda Farm", phone: "0971000001", email, province: "Lusaka", address: "Chongwe", password: "Green#Pasture7", ...extra,
      });
    const bad = await reg(`bad${stamp}@test.zm`, { pickup_district: "Chongwe", pickup_address: "Farm 9" });
    ok(bad.status === 422 && bad.body.errors && bad.body.errors.pickup_point, "registration refuses a pickup point without a map pin", bad.body);
    const wrongProv = await reg(`wp${stamp}@test.zm`, { pickup_district: "Kitwe", pickup_address: "Farm 9", pickup_lat: -15.33, pickup_lng: 28.68 });
    ok(wrongProv.status === 422 && wrongProv.body.errors.pickup_district, "registration refuses a district outside the seller's province", wrongProv.body);
    const good = await reg(`grace${stamp}@test.zm`, { pickup_district: "chongwe", pickup_address: "Farm 9, off Great East Rd", pickup_lat: -15.33, pickup_lng: 28.68 });
    ok(good.status === 201, "seller registers with a pickup point", good.body);
    const [g] = await q("SELECT id, pickup_district, pickup_lat FROM sellers WHERE email = ?", [`grace${stamp}@test.zm`]);
    ok(g && g.pickup_district === "Chongwe" && Number(g.pickup_lat) === -15.33, "pickup point saved with the district's proper name", g);
    const plain = await client(base, "X-Frontier-Seller")("POST", "/api/seller/auth/register", { name: "Peter Phiri", phone: "0971000002", email: `peter${stamp}@test.zm`, province: "Lusaka", password: "Green#Pasture7" });
    ok(plain.status === 201, "seller registers without a pickup point (optional)", plain.body);
    const added = await admin("POST", "/api/admin/sellers", { name: "Admin Added", phone: "0971000003", province: "Lusaka", status: "active", pickup_district: "Kafue", pickup_address: "Plot 4, Kafue Rd", pickup_lat: -15.77, pickup_lng: 28.18 });
    ok(added.status === 201 && Number(added.body.data.pickup_lat) === -15.77, "admin adds a seller with a pickup point", added.body);
    const sid = added.body.data.id;
    const keep = await admin("PUT", `/api/admin/sellers/${sid}`, { name: "Admin Added Ltd", phone: "0971000003", province: "Lusaka", status: "active" });
    ok(keep.status === 200 && Number(keep.body.data.pickup_lat) === -15.77, "an edit without pickup fields keeps the pickup point", keep.body);
    const moved = await admin("PUT", `/api/admin/sellers/${sid}`, { name: "Admin Added Ltd", phone: "0971000003", province: "Lusaka", status: "active", pickup_district: "Chilanga", pickup_address: "Farm 2", pickup_lat: -15.55, pickup_lng: 28.27 });
    ok(moved.status === 200 && moved.body.data.pickup_district === "Chilanga", "admin moves the pickup point", moved.body);

    // --------------------------------------------- the admin adds a provider
    console.log("Admin adds providers and vehicles");
    const pf = (fields, files = []) => {
      const fd = new FormData();
      for (const [k, v] of Object.entries(fields)) fd.append(k, v);
      for (const [name, buf, file, type, docType] of files) {
        fd.append(name, new Blob([buf], { type }), file);
        if (docType) fd.append("doc_types", docType);
      }
      return fd;
    };
    const pdf = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
    // Only this run's providers take part (the test database keeps earlier runs' data).
    await q("UPDATE transport_providers SET is_available = 0");
    const noPin = await admin("POST", "/api/admin/transport/providers", pf({ kind: "individual", name: "John Tembo", phone: "0977111222", email: `john${stamp}@test.zm`, province: "Lusaka", district: "Lusaka", address: "Plot 5, Cairo Rd" }), { form: true });
    ok(noPin.status === 422 && noPin.body.errors.base_point, "adding a provider needs the operating location on the map", noPin.body);
    const prov = await admin(
      "POST",
      "/api/admin/transport/providers",
      pf({ kind: "company", name: "Swift Haulage", contact_person: "John Tembo", phone: "0977111222", email: `swift${stamp}@test.zm`, province: "Lusaka", district: "Lusaka", address: "Plot 5, Cairo Rd", base_lat: -15.4167, base_lng: 28.2833, coverage_km: 300, licence_number: "TL-123" },
        [["documents", pdf, "nrc.pdf", "application/pdf", "nrc"]]),
      { form: true },
    );
    ok(prov.status === 201 && prov.body.data.status === "approved" && prov.body.data.coverage_active, "admin adds a provider: approved, coverage on", prov.body);
    ok(prov.body.setup_link && /\/transport\/reset\?token=[a-f0-9]{64}$/.test(prov.body.setup_link), "the admin gets a link for the provider to choose a password", prov.body.setup_link);
    const pid = prov.body.data.id;
    ok((prov.body.data.documents || []).length === 1, "the provider's NRC is stored", prov.body.data.documents);
    const dup = await admin("POST", "/api/admin/transport/providers", pf({ kind: "individual", name: "Copy", phone: "0977111223", email: `swift${stamp}@test.zm`, province: "Lusaka", district: "Lusaka", address: "Plot 6", base_lat: -15.41, base_lng: 28.28 }), { form: true });
    ok(dup.status === 422 && dup.body.errors.email, "the same email can't be used twice", dup.body);
    // The provider chooses a password with the link, then signs in.
    const token = prov.body.setup_link.split("token=")[1];
    const provider = client(base, "X-Frontier-Transport");
    const setPw = await provider("POST", "/api/transport/auth/reset", { token, password: "Truck#Pass123" });
    ok(setPw.status === 200, "the provider chooses a password with the link", setPw.body);
    ok((await provider("POST", "/api/transport/auth/login", { email: `swift${stamp}@test.zm`, password: "Truck#Pass123" })).status === 200, "the provider signs in");
    const det = await admin("PUT", `/api/admin/transport/providers/${pid}/details`, { kind: "company", name: "Swift Haulage Ltd", contact_person: "John Tembo", phone: "0977111999", email: `swift${stamp}@test.zm`, licence_number: "TL-999", registration_number: "PACRA-1" });
    ok(det.status === 200 && det.body.data.name === "Swift Haulage Ltd" && det.body.data.phone === "0977111999", "admin edits the provider's details", det.body);
    const docs = await admin("POST", `/api/admin/transport/providers/${pid}/documents`, pf({}, [["documents", pdf, "permit.pdf", "application/pdf", "permit"]]), { form: true });
    ok(docs.status === 201 && docs.body.data.documents.length === 2, "admin adds a document", docs.body);
    const link2 = await admin("POST", `/api/admin/transport/providers/${pid}/password-link`, {});
    ok(link2.status === 200 && /token=/.test(link2.body.setup_link), "admin sends a new password link", link2.body);
    // A company registers with its drivers and vehicles (D: drivers).
    const coReg = (extra) => client(base, "X-Frontier-Transport")("POST", "/api/transport/auth/register", pf({
      kind: "company", name: "Kafue Haulage", contact_person: "Ben Tembo", phone: "0977222333", email: `kafue${stamp}@test.zm`, province: "Lusaka", district: "Kafue", address: "Plot 1, Kafue Rd", base_lat: -15.77, base_lng: 28.18, preferred_coverage_km: 200, password: "Truck#Pass123", confirm_password: "Truck#Pass123", accept_terms: "1", ...extra,
    }, [["documents", pdf, "nrc.pdf", "application/pdf", "nrc"], ["documents", pdf, "lic.pdf", "application/pdf", "drivers_licence"]]), { form: true });
    const noFleet = await coReg({});
    ok(noFleet.status === 422 && noFleet.body.errors.drivers && noFleet.body.errors.vehicles, "a company must add drivers and vehicles", noFleet.body.errors);
    const fleet = { drivers: JSON.stringify([{ name: "Alice Phiri", phone: `0977 ${tag.padStart(5, "0")}9` }, { name: "Bob Zulu", phone: `0977 ${tag.padStart(5, "0")}8`, licence_number: "DL-9" }]), vehicles: JSON.stringify([{ registration: `KFH ${tag}`, vehicle_type: "Truck", size_class: "large", cargo_a1: "20" }]) };
    const twice = await coReg({ ...fleet, drivers: JSON.stringify([{ name: "Alice Phiri", phone: "0977111000" }, { name: "Al Phiri", phone: "+260977111000" }]) });
    ok(twice.status === 422 && /Driver 2: This phone number is listed twice/.test(twice.body.errors.drivers), "the same driver number twice is caught", twice.body.errors);
    const co = await coReg(fleet);
    ok(co.status === 201, "the company registers with 2 drivers and 1 vehicle", co.body);
    const [[coRow]] = [await q("SELECT id FROM transport_providers WHERE email = ?", [`kafue${stamp}@test.zm`])];
    const coDrivers = await q("SELECT name, password_hash FROM transport_drivers WHERE provider_id = ?", [coRow.id]);
    const coVeh = await q("SELECT v.registration, v.size_class, c.max_quantity FROM transport_vehicles v JOIN transport_vehicle_cargo c ON c.vehicle_id = v.id WHERE v.provider_id = ?", [coRow.id]);
    ok(coDrivers.length === 2 && coDrivers.every((d) => d.password_hash === null), "its drivers are saved, waiting for sign-in codes", coDrivers);
    ok(coVeh.length === 1 && coVeh[0].size_class === "large" && coVeh[0].max_quantity === 20, "its vehicle is saved with size and load", coVeh);
    const soloReg = (extra, c = client(base, "X-Frontier-Transport")) => c("POST", "/api/transport/auth/register", pf({
      kind: "individual", name: "Solo Driver", phone: "0977222444", email: `solo${stamp}@test.zm`, province: "Lusaka", district: "Lusaka", address: "Plot 2", base_lat: -15.41, base_lng: 28.28, preferred_coverage_km: 50, password: "Truck#Pass123", confirm_password: "Truck#Pass123", accept_terms: "1", ...extra,
    }, [["documents", pdf, "nrc.pdf", "application/pdf", "nrc"], ["documents", pdf, "lic.pdf", "application/pdf", "drivers_licence"]]), { form: true });
    const soloNoVeh = await soloReg({});
    ok(soloNoVeh.status === 422 && soloNoVeh.body.errors.vehicles && !soloNoVeh.body.errors.drivers, "an owner-driver must add their vehicle (no drivers asked)", soloNoVeh.body.errors);
    const soloClient = client(base, "X-Frontier-Transport");
    const solo = await soloReg({ vehicles: JSON.stringify([{ registration: `SOLO ${tag}`, vehicle_type: "Honda Motorbike", size_class: "bike" }, { registration: `SOLO2 ${tag}`, vehicle_type: "Second", size_class: "small" }]) }, soloClient);
    ok(solo.status === 201, "an owner-driver registers with their vehicle", solo.body);
    const soloVeh = await q("SELECT v.size_class FROM transport_vehicles v JOIN transport_providers p ON p.id = v.provider_id WHERE p.email = ?", [`solo${stamp}@test.zm`]);
    ok(soloVeh.length === 1 && soloVeh[0].size_class === "bike", "the owner-driver's one vehicle is saved (a Bike, no load limits needed; a 2nd is ignored)", soloVeh);
    const solo2 = await soloClient("POST", "/api/transport/vehicles", pf({ registration: `SOLO3 ${tag}`, vehicle_type: "Van", size_class: "small" }, [["photos", await sharp({ create: { width: 20, height: 20, channels: 3, background: "#777" } }).png().toBuffer(), "v.png", "image/png"]]), { form: true });
    ok(solo2.status === 409, "an owner-driver can't add a second vehicle", solo2.body);

    // Vehicles, added by the admin (photos optional here).
    const vf = (reg2, size) => pf({ registration: reg2, vehicle_type: "Truck with crate", ...(size ? { size_class: size } : {}), cargo_a1: "10" });
    const vNoSize = await admin("POST", `/api/admin/transport/providers/${pid}/vehicles`, vf(`NS ${tag}`, null), { form: true });
    ok(vNoSize.status === 422 && vNoSize.body.errors.size_class, "a vehicle needs a size", vNoSize.body);
    const vMed = await admin("POST", `/api/admin/transport/providers/${pid}/vehicles`, vf(`MED ${tag}`, "medium"), { form: true });
    ok(vMed.status === 201 && vMed.body.data.vehicle_list.some((v) => v.size_label === "Medium"), "admin adds a Medium vehicle", vMed.body);
    const medId = vMed.body.data.vehicle_list.find((v) => v.size_class === "medium").id;
    const vEdit = await admin("PUT", `/api/admin/transport/vehicles/${medId}`, vf(`MED ${tag}`, "large"), { form: true });
    ok(vEdit.status === 200 && vEdit.body.data.vehicle_list.find((v) => v.id === medId).size_class === "large", "admin changes a vehicle's size", vEdit.body);
    await admin("PUT", `/api/admin/transport/vehicles/${medId}`, vf(`MED ${tag}`, "medium"), { form: true });
    // The provider adds one too (photos required there).
    const photo = await sharp({ create: { width: 40, height: 30, channels: 3, background: "#888" } }).png().toBuffer();
    const small = await provider("POST", "/api/transport/vehicles", pf({ registration: `SML ${tag}`, vehicle_type: "Pickup", size_class: "small", cargo_a1: "10" }, [["photos", photo, "v.png", "image/png"]]), { form: true });
    ok(small.status === 201 && small.body.data.size_class === "small", "the provider adds a Small vehicle");

    // ------------------------------------------------------- sizes and checkout
    console.log("Vehicle sizes at checkout");
    await admin("POST", "/api/admin/transport/bands", { min_km: 0, max_km: "", base_fee: 200, per_km: 10, is_active: true });
    const sizes = await admin("PUT", "/api/admin/transport/settings", { enabled: "1", accept_window_minutes: 60, gps_stale_minutes: 15, commission_pct: 10, auto_complete_hours: 24, size_pct_small: 100, size_pct_medium: 130, size_pct_large: 160, size_pct_extra_large: 200 });
    ok(sizes.status === 200 && sizes.body.data.size_pct.medium === 130, "admin sets the price of each vehicle size", sizes.body);
    await q("UPDATE sellers SET account_status = 'approved' WHERE id = ?", [g.id]);
    const [[cat]] = await pool.query("SELECT c.id FROM categories c JOIN animals a ON a.id = c.animal_id WHERE a.id = 1 LIMIT 1");
    const [lv] = await pool.query(
      "INSERT INTO livestock (title, category_id, quantity, price, price_unit, location, status, published_at, seller_id, review_status) VALUES ('Boran heifers', ?, 20, 5000, 'head', 'Lusaka', 'published', NOW(), ?, 'approved')",
      [cat.id, g.id],
    );
    const buyer = client(base, "X-Frontier-Buyer");
    const br = await buyer("POST", "/api/buyer/auth/register", { full_name: "Mary Mwale", email: `mary${stamp}@test.zm`, phone: "0961000001", password: "Blue#River42", accept_terms: true });
    ok(br.status === 201, "buyer registers", br.body);
    const dest = { dest_province: "Lusaka", dest_district: "Lusaka", dest_address: "12 Kabulonga Rd", contact_name: "Mary Mwale", contact_phone: "0961000001", dest_lat: -15.42, dest_lng: 28.32 };
    const items = [{ id: lv.insertId, qty: 2 }];
    const d = (await buyer("POST", "/api/checkout/transport-quote", { items, ...dest })).body.data || {};
    const byKey = Object.fromEntries((d.size_options || []).map((o) => [o.key, o]));
    ok(d.available && byKey.small.available && byKey.medium.available && !byKey.large.available && !byKey.extra_large.available, "only sizes with a free vehicle can be chosen (Small, Medium)", d.size_options);
    ok(byKey.bike && !byKey.bike.available, "Bike is one of the sizes (none free here)", byKey.bike);
    ok(d.vehicle_size === "small", "the smallest free size is chosen first", d.vehicle_size);
    const baseFee = d.journeys[0].fee;
    ok(Math.abs(byKey.medium.fee_total - Math.round(baseFee * 1.3 * 100) / 100) < 0.02, "Medium costs 130% of the distance price", { baseFee, medium: byKey.medium.fee_total });
    const order = (size) => buyer("POST", "/api/checkout", { items, accept_terms: true, payment_method: "mobile_money", mobile_operator: "airtel", payment_phone: "0971234567", delivery_option: "transport", ...dest, ...(size ? { vehicle_size: size } : {}) });
    ok((await order(null)).status === 422, "an order with transport needs a vehicle size");
    const large = await order("large");
    ok(large.status === 409 && /Large vehicle is no longer free/.test(large.body.message), "a size nobody has free is refused, never swapped", large.body);
    const placed = await order("medium");
    ok(placed.status === 201, "order placed with a Medium vehicle", placed.body);
    const cid = placed.body.data.id;
    const [bk] = await q("SELECT id, vehicle_size, fee FROM transport_bookings WHERE checkout_id = ?", [cid]);
    ok(bk && bk.vehicle_size === "medium" && Math.abs(Number(bk.fee) - byKey.medium.fee_total) < 0.02, "the delivery records the Medium size and its fee", bk);

    // ------------------------------------------------ payment and the tracker
    console.log("Payment and tracking");
    const checkout = R("server/lib/checkout.js");
    await checkout.refreshLipila({ ...(await checkout.load(cid)), payment_checked_at: null });
    const page = (await buyer("GET", `/api/checkout/${cid}?token=${placed.body.data.token}`)).body.data;
    const t = page.transport[0];
    ok(page.status === "paid", "payment confirmed");
    ok(t.step.n === 1 && /Finding a transport provider/.test(t.step.label), "success page tracker: finding a provider", t.step);
    ok(t.track_url === `/account/?tab=orders&delivery=${bk.id}` && t.vehicle_size === "Medium", "success page links straight to the delivery, with its size", t);
    // The request goes out in the background after payment: wait for it (up to 10 s).
    let offer;
    for (let i = 0; i < 50 && !offer; i++) {
      [offer] = await q("SELECT status FROM transport_offers WHERE booking_id = ? AND provider_id = ?", [bk.id, pid]);
      if (!offer) await new Promise((r) => setTimeout(r, 200));
    }
    ok(offer && offer.status === "offered", "the request went to the provider with a free Medium vehicle", offer);
    // ------------------------------------------- a company's drivers (D: drivers)
    console.log("Company drivers");
    const addDrv = await provider("POST", "/api/transport/drivers", { name: "Moses Daka", phone: `0955 ${tag.padStart(5, "0").slice(0, 3)} ${tag.padStart(5, "0").slice(3)}1` });
    ok(addDrv.status === 201 && /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(addDrv.body.code), "the company adds a driver and gets a sign-in code", addDrv.body);
    const drvPhone = addDrv.body.data.phone;
    const dup2 = await provider("POST", "/api/transport/drivers", { name: "Copy", phone: `+260 ${drvPhone.replace(/\D/g, "").slice(1)}` });
    ok(dup2.status === 422 && dup2.body.errors.phone, "the same number (written another way) can't be added twice", dup2.body);
    const driver = client(base, "X-Frontier-Transport");
    const badLogin = await driver("POST", "/api/transport/auth/driver-login", { phone: drvPhone, password: "WRONG-CODE" });
    ok(badLogin.status === 401, "a wrong code is refused");
    const dLogin = await driver("POST", "/api/transport/auth/driver-login", { phone: `+260${drvPhone.replace(/\D/g, "").slice(1)}`, password: addDrv.body.code.toLowerCase().replace("-", "") });
    ok(dLogin.status === 200 && dLogin.body.data.role === "driver", "the driver signs in with their phone number and code (any format)", dLogin.body);
    ok((await driver("GET", "/api/transport/drivers")).status === 403, "a driver can't manage drivers");
    ok((await driver("POST", "/api/transport/vehicles", pf({ registration: "XX 1", vehicle_type: "Van", size_class: "small", cargo_a1: "1" }), { form: true })).status === 403, "a driver can't add vehicles");
    ok((await driver("GET", "/api/transport/me/documents")).status === 403, "a driver can't see the company's documents");
    ok((await driver("POST", `/api/transport/bookings/${bk.id}/decline`, { reason: "x" })).status === 403, "a driver can't decline for the company");
    const dReq = await driver("GET", "/api/transport/requests");
    ok(dReq.status === 200 && dReq.body.data.some((r) => r.id === bk.id), "the driver sees the company's request", dReq.body);
    const wrong = await driver("POST", `/api/transport/bookings/${bk.id}/accept`, { vehicle_id: small.body.data.id });
    ok([400, 409, 422].includes(wrong.status), "accepting with the Small vehicle is refused", wrong.body);
    const right = await driver("POST", `/api/transport/bookings/${bk.id}/accept`, { vehicle_id: medId });
    ok(right.status === 200, "the driver accepts with the company's Medium vehicle", right.body);
    const [bd] = await q("SELECT driver_id FROM transport_bookings WHERE id = ?", [bk.id]);
    ok(Number(bd.driver_id) === Number(addDrv.body.data.id), "the delivery is with that driver", bd);
    const mine = await driver("GET", "/api/transport/bookings");
    ok(mine.body.data.length === 1 && mine.body.data[0].id === bk.id, "the driver's deliveries: only theirs", mine.body.data.map((x) => x.id));
    const coList = await provider("GET", "/api/transport/bookings");
    ok(coList.body.data.find((x) => x.id === bk.id).driver_name === "Moses Daka", "the company sees who drives it");
    const add2 = await provider("POST", "/api/transport/drivers", { name: "Ruth Mbewe", phone: `0966 ${tag.padStart(5, "0")}2` });
    const driver2 = client(base, "X-Frontier-Transport");
    await driver2("POST", "/api/transport/auth/driver-login", { phone: add2.body.data.phone, password: add2.body.code });
    ok((await driver2("GET", `/api/transport/bookings/${bk.id}`)).status === 404, "another driver can't open it");
    ok((await driver2("POST", `/api/transport/bookings/${bk.id}/location`, { lat: -15.4, lng: 28.3 })).status === 403, "another driver can't act on it");
    const busyOff = await provider("PATCH", `/api/transport/drivers/${addDrv.body.data.id}/status`, { active: false });
    ok(busyOff.status === 409, "a driver on a delivery can't be switched off", busyOff.body);
    const reassigned = await provider("PATCH", `/api/transport/bookings/${bk.id}/driver`, { driver_id: add2.body.data.id });
    ok(reassigned.status === 200, "the company gives the delivery to another driver", reassigned.body);
    ok((await driver2("GET", `/api/transport/bookings/${bk.id}`)).status === 200 && (await driver("GET", `/api/transport/bookings/${bk.id}`)).status === 404, "now only the new driver sees it");
    const detail = (await buyer("GET", `/api/checkout/${cid}?token=${placed.body.data.token}`)).body.data;
    ok(detail.status === "paid", "buyer's order still paid");
    const off = await provider("PATCH", `/api/transport/drivers/${addDrv.body.data.id}/status`, { active: false });
    ok(off.status === 200 && (await driver("GET", "/api/transport/auth/me")).status === 401, "a switched-off driver is signed out");
    const newCode = await provider("POST", `/api/transport/drivers/${add2.body.data.id}/code`, {});
    const relog = client(base, "X-Frontier-Transport");
    ok((await relog("POST", "/api/transport/auth/driver-login", { phone: add2.body.data.phone, password: add2.body.code })).status === 401
      && (await relog("POST", "/api/transport/auth/driver-login", { phone: add2.body.data.phone, password: newCode.body.code })).status === 200, "a new code replaces the old one");
    const after = (await buyer("GET", `/api/checkout/${cid}?token=${placed.body.data.token}`)).body.data.transport[0];
    ok(after.step.n === 2, "tracker moves to Driver Assigned", after.step);
  } catch (error) {
    failures += 1;
    console.log("  ERROR", error.stack);
  } finally {
    server.close();
    await pool.end().catch(() => {});
    console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
    process.exit(failures ? 1 : 0);
  }
})();
