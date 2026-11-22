// Transport in the browser, shared by the checkout, the buyer and seller
// accounts, the transport provider dashboard and the admin pages:
//   maps (pick a point, follow a delivery), the delivery's status and
//   progress, each party's photos and quantities, the history, star ratings.
// Needs main.js (escapeHtml, apiRequest), icons.js (uiIcon) and, for maps,
// /vendor/leaflet-1.9.4/leaflet.js + leaflet.css.

// From acceptance to delivery the provider's phone shares its position.
const TR_MOVING = ["provider_accepted", "vehicle_selected", "awaiting_collection", "collection_submitted", "collection_confirmed", "in_transit", "arrived"];
const TR_PILL = { unpaid: "so-off", pending: "so-open", accepted: "so-act", active: "so-act", completed: "so-done", disputed: "tr-pill-alert", closed: "so-off" };
function trPill(d, large = false) {
  return `<span class="so-pill ${TR_PILL[d.group] || "so-off"}${large ? " so-pill-lg" : ""}">${escapeHtml(d.status_label || d.status)}</span>`;
}
const trRef = (id) => `TR-${1000 + Number(id)}`;
const trWhen = (v) => (v ? new Date(v).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");
const trKm = (km) => (km === null || km === undefined ? "-" : `${Number(km).toLocaleString("en-GB", { maximumFractionDigits: 1 })} km`);
function trDuration(min) {
  if (min === null || min === undefined || min === "") return "";
  if (Number(min) < 1) return "under 1 min";
  const h = Math.floor(min / 60);
  return h ? `${h} h ${String(min % 60).padStart(2, "0")} min` : `${min} min`;
}

// ------------------------------------------------------------- progress
// Paid → Provider assigned → Collected → On the way → Delivered → Confirmed
const TR_STEPS = ["Paid", "Provider assigned", "Collected", "On the way", "Delivered", "Confirmed"];
const TR_STAGE_OF = {
  pending_payment: [-1, 0], payment_confirmed: [0, 1], awaiting_provider: [0, 1], awaiting_reassignment: [0, 1],
  provider_accepted: [1, 2], vehicle_selected: [1, 2], awaiting_collection: [1, 2], collection_submitted: [1, 2],
  collection_confirmed: [2, 3], in_transit: [2, 3], arrived: [3, 4], delivery_submitted: [3, 4],
  awaiting_confirmation: [4, 5], completed: [5, -1], disputed: [4, 5],
};
function trProgressHtml(status) {
  const closed = ["cancelled", "refund_pending", "refunded"].includes(status);
  const [done, now] = TR_STAGE_OF[status] || [-1, -1];
  const mark = { done: "✓", fail: "!", now: "…" };
  return `<ol class="tx-path tr-path" aria-label="Delivery progress">${TR_STEPS.map((label, i) => {
    const st = closed ? (i <= done ? "done" : "todo") : i <= done ? "done" : i === now ? (status === "disputed" ? "fail" : "now") : "todo";
    return `<li class="tx-step is-${st}"><span class="tx-dot">${mark[st] || i + 1}</span><span class="tx-step-label">${label}</span></li>`;
  }).join("")}</ol>`;
}

// --------------------------------------------------------------- maps
let trMapCfg = null;
async function trMapConfig() {
  if (!trMapCfg) {
    try {
      trMapCfg = (await apiRequest("/api/map-config")).data;
    } catch {
      trMapCfg = { tiles: "https://tile.openstreetmap.org/{z}/{x}/{y}.png", attribution: "&copy; OpenStreetMap contributors" };
    }
  }
  return trMapCfg;
}
const ZAMBIA_CENTER = [-13.4, 27.8];

async function trBaseMap(el, { center = ZAMBIA_CENTER, zoom = 6, scroll = false } = {}) {
  const cfg = await trMapConfig();
  if (!window.L) {
    el.innerHTML = `<p class="tr-map-off">The map couldn't load.</p>`;
    return null;
  }
  const map = L.map(el, { scrollWheelZoom: scroll, attributionControl: true });
  L.tileLayer(cfg.tiles, { attribution: cfg.attribution, maxZoom: 19 }).addTo(map);
  map.setView(center, zoom);
  // Maps inside views that were hidden while building need a size check.
  setTimeout(() => map.invalidateSize(), 60);
  return map;
}

function trPin(kind, title = "") {
  return L.divIcon({ className: "", html: `<span class="tr-pin tr-pin-${kind}" title="${escapeHtml(title)}"></span>`, iconSize: [22, 22], iconAnchor: [11, 11] });
}

// A map to choose a point (delivery point, pickup point, operating location).
// opts: { lat, lng, label, search: true|false, onChange(point) }
// Returns { get() -> {lat, lng} | null, set(lat, lng) }.
async function trPointPicker(holder, opts = {}) {
  // The address fields give place suggestions, so the map has no search box
  // of its own unless a page asks for one (opts.search).
  holder.innerHTML = `
    <div class="tr-picker">
      ${opts.search ? `<div class="tr-picker-tools"><div class="tr-search"><input type="search" class="field-input !py-2 !text-sm" placeholder="Search a place, e.g. Kabulonga, Lusaka" data-search aria-label="Search a place"><ul class="tr-search-list" data-results hidden></ul></div></div>` : ""}
      <div class="tr-map" data-map></div>
      <p class="tr-picker-hint" data-hint>${escapeHtml(opts.hint || "Tap the map to place the pin, then drag it to the exact spot.")}</p>
    </div>`;
  const map = await trBaseMap(holder.querySelector("[data-map]"), { center: opts.lat ? [opts.lat, opts.lng] : ZAMBIA_CENTER, zoom: opts.lat ? 15 : 6 });
  let marker = null;
  let point = opts.lat ? { lat: Number(opts.lat), lng: Number(opts.lng) } : null;
  const hint = holder.querySelector("[data-hint]");
  const set = (lat, lng, { pan = true, zoom = null } = {}) => {
    point = { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 };
    if (!map) return;
    if (!marker) {
      marker = L.marker([point.lat, point.lng], { draggable: true, icon: trPin(opts.kind || "dest", opts.label) }).addTo(map);
      marker.on("dragend", () => { const p = marker.getLatLng(); clearAccuracy(); set(p.lat, p.lng, { pan: false }); });
    } else marker.setLatLng([point.lat, point.lng]);
    if (pan) map.setView([point.lat, point.lng], zoom || Math.max(map.getZoom(), 15));
    hint.textContent = `Pin at ${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}. Drag it to adjust.`;
    if (opts.onChange) opts.onChange(point);
  };
  if (map) {
    if (point) set(point.lat, point.lng, { pan: false });
    map.on("click", (e) => set(e.latlng.lat, e.latlng.lng, { pan: false }));
    const Locate = L.Control.extend({
      options: { position: "topleft" },
      onAdd() {
        const bar = L.DomUtil.create("div", "leaflet-bar tr-locate");
        bar.innerHTML = `<button type="button" data-locate title="Go to my current location" aria-label="Go to my current location">${uiIcon("location")}</button>`;
        L.DomEvent.disableClickPropagation(bar);
        return bar;
      },
    });
    map.addControl(new Locate());
  }
  // "Use my location": listens for a few seconds and keeps the device's most
  // accurate fix (phones improve as GPS locks on), shows how accurate it is,
  // and explains what to do when it fails or is only approximate.
  let accuracyCircle = null;
  const clearAccuracy = () => { if (accuracyCircle) { accuracyCircle.remove(); accuracyCircle = null; } hint.classList.remove("tr-hint-warn"); };
  if (map) map.on("click", clearAccuracy);
  const describe = (m) => (m < 1000 ? `about ${Math.max(5, Math.round(m / 5) * 5)} m` : `about ${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`);
  const showFix = (pos, final) => {
    const c = pos.coords;
    const acc = Number(c.accuracy) || 0;
    set(c.latitude, c.longitude, { zoom: acc <= 150 ? 17 : acc <= 1500 ? 15 : acc <= 8000 ? 13 : 11 });
    if (map) {
      if (accuracyCircle) accuracyCircle.setLatLng([c.latitude, c.longitude]).setRadius(acc);
      else accuracyCircle = L.circle([c.latitude, c.longitude], { radius: acc, color: "#2563eb", weight: 1, fillOpacity: 0.08, interactive: false }).addTo(map);
    }
    const rough = acc > 300;
    hint.classList.toggle("tr-hint-warn", rough);
    hint.textContent = rough
      ? `Your device only knows roughly where you are (within ${describe(acc)}): computers without GPS estimate it from the internet connection. Drag the pin to the exact spot.`
      : `Pin placed at your location (accurate to ${describe(acc)})${final ? "" : ", improving…"}. Drag it if needed.`;
  };
  holder.querySelector("[data-locate]")?.addEventListener("click", (e) => {
    const btn = e.currentTarget;
    if (!window.isSecureContext) return showNotification("Your location can only be used on the secure (https) address of the site. Place the pin on the map instead.", "error");
    if (!navigator.geolocation) return showNotification("This browser can't share your location. Place the pin on the map instead.", "error");
    const label = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="btn-spinner"></span>`;
    btn.setAttribute("aria-label", "Finding your location…");
    let best = null;
    let done = false;
    let watch = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (watch !== null) navigator.geolocation.clearWatch(watch);
      btn.disabled = false;
      btn.innerHTML = label;
      btn.setAttribute("aria-label", "Go to my current location");
      if (best) showFix(best, true);
    };
    watch = navigator.geolocation.watchPosition(
      (pos) => {
        if (done) return;
        if (!best || pos.coords.accuracy < best.coords.accuracy) { best = pos; showFix(pos, false); }
        if (pos.coords.accuracy <= 25) finish();
      },
      (err) => {
        if (done) return;
        if (best) return finish();
        finish();
        const why = {
          1: "Location is blocked for this site. Allow it in your browser (tap the lock or settings icon next to the address), then try again.",
          2: "Your device couldn't work out where it is. Turn on location (GPS) in your phone's settings, or place the pin on the map.",
          3: "Finding your location took too long. Try again, or place the pin on the map.",
        }[err.code] || "We couldn't get your location. Place the pin on the map instead.";
        showNotification(why, "error");
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
    );
    // Stop listening after 12 seconds and keep the best position so far.
    setTimeout(() => {
      if (done) return;
      if (best) finish();
    }, 12000);
  });
  const search = holder.querySelector("[data-search]");
  if (search) {
    const list = holder.querySelector("[data-results]");
    let timer = null;
    search.addEventListener("input", () => {
      clearTimeout(timer);
      const q = search.value.trim();
      if (q.length < 3) { list.hidden = true; return; }
      timer = setTimeout(async () => {
        let found = [];
        try { found = (await apiRequest(`/api/geocode?q=${encodeURIComponent(q)}`)).data; } catch { found = []; }
        list.innerHTML = found.length
          ? found.map((r, i) => `<li><button type="button" data-i="${i}">${escapeHtml(r.label)}</button></li>`).join("")
          : `<li class="tr-search-none">No places found. Place the pin on the map.</li>`;
        list.hidden = false;
        list.querySelectorAll("[data-i]").forEach((b) => b.addEventListener("click", () => {
          const r = found[Number(b.dataset.i)];
          list.hidden = true;
          search.value = r.label;
          set(r.lat, r.lng, { zoom: 16 });
        }));
      }, 350);
    });
    search.addEventListener("keydown", (e) => { if (e.key === "Enter") e.preventDefault(); });
  }
  return {
    get: () => point,
    set: (lat, lng) => set(lat, lng),
    map,
    // A note under the map (e.g. where the pin came from); warn: highlighted.
    note(text, warn = false) { hint.textContent = text; hint.classList.toggle("tr-hint-warn", warn); },
  };
}

// Following a delivery: pickup, destination, the planned road route, the
// GPS trail and the last position (all from real data; nothing is drawn
// that wasn't recorded). Returns { addPoint(p), setTrail(list), fit() }.
async function trTrackingMap(holder, d, { trail = [] } = {}) {
  holder.innerHTML = `<div class="tr-map tr-map-track" data-map></div><p class="tr-map-note" data-note></p>`;
  const map = await trBaseMap(holder.querySelector("[data-map]"));
  const note = holder.querySelector("[data-note]");
  if (!map) return { addPoint() {}, setTrail() {}, fit() {} };
  const bounds = [];
  const p = d.pickup && d.pickup.lat ? [d.pickup.lat, d.pickup.lng] : null;
  const q = d.destination && d.destination.lat ? [d.destination.lat, d.destination.lng] : null;
  if (p) { L.marker(p, { icon: trPin("pickup", "Pickup") }).addTo(map).bindTooltip("Pickup"); bounds.push(p); }
  if (q) { L.marker(q, { icon: trPin("dest", "Delivery point") }).addTo(map).bindTooltip("Delivery point"); bounds.push(q); }
  // On the way to collect: directions from the provider to the pickup (green),
  // and the onward route to the destination (grey). After collection: the
  // route from the pickup to the destination is the directions.
  const collecting = Boolean(d.tracking && d.tracking.approach && d.tracking.approach.geometry && d.tracking.approach.geometry.length > 1);
  if (collecting) {
    L.polyline(d.tracking.approach.geometry, { color: "#16a34a", weight: 5, opacity: 0.85 }).addTo(map);
    d.tracking.approach.geometry.forEach((pt) => bounds.push(pt));
  }
  if (d.tracking && d.tracking.route && d.tracking.route.length > 1) {
    L.polyline(d.tracking.route, collecting ? { color: "#64748b", weight: 4, opacity: 0.5, dashArray: "6 8" } : { color: "#475569", weight: 5, opacity: 0.6 }).addTo(map);
    d.tracking.route.forEach((pt) => bounds.push(pt));
  }
  const line = L.polyline([], { color: "#1d4ed8", weight: 4, opacity: 0.9 }).addTo(map);
  let live = null;
  let lastAt = d.tracking && d.tracking.last ? d.tracking.last.at : null;
  const paintNote = () => {
    if (!lastAt) {
      note.textContent = TR_MOVING.includes(d.status) ? "Waiting for the first position from the provider's phone." : "";
      return;
    }
    const mins = Math.round((Date.now() - new Date(lastAt).getTime()) / 60000);
    const leg = collecting ? ` On the way to the pickup${d.tracking.approach.km ? `: ${trKm(d.tracking.approach.km)}${d.tracking.approach.minutes ? `, about ${trDuration(d.tracking.approach.minutes)}` : ""} away` : ""}.` : "";
    note.innerHTML = `Last position from the provider's phone: <b>${escapeHtml(trWhen(lastAt))}</b>${mins >= 2 ? ` (${mins < 120 ? `${mins} min` : `${Math.round(mins / 60)} h`} ago)` : ""}.${leg}${mins >= 15 && TR_MOVING.includes(d.status) ? " No newer position has been received." : ""}`;
  };
  const moveLive = (pt) => {
    if (!live) live = L.marker([pt.lat, pt.lng], { icon: trPin("live", "Provider"), zIndexOffset: 1000 }).addTo(map).bindTooltip("Provider (last position)");
    else live.setLatLng([pt.lat, pt.lng]);
  };
  const setTrail = (list) => {
    line.setLatLngs(list.map((pt) => [pt.lat, pt.lng]));
    if (list.length) { moveLive(list[list.length - 1]); lastAt = list[list.length - 1].at; }
    else if (d.tracking && d.tracking.last) moveLive(d.tracking.last);
    paintNote();
  };
  setTrail(trail);
  const fit = () => {
    const all = [...bounds, ...line.getLatLngs().map((ll) => [ll.lat, ll.lng])];
    if (all.length > 1) map.fitBounds(all, { padding: [28, 28], maxZoom: 15, animate: false });
    else if (all.length) map.setView(all[0], 13, { animate: false });
  };
  fit();
  // The map may have been built before its box had a size (a view still
  // being laid out): fit again once it has one.
  let fittedAt = holder.offsetWidth;
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => {
      if (!holder.isConnected) return ro.disconnect();
      if (holder.offsetWidth && holder.offsetWidth !== fittedAt) { fittedAt = holder.offsetWidth; map.invalidateSize({ animate: false }); fit(); }
    });
    ro.observe(holder);
  }
  setTimeout(() => { map.invalidateSize({ animate: false }); fit(); }, 120);
  setInterval(paintNote, 60000);
  return {
    map,
    addPoint(pt) { line.addLatLng([pt.lat, pt.lng]); moveLive(pt); lastAt = pt.at; paintNote(); },
    setTrail,
    fit,
  };
}

