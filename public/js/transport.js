// Transport provider pages in the browser: API calls, the signed-in shell
// and location sharing while a delivery is on the road. Form helpers
// (withBusy, showFieldErrors, bindPasswordToggles, bindPasswordMeter) come
// from seller.js.
const TRANSPORT_HEADER = { "X-Frontier-Transport": "1" };

async function transportApi(url, options = {}) {
  try {
    return await apiRequest(url, { ...options, headers: { ...TRANSPORT_HEADER, ...options.headers } });
  } catch (error) {
    const formRequest = /\/auth\/(login|register|forgot|reset)$/.test(url.split("?")[0]);
    const formPage = /\/transport\/(login|register|forgot|reset)\.html$/.test(location.pathname);
    if (error.status === 401 && !formRequest && !formPage) {
      window.location.href = `/transport/login.html?next=${encodeURIComponent(location.pathname + location.search)}`;
      await new Promise(() => {});
    }
    throw error;
  }
}

function transportNext(fallback = "/transport/") {
  const next = getQueryParams().next || "";
  return next.startsWith("/transport/") && !next.startsWith("//") ? next : fallback;
}

function transportPageHeader() {
  return `
    <nav class="site-topnav sticky top-0 z-50">
      <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center gap-3">
        <a href="/" class="flex items-center gap-3 flex-shrink-0" aria-label="Frontier Marketplace home">
          <div class="brand-mark-full"><img src="/images/logo-full.jpg" alt="Frontier Farms &amp; Consult"></div>
          <span class="hidden sm:block font-bold site-topnav-name">Frontier Transport</span>
        </a>
        <div class="ml-auto flex items-center gap-2"><a href="/" class="site-topnav-back px-3 py-2">Marketplace</a></div>
      </div>
    </nav>`;
}

async function transportLogout() {
  if (!(await confirmAction({ title: "Log out?", message: "You'll need to sign in again to see your deliveries.", confirmText: "Log out" }))) return;
  try {
    await transportApi("/api/transport/auth/logout", { method: "POST" });
  } finally {
    window.location.href = "/transport/login.html";
  }
}

const TRANSPORT_NAV = [
  { key: "requests", icon: "inbox", label: "Requests", short: "Requests", badge: "requests" },
  { key: "deliveries", icon: "truck", label: "My deliveries", short: "Deliveries", badge: "active" },
  { key: "vehicles", icon: "listings", label: "Vehicles", short: "Vehicles", section: "Setup" },
  { key: "ratings", icon: "star", label: "Ratings", short: "Ratings" },
  { key: "notifications", icon: "bell", label: "Notifications", short: "Alerts", badge: "notif", section: "Account" },
  { key: "profile", icon: "users", label: "Profile", short: "Profile" },
];

function renderTransportShell(p) {
  const href = (k) => `/transport/?tab=${k}`;
  const sidebar = document.getElementById("app-sidebar");
  sidebar.classList.add("app-sidebar");
  sidebar.innerHTML = `
    <div class="app-sidebar-brand">
      <div class="brand-mark-full"><img src="/images/logo-full.jpg" alt="Frontier Farms &amp; Consult"></div>
      <div class="min-w-0"><p class="text-white font-semibold text-sm leading-tight">Frontier Marketplace</p><p class="text-xs" style="color: var(--sidebar-text)">Transport</p></div>
    </div>
    <nav class="app-sidebar-nav">
      ${TRANSPORT_NAV.map((i) => `${i.section ? `<p class="app-sidebar-section">${i.section}</p>` : ""}<a href="${href(i.key)}" data-tab-link="${i.key}">${uiIcon(i.icon)}<span>${i.label}</span>${i.badge ? `<span data-${i.badge}-badge class="nav-badge hidden">0</span>` : ""}</a>`).join("")}
    </nav>
    <div class="app-sidebar-footer">
      <p class="text-xs px-3 pb-2 truncate" style="color: var(--sidebar-text)">Signed in as ${escapeHtml(p.name)}</p>
      <button type="button" data-transport-logout>${uiIcon("logout")}<span>Logout</span></button>
    </div>`;
  document.getElementById("transport-topbar").innerHTML = `
    <nav id="page-topnav" class="site-topnav sticky top-0 z-50">
      <div class="px-4 sm:px-6 h-16 flex justify-between items-center">
        <a href="/transport/" class="flex items-center gap-3"><div class="brand-mark-full"><img src="/images/logo-full.jpg" alt="Frontier Farms &amp; Consult"></div><span class="font-bold site-topnav-name">Transport</span></a>
        <button type="button" data-transport-logout class="lg:hidden site-topnav-back px-3 py-2">Log out</button>
      </div>
    </nav>`;
  const bottom = document.getElementById("app-bottom-nav");
  bottom.classList.add("app-bottom-nav");
  bottom.dataset.variant = "admin";
  bottom.innerHTML = TRANSPORT_NAV.map((i) => `<a href="${href(i.key)}" data-tab-link="${i.key}"><span class="relative inline-flex">${uiIcon(i.icon)}${i.badge ? `<span data-${i.badge}-badge class="hidden absolute -top-1.5 -right-2.5 bg-red-500 text-white text-[10px] font-bold min-w-[16px] h-4 px-1 rounded-full items-center justify-center leading-none">0</span>` : ""}</span><span>${i.short}</span></a>`).join("");
  document.querySelectorAll("[data-transport-logout]").forEach((b) => b.addEventListener("click", transportLogout));
}

