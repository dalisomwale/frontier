const SELLER_HEADER = { "X-Frontier-Seller": "1" };

async function sellerApi(url, options = {}) {
  try {
    return await apiRequest(url, { ...options, headers: { ...SELLER_HEADER, ...options.headers } });
  } catch (error) {
    if (error.status === 401 && !url.includes("/auth/")) {
      setSellerHint(false);
      window.location.href = `/seller/login.html?next=${encodeURIComponent(location.pathname + location.search)}`;
      await new Promise(() => {});
    }
    throw error;
  }
}

async function sellerLogout() {
  if (!(await confirmAction({ title: "Log out?", message: "You'll need to sign in again to manage your listings.", confirmText: "Log out" }))) return;
  try {
    await sellerApi("/api/seller/auth/logout", { method: "POST" });
  } finally {
    setSellerHint(false);
    window.location.href = "/";
  }
}

function safeNext(fallback = "/seller/") {
  const next = getQueryParams().next || "";
  return next.startsWith("/seller/") && !next.startsWith("//") ? next : fallback;
}

function sellerState(l) {
  if (l.review_status === "pending") return { key: "pending", label: "In review" };
  if (l.review_status === "rejected") return { key: "rejected", label: "Changes needed" };
  if (l.status === "published") return { key: "published", label: "Live" };
  return { key: "unpublished", label: "Hidden" };
}

function sellerPageHeader(seller) {
  return `
    <nav class="site-header sticky top-0 z-50">
      <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center gap-3">
        <a href="/" class="flex items-center gap-3 flex-shrink-0" aria-label="Frontier Marketplace home">
          <div class="brand-mark-full"><img src="/images/logo-full.jpg" alt="Frontier Farms &amp; Consult"></div>
          <span class="hidden sm:block font-bold text-gray-900">Frontier Marketplace</span>
        </a>
        <div class="ml-auto flex items-center gap-2">
          ${seller ? `<span id="header-seller-name" class="hidden md:inline text-sm text-gray-500 mr-1">${escapeHtml(seller.business_name || seller.name)}</span>` : ""}
          <a href="/" class="hidden sm:inline-flex text-sm font-medium text-gray-600 hover:text-gray-900 px-3 py-2">View website</a>
          ${seller ? notifBellHtml() : ""}
          ${seller ? `<button type="button" data-seller-logout class="text-sm font-medium px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50">Logout</button>` : ""}
        </div>
      </div>
    </nav>`;
}

function bindPasswordToggles(root = document) {
  root.querySelectorAll("[data-toggle-password]").forEach((btn) => {
    btn.innerHTML = `<span class="w-5 h-5 block">${uiIcon("eye")}</span>`;
    btn.addEventListener("click", () => {
      const input = document.getElementById(btn.dataset.togglePassword);
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      btn.innerHTML = `<span class="w-5 h-5 block">${uiIcon(show ? "eyeOff" : "eye")}</span>`;
      btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
    });
  });
}

function showFieldErrors(form, error) {
  form.querySelectorAll(".field-error").forEach((el) => el.classList.add("hidden"));
  form.querySelectorAll(".has-error").forEach((el) => el.classList.remove("has-error"));
  for (const [name, message] of Object.entries(error.errors || {})) {
    form.elements[name]?.classList?.add("has-error");
    const holder = form.querySelector(`[data-error-for="${name}"]`);
    if (holder) {
      holder.textContent = message;
      holder.classList.remove("hidden");
    }
  }
}

async function withBusy(button, busyText, task) {
  const label = button.innerHTML;
  button.disabled = true;
  button.innerHTML = `<span class="btn-spinner"></span> ${escapeHtml(busyText)}`;
  try {
    return await task();
  } finally {
    button.disabled = false;
    button.innerHTML = label;
  }
}

["input", "change"].forEach((type) =>
  document.addEventListener(type, (e) => {
    const input = e.target;
    if (!input.classList?.contains("has-error")) return;
    input.classList.remove("has-error");
    input.form?.querySelector(`[data-error-for="${input.name}"]`)?.classList.add("hidden");
  }),
);