// Loads the trail and keeps it current: live updates from the page's event
// stream call .push(), and it re-checks every 30 s in case one was missed.
async function trFollow(holder, d, trackUrl, api) {
  let trail = [];
  try { trail = (await api(trackUrl)).data; } catch { trail = []; }
  const view = await trTrackingMap(holder, d, { trail });
  let lastId = trail.length ? trail[trail.length - 1].id : 0;
  const poll = async () => {
    try {
      const more = (await api(`${trackUrl}?after=${lastId}`)).data;
      more.forEach((pt) => view.addPoint(pt));
      if (more.length) lastId = more[more.length - 1].id;
    } catch {
    }
  };
  const timer = TR_MOVING.includes(d.status) ? setInterval(() => { if (!holder.isConnected) clearInterval(timer); else poll(); }, 30000) : null;
  return { push: () => poll(), view };
}

// ------------------------------------------------- photos and quantities
const TR_STAGES = [
  ["seller_collection", "Seller's handover record", "seller_release"],
  ["provider_collection", "Provider's collection record", "provider_collected"],
  ["provider_delivery", "Provider's delivery record", "provider_delivered"],
  ["customer_delivery", "Buyer's record on receipt", null],
];
const TR_PARTY = { seller: "Seller", provider: "Transport provider", customer: "Buyer", admin: "Frontier (for the seller)" };

