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
          ${seller ? `<div class="notif-wrap" id="notif-wrap">
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
          </div>` : ""}
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

function initSellerNotifications({ onNotification } = {}) {
  const btn = document.getElementById("notif-btn");
  const panel = document.getElementById("notif-panel");
  const list = document.getElementById("notif-list");
  const count = document.getElementById("notif-count");
  if (!btn) return;
  let items = [];

  const setCount = (n) => {
    count.hidden = !n;
    count.textContent = n > 9 ? "9+" : String(n);
    document.title = `${n ? `(${n}) ` : ""}My Dashboard - Frontier Marketplace`;
  };

  const render = () => {
    list.innerHTML = items.length
      ? items.map((n) => `
          <a href="${escapeHtml(n.link || "/seller/")}" data-notif="${n.id}" class="notif-item ${n.read_at ? "" : "is-unread"}">
            <span class="notif-dot" aria-hidden="true"></span>
            <span class="min-w-0">
              <span class="block text-sm font-medium text-gray-900">${escapeHtml(n.title)}</span>
              ${n.body ? `<span class="block text-xs text-gray-600 mt-0.5 line-clamp-2">${escapeHtml(n.body)}</span>` : ""}
              <span class="block text-xs text-gray-400 mt-1">${timeAgo(n.created_at)}</span>
            </span>
          </a>`).join("")
      : `<p class="px-4 py-6 text-sm text-gray-500 text-center">No notifications yet.</p>`;
    list.querySelectorAll("[data-notif]").forEach((a) => a.addEventListener("click", async (e) => {
      const target = new URL(a.href, location.origin);
      const n = items.find((x) => String(x.id) === a.dataset.notif);
      if (n && !n.read_at) {
        n.read_at = new Date().toISOString();
        sellerApi("/api/seller/notifications/read", { method: "POST", body: { ids: [n.id] } }).then((r) => setCount(r.unread)).catch(() => {});
      }
      if (target.pathname === location.pathname) {
        e.preventDefault();
        close();
        history.replaceState(null, "", target.pathname + target.search);
        window.dispatchEvent(new CustomEvent("seller:navigate", { detail: Object.fromEntries(target.searchParams) }));
      }
    }));
  };

  const load = async () => {
    try {
      const res = await sellerApi("/api/seller/notifications");
      items = res.data;
      setCount(res.unread);
      render();
    } catch {
    }
  };

  const open = () => { panel.hidden = false; btn.setAttribute("aria-expanded", "true"); render(); };
  const close = () => { panel.hidden = true; btn.setAttribute("aria-expanded", "false"); };
  btn.addEventListener("click", () => (panel.hidden ? open() : close()));
  document.addEventListener("click", (e) => { if (!e.composedPath().includes(document.getElementById("notif-wrap"))) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  document.getElementById("notif-read-all").addEventListener("click", async () => {
    try {
      const res = await sellerApi("/api/seller/notifications/read", { method: "POST", body: {} });
      items.forEach((n) => (n.read_at = n.read_at || new Date().toISOString()));
      setCount(res.unread);
      render();
    } catch {
    }
  });

  load();
  if (window.EventSource) {
    const stream = new EventSource("/api/seller/notifications/stream");
    stream.addEventListener("ready", (e) => setCount(JSON.parse(e.data).unread));
    stream.addEventListener("notification", (e) => {
      const { notification, unread } = JSON.parse(e.data);
      items = [notification, ...items.filter((n) => n.id !== notification.id)].slice(0, 30);
      setCount(unread);
      render();
      showNotification(notification.title, "info");
      if (onNotification) onNotification(notification);
    });
    stream.addEventListener("signed-out", () => {
      stream.close();
      setSellerHint(false);
      window.location.href = "/seller/login.html";
    });
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
}
