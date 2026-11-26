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
    const formPage = /\/transport\/(login|register|forgot|reset)(\.html)?$/.test(location.pathname);
    if (error.status === 401 && !formRequest && !formPage) {
      window.location.href = `/transport/login?next=${encodeURIComponent(location.pathname + location.search)}`;
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
  if (!(await confirmAction({ title: "Sign out?", message: "You'll need to sign in again to see your deliveries.", confirmText: "Sign Out" }))) return;
  try {
    await transportApi("/api/transport/auth/logout", { method: "POST" });
  } finally {
    window.location.href = "/transport/login";
  }
}

const TRANSPORT_NAV = [
  { key: "requests", icon: "inbox", label: "Requests", short: "Requests", badge: "requests" },
  { key: "deliveries", icon: "truck", label: "My Deliveries", short: "Deliveries", badge: "active" },
  { key: "vehicles", icon: "listings", label: "Vehicles", short: "Vehicles", section: "Setup", owner: true },
  { key: "drivers", icon: "users", label: "Drivers", short: "Drivers", owner: true, company: true },
  { key: "ratings", icon: "star", label: "Ratings", short: "Ratings", section: "Account" },
  { key: "notifications", icon: "bell", label: "Notifications", short: "Alerts", badge: "notif" },
  { key: "profile", icon: "users", label: "Profile", short: "Profile" },
];
// What this account sees: a company's drivers don't manage vehicles or
// drivers; only companies have drivers (D: drivers).
function transportNavFor(p) {
  const driver = p.role === "driver";
  return TRANSPORT_NAV.filter((i) => !(i.owner && driver) && !(i.company && p.kind !== "company"));
}

function renderTransportShell(p) {
  const href = (k) => `/transport/?tab=${k}`;
  const nav = transportNavFor(p);
  // Phones: at most 6 buttons along the bottom (Ratings stays in the menu).
  const bottomNav = nav.length > 6 ? nav.filter((i) => i.key !== "ratings") : nav;
  const driver = p.role === "driver" && p.driver;
  renderPortalShell({
    topbar: document.getElementById("transport-topbar"),
    main: document.getElementById("tp-main"),
    name: driver ? p.driver.name : p.name,
    sub: driver ? `Driver · ${p.name}` : p.kind === "company" ? "Transport company" : "Transport account",
    nav,
    href,
    home: "/transport/",
    profileKey: "profile",
    logoutAttr: "data-transport-logout",
  });
  const bottom = document.getElementById("app-bottom-nav");
  bottom.classList.add("app-bottom-nav");
  bottom.dataset.variant = "admin";
  bottom.innerHTML = bottomNav.map((i) => `<a href="${href(i.key)}" data-tab-link="${i.key}"><span class="relative inline-flex">${uiIcon(i.icon)}${i.badge ? `<span data-${i.badge}-badge class="hidden absolute -top-1.5 -right-2.5 bg-red-500 text-white text-[10px] font-bold min-w-[16px] h-4 px-1 rounded-full items-center justify-center leading-none">0</span>` : ""}</span><span>${i.short}</span></a>`).join("");
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
        this.error = err.code === 1 ? "Location is blocked. Allow location for this site in your browser settings so the seller and buyer can follow you." : "Can't get your location right now. Keep the phone's location on.";
        this.onChange(this);
      },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 },
    );
    this.keepAwake();
    this.timer = setInterval(() => { if (this.lastFix && Date.now() - this.last > 20000) this.send(this.lastFix); }, 20000);
  },

  onFix: null,
  async fix(pos) {
    this.lastFix = pos;
    if (this.onFix) this.onFix(pos);
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