// Each party's record of each step, as they submitted it: who, when, note,
// quantities per order, and their own photos.
function trEvidenceHtml(d, { only = null } = {}) {
  const parts = TR_STAGES.filter(([stage]) => !only || only.includes(stage)).map(([stage, title, qtyStage]) => {
    const sub = (d.submissions || []).find((s) => s.stage === stage);
    const photos = (d.photos || []).filter((p) => p.stage === stage);
    if (!sub && !photos.length) return "";
    const qty = qtyStage ? (d.quantities || []).filter((x) => x.stage === qtyStage) : [];
    const qtyRows = qty.map((x) => {
      const o = (d.orders || []).find((oo) => Number(oo.id) === Number(x.order_id));
      const differs = o && Number(x.quantity) !== Number(o.quantity);
      return `<li><span>${escapeHtml(o ? `${o.reference} · ${o.title}` : `Order ${x.order_id}`)}</span><b class="${differs ? "tr-diff" : ""}">${x.quantity}${o ? ` of ${o.quantity}` : ""}</b>${x.id_details ? `<small>ID: ${escapeHtml(x.id_details)}</small>` : ""}</li>`;
    }).join("");
    return `<section class="tr-ev">
      <header><b>${title}</b><span>${escapeHtml(sub ? `${TR_PARTY[sub.party] || sub.party}${sub.actor_name ? ` · ${sub.actor_name}` : ""} · ${trWhen(sub.created_at)}` : "")}</span></header>
      ${sub && sub.discrepancy ? `<p class="tr-flag">${uiIcon("alert")}<span>Difference reported</span></p>` : ""}
      ${sub && sub.note ? `<p class="tr-ev-note">"${escapeHtml(sub.note)}"</p>` : ""}
      ${qtyRows ? `<ul class="tr-qty">${qtyRows}</ul>` : ""}
      ${photos.length ? `<div class="acc-photos tr-photos">${photos.map((p) => `<a href="${escapeHtml(p.image_path)}" target="_blank" rel="noopener" title="${escapeHtml(`${TR_PARTY[p.party] || p.party}, ${trWhen(p.created_at)}`)}"><img src="${escapeHtml(p.thumb_path)}" alt="${escapeHtml(`${TR_PARTY[p.party] || p.party}'s photo`)}" loading="lazy"></a>`).join("")}</div>` : ""}
    </section>`;
  }).filter(Boolean);
  return parts.length ? parts.join("") : `<p class="text-sm text-gray-500">No collection or delivery records yet.</p>`;
}

function trTimelineHtml(events = [], { admin = false } = {}) {
  if (!events.length) return "";
  return `<ol class="tr-timeline">${events.slice().reverse().map((e) => `
    <li><span class="tr-tl-dot"></span><div><b>${escapeHtml(e.label)}</b><small>${escapeHtml(trWhen(e.at))}${admin && e.actor_name ? ` · ${escapeHtml(e.actor_name)}` : ""}</small>${e.detail ? `<p>${escapeHtml(e.detail)}</p>` : ""}</div></li>`).join("")}</ol>`;
}

// Quantity fields per order: qty_<id> (and id_<id> for livestock IDs).
function trQtyFields(orders, { start = (o) => o.quantity, ids = false, label = "Quantity" } = {}) {
  return `<div class="tr-qty-fields">${orders.filter((o) => !o.cancelled).map((o) => `
    <div class="tr-qty-field">
      <label class="field-label" for="qty_${o.id}">${escapeHtml(o.reference)} · ${escapeHtml(o.title)} <span class="text-gray-400 font-normal">(ordered ${escapeHtml(o.units)})</span></label>
      <div class="tr-qty-row"><input id="qty_${o.id}" name="qty_${o.id}" type="number" min="0" max="${start(o)}" step="1" inputmode="numeric" class="field-input" value="${start(o)}" aria-label="${escapeHtml(label)}"><span>${escapeHtml(label.toLowerCase())}</span></div>
      <p class="field-error hidden" data-error-for="qty_${o.id}"></p>
      ${ids && o.kind !== "feed" ? `<input name="id_${o.id}" class="field-input mt-2" maxlength="500" placeholder="Ear tags / brands / markings (optional)">` : ""}
    </div>`).join("")}</div>`;
}

// ---------------------------------------------------------------- ratings
function trStarsInput(name = "stars") {
  return `<div class="tr-stars" role="radiogroup" aria-label="Rating out of 5">${[5, 4, 3, 2, 1].map((n) => `
    <input type="radio" id="${name}-${n}" name="${name}" value="${n}"><label for="${name}-${n}" title="${n} star${n === 1 ? "" : "s"}">★</label>`).join("")}</div>`;
}
function trStarsHtml(n, count = null) {
  if (n === null || n === undefined) return `<span class="text-gray-400 text-sm">No ratings yet</span>`;
  const v = Math.round(Number(n));
  return `<span class="tr-stars-show" aria-label="${n} out of 5"><span>${"★".repeat(v)}</span><span class="tr-stars-off">${"★".repeat(5 - v)}</span> <b>${Number(n).toFixed(1)}</b>${count !== null ? `<small> (${count})</small>` : ""}</span>`;
}

// A rating form. onSubmit({ stars, feedback }) -> Promise.
function trRatingForm(holder, { title, hint, name, onSubmit }) {
  holder.innerHTML = `<form class="tr-rate" novalidate>
      <b>${escapeHtml(title)}</b>
      ${hint ? `<p class="text-sm text-gray-600 mt-1">${escapeHtml(hint)}</p>` : ""}
      ${trStarsInput(name)}
      <p class="field-error hidden" data-error-for="${name}"></p>
      <textarea name="feedback" rows="2" maxlength="1000" class="field-input" placeholder="Anything you'd like to tell us? (optional)"></textarea>
      <button type="submit" class="acc-btn mt-3">Submit rating</button>
    </form>`;
  const form = holder.querySelector("form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const stars = form.querySelector(`input[name="${name}"]:checked`);
    if (!stars) return showFieldErrors(form, { errors: { [name]: "Please choose 1 to 5 stars." } });
    try {
      await withBusy(form.querySelector("button[type=submit]"), "Sending…", () => onSubmit({ stars: Number(stars.value), feedback: form.feedback.value.trim() }));
    } catch (error) {
      showNotification(error.message, "error");
    }
  });
}

// Facts about a delivery shown to everyone involved.
function trFactsHtml(d, { role } = {}) {
  const rows = [
    ["Delivery", d.reference],
    ["From", [d.pickup.label, d.pickup.place].filter(Boolean).join(", ")],
    ...(d.pickup.phone ? [["Seller phone", `<a href="tel:${escapeHtml(d.pickup.phone.replace(/[^\d+]/g, ""))}">${escapeHtml(d.pickup.phone)}</a>`, true]] : []),
    ["To", d.destination.place || [d.destination.address, d.destination.district, d.destination.province].filter(Boolean).join(", ")],
    ...(d.destination.notes ? [["Directions", d.destination.notes]] : []),
    ...(d.destination.contact_name ? [["Receiver", `${escapeHtml(d.destination.contact_name)} · <a href="tel:${escapeHtml(d.destination.contact_phone.replace(/[^\d+]/g, ""))}">${escapeHtml(d.destination.contact_phone)}</a>`, true]] : []),
    ["Road distance", `${trKm(d.distance_km)}${d.duration_min ? ` · about ${trDuration(d.duration_min)}` : ""}`],
    ["Load", d.cargo_summary || "-"],
    ...(d.fee !== undefined && d.fee !== null ? [["Transport fee", kwacha(d.fee)]] : []),
    ...(d.provider_earning !== undefined && d.provider_earning !== null && role === "provider" ? [["Your earning", kwacha(d.provider_earning)]] : []),
  ];
  return `<dl class="sv-facts tr-facts">${rows.map(([k, v, raw]) => `<div><dt>${k}</dt><dd>${raw ? v : escapeHtml(v)}</dd></div>`).join("")}</dl>`;
}

function trProviderHtml(d) {
  if (!d.provider) return `<p class="text-sm text-gray-600">${["payment_confirmed", "awaiting_provider", "awaiting_reassignment"].includes(d.status) ? "We're finding a transport provider. You'll be told as soon as one accepts." : "No transport provider assigned."}</p>`;
  const p = d.provider;
  return `<div class="tr-provider">
    <span class="acc-av">${escapeHtml(String(p.name).split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase())}</span>
    <div class="min-w-0">
      <p class="font-bold text-gray-900">${escapeHtml(p.name)}</p>
      <p class="text-sm text-gray-600">${trStarsHtml(p.rating, p.ratings)} · ${p.completed} deliver${p.completed === 1 ? "y" : "ies"}</p>
      ${d.vehicle ? `<p class="text-sm text-gray-700 mt-1">${uiIcon("truck")} ${escapeHtml(d.vehicle.registration)} · ${escapeHtml(d.vehicle.type)}</p>` : ""}
    </div>
    ${p.phone ? `<a class="tbl-icon" href="tel:${escapeHtml(p.phone.replace(/[^\d+]/g, ""))}" title="Call ${escapeHtml(p.phone)}" aria-label="Call the provider">${uiIcon("phone")}</a>` : ""}
  </div>`;
}

// Asks for a short text (a reason, a reference) on its own page. Resolves
// the text, or null when cancelled. opts: { title, label, help, confirmText,
// required, placeholder, maxLength, danger }
function trPrompt({ title, label, help = "", confirmText = "OK", required = false, placeholder = "", maxLength = 500, danger = false, multiline = true }) {
  return new Promise((resolve) => {
    let done = false;
    const field = multiline
      ? `<textarea id="trp-text" name="text" rows="3" maxlength="${maxLength}" class="field-input" placeholder="${escapeHtml(placeholder)}"></textarea>`
      : `<input id="trp-text" name="text" maxlength="${maxLength}" class="field-input" placeholder="${escapeHtml(placeholder)}">`;
    const view = openAdminView({
      title,
      params: {},
      onClose: () => { if (!done) resolve(null); },
      html: `<form class="admin-form-page" novalidate>
        <h1 class="admin-view-title">${escapeHtml(title)}</h1>
        <div class="admin-form-card"><label class="field-label" for="trp-text">${escapeHtml(label)}${required ? "" : ' <span class="text-gray-400 font-normal">(optional)</span>'}</label>
          ${help ? `<p class="text-sm text-gray-600 mb-2">${escapeHtml(help)}</p>` : ""}${field}<p class="field-error hidden" data-error-for="text"></p></div>
        <div class="admin-form-actions">
          <button type="button" data-cancel class="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 font-medium bg-white">Cancel</button>
          <button type="submit" class="inline-flex items-center gap-2 px-5 py-2 rounded-lg ${danger ? "bg-red-600 hover:bg-red-700" : "bg-blue-600 hover:bg-blue-700"} text-white font-semibold">${escapeHtml(confirmText)}</button>
        </div></form>`,
    });
    const form = view.el.querySelector("form");
    form.querySelector("[data-cancel]").addEventListener("click", () => view.close(true));
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const v = form.text.value.trim();
      if (required && !v) return showFieldErrors(form, { errors: { text: "This is required." } });
      done = true;
      resolve(v);
      view.close(true);
    });
    setTimeout(() => form.text.focus(), 50);
  });
}

// A form someone has started filling in (typed, chose photos) is marked, so
// live updates don't redraw the page under them.
function trMarkDirty(e) {
  const f = e.target && e.target.closest ? e.target.closest("form") : null;
  if (f) f.dataset.dirty = "1";
}
document.addEventListener("input", trMarkDirty, true);
document.addEventListener("change", trMarkDirty, true);
function trEditing(root) {
  return Boolean(root && root.querySelector("form[data-dirty]"));
}

// ---------------------------------------------------- district and address
// A district field that only offers the districts of the chosen province,
// with type-to-search. `input` keeps its name, so forms post it as before.
// province(): the province now chosen. Needs zambia-districts.js.
function trDistrictField(input, province, { onPick } = {}) {
  if (!input || input.dataset.districtField) return null;
  input.dataset.districtField = "1";
  input.setAttribute("autocomplete", "off");
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  const wrap = document.createElement("div");
  wrap.className = "tr-combo";
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);
  const list = document.createElement("ul");
  list.className = "tr-combo-list";
  list.setAttribute("role", "listbox");
  list.hidden = true;
  wrap.appendChild(list);
  let items = [];
  let active = -1;
  const districts = () => (window.ZambiaDistricts ? ZambiaDistricts.list(province()) : []);
  const paintPlaceholder = () => {
    const p = province();
    input.placeholder = p ? "Search districts" : "Choose province first";
    input.disabled = !p && !input.value;
  };
  const close = () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); active = -1; };
  const open = () => {
    const all = districts();
    if (!all.length) { close(); return; }
    const q = input.value.trim().toLowerCase();
    // A district already chosen: show the whole list (to change it), with it marked.
    const chosen = all.findIndex((d) => d.toLowerCase() === q);
    items = q && chosen < 0 ? [...all.filter((d) => d.toLowerCase().startsWith(q)), ...all.filter((d) => !d.toLowerCase().startsWith(q) && d.toLowerCase().includes(q))] : all;
    if (chosen >= 0 && active < 0) active = chosen;
    list.innerHTML = items.length
      ? items.map((d, i) => `<li role="option" data-i="${i}" class="${i === active ? "is-active" : ""}">${escapeHtml(d)}</li>`).join("")
      : `<li class="tr-combo-none">No district in ${escapeHtml(province())} Province matches "${escapeHtml(input.value.trim())}".</li>`;
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
  };
  const pick = (d) => {
    input.value = d;
    close();
    input.classList.remove("has-error");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    if (onPick) onPick(d);
  };
  input.addEventListener("focus", open);
  input.addEventListener("input", (e) => { if (e.isTrusted) { active = -1; open(); } });
  input.addEventListener("keydown", (e) => {
    if (list.hidden && ["ArrowDown", "ArrowUp"].includes(e.key)) open();
    if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(items.length - 1, active + 1); open(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(0, active - 1); open(); }
    else if (e.key === "Enter" && !list.hidden && items.length) { e.preventDefault(); pick(items[Math.max(0, active)]); }
    else if (e.key === "Escape") close();
  });
  list.addEventListener("mousedown", (e) => {
    const li = e.target.closest("[data-i]");
    if (!li) return;
    e.preventDefault();
    pick(items[Number(li.dataset.i)]);
  });
  // Leaving the field: keep a district typed in full (any spelling), else clear it.
  input.addEventListener("blur", () => setTimeout(() => {
    close();
    if (!input.value.trim()) return;
    const exact = window.ZambiaDistricts ? ZambiaDistricts.match(province(), input.value) : null;
    if (exact) { if (exact !== input.value) pick(exact); return; }
    if (items.length === 1) return pick(items[0]);
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, 120));
  paintPlaceholder();
  return {
    // The province changed: a district from another province is cleared.
    refresh() {
      if (input.value && !(window.ZambiaDistricts && ZambiaDistricts.match(province(), input.value))) {
        input.value = "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      paintPlaceholder();
    },
    set(d) { input.value = d || ""; paintPlaceholder(); },
  };
}

// Address suggestions while typing (OpenRouteService place search). Picking
// one fills the address and calls onPick({ label, name, lat, lng, province,
// district }) so the page can move the map pin and fill the province and
// district. near(): a point to favour (the map pin), optional.
function trAddressSuggest(input, { onPick, near } = {}) {
  if (!input || input.dataset.addressSuggest) return;
  input.dataset.addressSuggest = "1";
  input.setAttribute("autocomplete", "off");
  const wrap = document.createElement("div");
  wrap.className = "tr-combo";
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);
  const list = document.createElement("ul");
  list.className = "tr-combo-list";
  list.hidden = true;
  wrap.appendChild(list);
  let timer = null;
  let seq = 0;
  let found = [];
  let active = -1;
  const close = () => { list.hidden = true; active = -1; seq++; };
  const paint = () => {
    list.innerHTML = found.length
      ? found.map((r, i) => `<li data-i="${i}" class="${i === active ? "is-active" : ""}">${uiIcon("location")}<span>${escapeHtml(r.name)}<small>${escapeHtml(r.label)}</small></span></li>`).join("")
        + `<li class="tr-combo-none">Not listed? Type the address and place the pin on the map.</li>`
      : `<li class="tr-combo-none">No matching places. Type the address and place the pin on the map.</li>`;
    list.hidden = false;
  };
  const pick = (r) => {
    input.value = r.name;
    close();
    input.dispatchEvent(new Event("input", { bubbles: true }));
    if (onPick) onPick(r);
  };
  input.addEventListener("input", (e) => {
    if (!e.isTrusted) return;
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 3) { close(); return; }
    timer = setTimeout(async () => {
      const mine = ++seq;
      const p = near ? near() : null;
      const params = new URLSearchParams({ q, mode: "suggest" });
      if (p && p.lat) { params.set("lat", p.lat); params.set("lng", p.lng); }
      let rows = [];
      try { rows = (await apiRequest(`/api/geocode?${params}`)).data; } catch { rows = []; }
      if (mine !== seq || document.activeElement !== input) return;
      found = rows;
      active = -1;
      paint();
    }, 300);
  });
  input.addEventListener("keydown", (e) => {
    if (list.hidden || !found.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(found.length - 1, active + 1); paint(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(0, active - 1); paint(); }
    else if (e.key === "Enter" && active >= 0) { e.preventDefault(); pick(found[active]); }
    else if (e.key === "Escape") close();
  });
  // Escape before the list has opened: a reply still on its way stays closed.
  input.addEventListener("keydown", (e) => { if (e.key === "Escape") { clearTimeout(timer); close(); } });
  list.addEventListener("mousedown", (e) => {
    const li = e.target.closest("[data-i]");
    if (!li) return;
    e.preventDefault();
    pick(found[Number(li.dataset.i)]);
  });
  input.addEventListener("blur", () => { clearTimeout(timer); setTimeout(close, 150); });
}

// Wires a province select, district field, address field and map picker
// together. Picking an address sets the province, district and pin when the
// place search knows them. Returns { refresh() } for when the province changes.
function trPlaceFields({ province, district, address, picker, provinceValue, autoPin = true }) {
  const getProvince = () => (province ? province.value : provinceValue ? provinceValue() : "");
  const d = trDistrictField(district, getProvince);
  const pin = () => (picker ? picker() : null);
  // The map pin follows the address: a picked suggestion places it exactly;
  // a typed address is looked up once the person stops typing.
  let fromSuggestion = false;
  let lastKey = "";
  let timer = null;
  const where = () => [address.value.trim(), district && district.value, getProvince()].filter(Boolean);
  const inZambia = (r) => r && r.lat >= -18.3 && r.lat <= -8 && r.lng >= 21.8 && r.lng <= 33.9;
  async function placeFromAddress() {
    clearTimeout(timer);
    const p = pin();
    if (!autoPin || !p || fromSuggestion || address.value.trim().length < 3) return;
    const parts = where();
    const key = parts.join("|").toLowerCase();
    if (key === lastKey) return;
    lastKey = key;
    const find = async (q) => {
      try { return ((await apiRequest(`/api/geocode?${new URLSearchParams({ q })}`)).data || []).find(inZambia) || null; } catch { return null; }
    };
    let hit = await find(parts.join(", "));
    let rough = false;
    if (!hit && district && district.value) { hit = await find(`${district.value}, ${getProvince()}`); rough = Boolean(hit); }
    if (key !== lastKey || fromSuggestion) return; // changed meanwhile
    if (!hit) {
      if (p.note) p.note("We couldn't find this address on the map. Tap the map where the delivery point is.", true);
      return;
    }
    p.set(hit.lat, hit.lng);
    if (p.note) p.note(rough ? "We couldn't find this exact address, so the pin is in the district. Drag it to the exact spot." : "Pin placed from the address. Drag it to the exact spot if needed.", rough);
  }
  if (province) province.addEventListener("change", () => { if (d) d.refresh(); });
  address.addEventListener("input", (e) => {
    if (!e.isTrusted) return;
    fromSuggestion = false;
    clearTimeout(timer);
    timer = setTimeout(placeFromAddress, 1200);
  });
  address.addEventListener("blur", () => setTimeout(placeFromAddress, 200));
  if (district) district.addEventListener("change", () => { if (!fromSuggestion && address.value.trim()) { clearTimeout(timer); timer = setTimeout(placeFromAddress, 300); } });
  trAddressSuggest(address, {
    near: () => (pin() ? pin().get() : null),
    onPick: (r) => {
      fromSuggestion = true;
      clearTimeout(timer);
      if (province && r.province && province.value !== r.province) {
        province.value = r.province;
        province.dispatchEvent(new Event("change", { bubbles: true }));
      }
      if (district && r.district && (!province || getProvince() === r.province)) {
        district.disabled = false;
        district.value = r.district;
        district.dispatchEvent(new Event("input", { bubbles: true }));
        district.dispatchEvent(new Event("change", { bubbles: true }));
      }
      if (d) d.refresh();
      lastKey = where().join("|").toLowerCase();
      const p = pin();
      if (p) {
        p.set(r.lat, r.lng);
        if (p.note) p.note(`Pin placed at ${r.name}. Drag it to the exact spot if needed.`);
      }
    },
  });
  return { refresh: () => d && d.refresh() };
}