function setBadge(selector, count) {
  document.querySelectorAll(selector).forEach((el) => {
    el.textContent = count > 99 ? "99+" : String(count);
    el.classList.toggle("hidden", !count);
    el.classList.toggle("inline-flex", Boolean(count));
  });
}

const sellerNotifications = {
  items: [],
  unread: 0,
  onNotification: null,

  setCount(n) {
    this.unread = n;
    setBadge("[data-notif-badge]", n);
    document.title = `${n ? `(${n}) ` : ""}My Dashboard - Frontier Marketplace`;
  },

  render() {
    const list = document.getElementById("notifications-list");
    if (!list) return;
    list.innerHTML = this.items.length
      ? this.items.map((n) => `
          <a href="${escapeHtml(n.link || "/seller/")}" data-notif="${n.id}" class="notif-item ${n.read_at ? "" : "is-unread"}">
            <span class="notif-dot" aria-hidden="true"></span>
            <span class="min-w-0 flex-1">
              <span class="block text-sm font-semibold text-gray-900">${escapeHtml(n.title)}</span>
              ${n.body ? `<span class="block text-sm text-gray-600 mt-0.5 line-clamp-2">${escapeHtml(n.body)}</span>` : ""}
              <span class="block text-xs text-gray-400 mt-1">${timeAgo(n.created_at)}</span>
            </span>
          </a>`).join("")
      : `<div class="empty-state"><p class="font-semibold text-gray-800">No notifications yet</p><p class="text-sm mt-1">Updates about your account, listings and messages appear here.</p></div>`;
    list.querySelectorAll("[data-notif]").forEach((a) => a.addEventListener("click", (e) => {
      const target = new URL(a.href, location.origin);
      if (target.pathname === location.pathname) {
        e.preventDefault();
        history.replaceState(null, "", target.pathname + target.search);
        window.dispatchEvent(new CustomEvent("seller:navigate", { detail: Object.fromEntries(target.searchParams) }));
      }
    }));
  },

  async load() {
    try {
      const res = await sellerApi("/api/seller/notifications");
      this.items = res.data;
      this.setCount(res.unread);
      this.render();
    } catch {
    }
  },

  async markAllRead() {
    if (!this.unread) return;
    try {
      const res = await sellerApi("/api/seller/notifications/read", { method: "POST", body: {} });
      this.setCount(res.unread);
    } catch {
    }
  },
};

function initSellerNotifications({ onNotification } = {}) {
  const n = sellerNotifications;
  n.onNotification = onNotification;
  n.load();
  if (window.EventSource) {
    const stream = new EventSource("/api/seller/notifications/stream");
    stream.addEventListener("ready", (e) => n.setCount(JSON.parse(e.data).unread));
    stream.addEventListener("notification", (e) => {
      const { notification, unread } = JSON.parse(e.data);
      n.items = [notification, ...n.items.filter((x) => x.id !== notification.id)].slice(0, 30);
      n.setCount(unread);
      n.render();
      showNotification(notification.title, "info");
      if (n.onNotification) n.onNotification(notification);
    });
    stream.addEventListener("signed-out", () => {
      stream.close();
      setSellerHint(false);
      window.location.href = "/seller/login.html";
    });
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) n.load(); });
}

function notifBellHtml() {
  return `<div class="notif-wrap" id="notif-wrap">
    <button type="button" id="notif-btn" class="notif-btn" aria-label="Notifications" aria-haspopup="true" aria-expanded="false">
      <span class="w-5 h-5 block">${uiIcon("bell")}</span><span id="notif-count" class="notif-count" hidden></span>
    </button>
    <div id="notif-panel" class="notif-panel" hidden>
      <div class="flex items-center justify-between px-4 py-3 border-b border-gray-100">
        <span class="font-semibold text-gray-900 text-sm">Notifications</span>
        <button type="button" id="notif-read-all" class="text-xs font-medium text-blue-700 hover:underline">Mark all as read</button>
      </div>
      <div id="notif-list" class="notif-list"></div>
    </div>
  </div>`;
}