// ------------------------------------------------------- location sharing
// While a delivery is on the road, the phone's position is sent every
// ~20 seconds (and when it moves). Only real fixes from the device are
// sent; nothing is estimated. The screen is kept awake where the browser allows.
const gps = {
  bookingId: null,
  watch: null,
  last: 0,
  lastFix: null,
  wake: null,
  status: "off",
  onChange: () => {},
  error: null,

  start(bookingId, onChange) {
    if (this.bookingId === bookingId && this.watch !== null) { this.onChange = onChange || this.onChange; this.onChange(this); return; }
    this.stop();
    this.bookingId = bookingId;
    this.onChange = onChange || (() => {});
    if (!navigator.geolocation) {
      this.status = "unsupported";
      this.error = "This browser can't share your location.";
      return this.onChange(this);
    }
    this.status = "waiting";
    this.onChange(this);
    this.watch = navigator.geolocation.watchPosition(
      (pos) => this.fix(pos),
      (err) => {
        this.status = "error";
        this.error = err.code === 1 ? "Location is blocked. Allow location for this site in your browser settings." : "Can't get your location right now. Keep the phone's location on.";
        this.onChange(this);
      },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 },
    );
    this.keepAwake();
    this.timer = setInterval(() => { if (this.lastFix && Date.now() - this.last > 20000) this.send(this.lastFix); }, 20000);
  },

  async fix(pos) {
    this.lastFix = pos;
    this.status = "on";
    this.error = null;
    if (Date.now() - this.last >= 15000) await this.send(pos);
    this.onChange(this);
  },

  async send(pos) {
    this.last = Date.now();
    const c = pos.coords;
    try {
      await transportApi(`/api/transport/bookings/${this.bookingId}/location`, {
        method: "POST",
        body: { lat: c.latitude, lng: c.longitude, accuracy: c.accuracy, speed: c.speed, heading: c.heading, recorded_at: pos.timestamp },
      });
      this.sentAt = new Date();
    } catch (error) {
      if (error.status === 409) this.stop();
      this.error = error.status === 0 ? "No connection: your position will be sent when you're back online." : error.message;
    }
    this.onChange(this);
  },

  async keepAwake() {
    try {
      if ("wakeLock" in navigator) this.wake = await navigator.wakeLock.request("screen");
    } catch {
      this.wake = null;
    }
  },

  stop() {
    if (this.watch !== null && navigator.geolocation) navigator.geolocation.clearWatch(this.watch);
    clearInterval(this.timer);
    this.watch = null;
    this.status = "off";
    this.bookingId = null;
    if (this.wake) this.wake.release().catch(() => {});
    this.wake = null;
    this.onChange(this);
  },
};
document.addEventListener("visibilitychange", () => { if (!document.hidden && gps.watch !== null) gps.keepAwake(); });

// One position now (for collection and arrival records). Resolves null if
// the phone can't give one.
function currentPosition() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy, recorded_at: pos.timestamp }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 },
    );
  });
}