const SELLER_NAV = [
  { key: "overview", icon: "dashboard", label: "Dashboard", short: "Overview" },
  { key: "listings", icon: "listings", label: "My Listings", short: "Listings" },
  { key: "messages", icon: "inbox", label: "Messages", short: "Messages", badge: "unread" },
  { key: "notifications", icon: "bell", label: "Notifications", short: "Alerts", badge: "notif" },
  { key: "profile", icon: "users", label: "Profile", short: "Profile" },
];

const sellerTabHref = (key) => (key === "overview" ? "/seller/" : `/seller/?tab=${key}`);

function renderSellerShell(seller) {
  const sidebar = document.getElementById("app-sidebar");
  sidebar.classList.add("app-sidebar");
  sidebar.innerHTML = `
    <div class="app-sidebar-brand">
      <div class="brand-mark-full"><img src="/images/logo-full.jpg" alt="Frontier Farms &amp; Consult"></div>
      <div class="min-w-0">
        <p class="text-white font-semibold text-sm leading-tight">Frontier Marketplace</p>
        <p class="text-xs" style="color: var(--sidebar-text)">Seller</p>
      </div>
    </div>
    <nav class="app-sidebar-nav">
      ${SELLER_NAV.map((item) => `<a href="${sellerTabHref(item.key)}" data-tab-link="${item.key}">
        ${uiIcon(item.icon)}<span>${item.label}</span>
        ${item.badge ? `<span data-${item.badge}-badge class="nav-badge hidden">0</span>` : ""}
      </a>`).join("")}
      <a href="/" target="_blank" rel="noopener">${uiIcon("external")}<span>View Website</span></a>
    </nav>
    <div class="app-sidebar-footer">
      <p class="text-xs px-3 pb-2 truncate" style="color: var(--sidebar-text)">Signed in as ${escapeHtml(seller.business_name || seller.name)}</p>
      <button type="button" data-seller-logout>${uiIcon("logout")}<span>Logout</span></button>
    </div>`;

  document.getElementById("seller-topbar").innerHTML = `
    <nav id="page-topnav" class="bg-white border-b border-gray-100 sticky top-0 z-50">
      <div class="px-4 sm:px-6 h-16 flex justify-between items-center">
        <a href="/seller/" data-tab-link="overview" class="flex items-center gap-3">
          <div class="brand-mark-full"><img src="/images/logo-full.jpg" alt="Frontier Farms &amp; Consult"></div>
          <span class="font-bold text-gray-900">Seller</span>
        </a>
        <div class="flex items-center gap-2">
          <a href="/" target="_blank" rel="noopener" class="hidden sm:inline-flex text-sm font-medium text-gray-600 hover:text-gray-900 px-3 py-2">View website</a>
          <button type="button" data-seller-logout class="bg-red-600 text-white px-4 py-2 rounded-lg hover:bg-red-700 font-medium text-sm">Logout</button>
        </div>
      </div>
    </nav>`;

  const bottom = document.getElementById("app-bottom-nav");
  bottom.classList.add("app-bottom-nav");
  bottom.dataset.variant = "admin";
  bottom.innerHTML = SELLER_NAV.map((item) => `<a href="${sellerTabHref(item.key)}" data-tab-link="${item.key}">
    <span class="relative inline-flex">${uiIcon(item.icon)}${item.badge ? `<span data-${item.badge}-badge class="hidden absolute -top-1.5 -right-2.5 bg-red-500 text-white text-[10px] font-bold min-w-[16px] h-4 px-1 rounded-full items-center justify-center leading-none">0</span>` : ""}</span><span>${item.short}</span></a>`).join("");

  document.querySelectorAll("[data-seller-logout]").forEach((b) => b.addEventListener("click", sellerLogout));
}

function setSellerNavActive(key) {
  document.querySelectorAll("[data-tab-link]").forEach((a) => {
    if (a.closest("#seller-topbar")) return;
    const on = a.dataset.tabLink === key;
    a.classList.toggle("active", on);
    if (on) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
}

function setUnreadBadge(count) {
  setBadge("[data-unread-badge]", count);
}
