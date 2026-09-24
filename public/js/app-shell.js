// Shared "app shell" chrome: the mobile bottom tab bar (every page) and the
// desktop sidebar (the signed-in dashboard/messages/profile pages). Reads
// auth state via getCurrentUser() from auth.js and icons from species.js, so
// both must be loaded first.

function renderBottomNav(variant = "public") {
  const mount = document.getElementById("app-bottom-nav");
  if (!mount) return;
  mount.classList.add("app-bottom-nav");
  mount.dataset.variant = variant;

  const path = window.location.pathname;
  const isActive = (matches) => matches.some((candidate) => path === candidate);

  const TABS_BY_VARIANT = {
    admin: [
      {
        href: "/admin/index.html",
        icon: "dashboard",
        label: "Overview",
        active: isActive(["/admin/index.html", "/admin/"]),
      },
      {
        href: "/admin/listings.html",
        icon: "listings",
        label: "Listings",
        active: isActive(["/admin/listings.html"]),
      },
      {
        href: "/admin/users.html",
        icon: "users",
        label: "Users",
        active: isActive(["/admin/users.html"]),
      },
      {
        href: "/admin/reports.html",
        icon: "reports",
        label: "Reports",
        active: isActive(["/admin/reports.html"]),
      },
      { href: "/dashboard.html", icon: "home", label: "Site", active: false },
    ],
    app: [
      {
        href: "/dashboard.html",
        icon: "dashboard",
        label: "Home",
        active: isActive(["/dashboard.html"]),
      },
      {
        href: "/listing.html?create=1",
        icon: "plus",
        label: "Sell",
        active: isActive(["/listing.html"]),
      },
      {
        href: "/messages.html",
        icon: "messages",
        label: "Chat",
        active: isActive(["/messages.html"]),
      },
      {
        href: "/profile.html",
        icon: "profile",
        label: "Account",
        active: isActive(["/profile.html"]),
      },
    ],
    public: [
      {
        href: "/index.html",
        icon: "home",
        label: "Home",
        active: isActive(["/", "/index.html"]),
      },
      {
        href: "/listing.html?create=1",
        icon: "plus",
        label: "Sell",
        active: isActive(["/listing.html"]),
      },
      {
        href: "/messages.html",
        icon: "messages",
        label: "Chat",
        active: isActive(["/messages.html"]),
      },
      {
        href: "/profile.html",
        icon: "profile",
        label: "Account",
        active: isActive(["/profile.html"]),
      },
    ],
  };

  const tabs = TABS_BY_VARIANT[variant] || TABS_BY_VARIANT.public;

  // Chat tab gets an unread badge. The icon is wrapped in a relative span so
  // the badge can anchor to its top-right corner; other tabs render the icon
  // plain, unchanged from before.
  mount.innerHTML = tabs
    .map((tab) => {
      const isChat =
        typeof tab.href === "string" && tab.href.includes("messages.html");
      const iconBlock = isChat
        ? `<span class="relative inline-flex">${uiIcon(tab.icon)}<span data-unread-badge class="hidden absolute -top-1.5 -right-2 bg-red-500 text-white text-[10px] font-bold min-w-[16px] h-4 px-1 rounded-full flex items-center justify-center leading-none">0</span></span>`
        : uiIcon(tab.icon);
      return `<a href="${tab.href}" class="${tab.active ? "active" : ""}">${iconBlock}<span>${tab.label}</span></a>`;
    })
    .join("");

  setupTabRouterLinks(mount, variant);
}

function renderSidebar(active) {
  const mount = document.getElementById("app-sidebar");
  if (!mount) return;
  mount.classList.add("app-sidebar");

  const user = getCurrentUser();
  const isAdminSection = window.location.pathname.startsWith("/admin/");

  let items;
  if (isAdminSection) {
    items = [
      {
        key: "admin-dashboard",
        href: "/admin/index.html",
        icon: "dashboard",
        label: "Dashboard",
      },
      {
        key: "admin-users",
        href: "/admin/users.html",
        icon: "users",
        label: "Manage Users",
      },
      {
        key: "admin-listings",
        href: "/admin/listings.html",
        icon: "listings",
        label: "Moderate Listings",
      },
      {
        key: "admin-reports",
        href: "/admin/reports.html",
        icon: "reports",
        label: "View Reports",
      },
      {
        key: "admin-back",
        href: "/dashboard.html",
        icon: "home",
        label: "Back to Site",
      },
    ];
  } else {
    items = [
      {
        key: "dashboard",
        href: "/dashboard.html",
        icon: "dashboard",
        label: "Overview",
      },
      {
        key: "messages",
        href: "/messages.html",
        icon: "messages",
        label: "Messages",
      },
    ];
    if (user?.role === "member") {
      items.push({
        key: "listings",
        href: "/listing.html?mine=1",
        icon: "listings",
        label: "My Listings",
      });
    }
    items.push({
      key: "profile",
      href: "/profile.html",
      icon: "profile",
      label: "Profile",
    });
  }

  // Same badge as the mobile tab bar, but pushed to the far right of the
  // sidebar item via ml-auto. Only the Messages row gets one.
  mount.innerHTML = `
    <div class="app-sidebar-brand">
      <div class="brand-mark-full"><img src="/images/logo-full.jpg" alt="Frontier Farms &amp; Consult"></div>
    </div>
    <nav class="app-sidebar-nav">
      ${items
        .map((item) => {
          const isMessages =
            typeof item.href === "string" &&
            item.href.includes("messages.html");
          const badge = isMessages
            ? `<span data-unread-badge class="hidden ml-auto bg-red-500 text-white text-[10px] font-bold min-w-[18px] h-4 px-1 rounded-full flex items-center justify-center leading-none">0</span>`
            : "";
          return `<a href="${item.href}" class="${item.key === active ? "active" : ""}">${uiIcon(item.icon)}<span>${item.label}</span>${badge}</a>`;
        })
        .join("")}
    </nav>
    <div class="app-sidebar-footer">
      <button type="button" id="app-shell-logout">${uiIcon("logout")}<span>Logout</span></button>
    </div>
  `;

  document
    .getElementById("app-shell-logout")
    ?.addEventListener("click", async () => {
      await logout();
    });
}

function renderAppShell(options = {}) {
  const { active = null, bottomNavVariant = "public" } = options;
  renderSidebar(active);
  renderBottomNav(bottomNavVariant);
}

// If this document is loaded inside another page's tab-frame iframe (see
// setupTabRouterLinks below), suppress this page's own header/bottom-nav/
// sidebar via CSS so the outer shell's chrome is the only copy visible.
// Runs immediately - this script is loaded blocking in <head> - so there's
// no flash of a duplicate header before the class takes effect.
if (window.self !== window.top) {
  document.documentElement.classList.add("embedded-tab");
}

// A "/" and "/index.html" request are the same page for tab-matching
// purposes; nothing else in this app is reachable under more than one path.
function tabNormalizedPath(pathname) {
  return pathname === "/" ? "/index.html" : pathname;
}

function tabKeyFor(url) {
  return tabNormalizedPath(url.pathname) + url.search;
}

// Captured once, before any pushState from tab switching rewrites
// window.location - this is what #tab-self-content actually contains,
// regardless of which tab's URL the address bar currently shows.
const TAB_SELF_KEY = tabKeyFor(new URL(window.location.href));

function showTabSelfContent() {
  document.getElementById("tab-self-content")?.classList.remove("hidden");
  document.getElementById("tab-frame-host")?.classList.add("hidden");
}

function showTabFrame(url) {
  document.getElementById("tab-self-content")?.classList.add("hidden");
  const host = document.getElementById("tab-frame-host");
  if (!host) return;
  host.classList.remove("hidden");

  const key = tabKeyFor(url);
  const frames = Array.from(host.querySelectorAll(".tab-frame"));
  frames.forEach((frame) => {
    frame.classList.toggle("active", frame.dataset.tabKey === key);
  });

  if (!frames.some((frame) => frame.dataset.tabKey === key)) {
    const frame = document.createElement("iframe");
    frame.className = "tab-frame active";
    frame.dataset.tabKey = key;
    frame.src = url.pathname + url.search;
    host.appendChild(frame);
  }
}

// Renders a tab as either the already-loaded page (shown in place) or a
// same-origin iframe kept alive in the background (see the CSS block for
// .tab-frame-host in style.css). Pages that don't have the #tab-self-content
// / #tab-frame-host scaffolding (e.g. the admin panel, login, register) are
// left on ordinary <a href> navigation - this is purely additive.
function showTab(url) {
  if (tabKeyFor(url) === TAB_SELF_KEY) {
    showTabSelfContent();
  } else {
    showTabFrame(url);
  }
}

function setupTabRouterLinks(mount, variant) {
  if (
    !document.getElementById("tab-self-content") ||
    !document.getElementById("tab-frame-host")
  ) {
    return;
  }

  mount.querySelectorAll("a[href]").forEach((link) => {
    link.addEventListener("click", (event) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
        return;

      let url;
      try {
        url = new URL(link.getAttribute("href"), window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) return;

      event.preventDefault();
      showTab(url);
      history.pushState(
        { tabKey: tabKeyFor(url) },
        "",
        url.pathname + url.search,
      );
      renderBottomNav(variant);
    });
  });
}

window.addEventListener("popstate", () => {
  if (
    !document.getElementById("tab-self-content") ||
    !document.getElementById("tab-frame-host")
  ) {
    return;
  }
  showTab(new URL(window.location.href));
  const mount = document.getElementById("app-bottom-nav");
  if (mount?.dataset.variant) renderBottomNav(mount.dataset.variant);
});

// Desktop header's signed-out account icon (Login/Register). A no-op on
// pages without it, so it's safe to self-initialize on every page.
document.addEventListener("DOMContentLoaded", () => {
  const toggle = document.getElementById("nav-auth-toggle");
  const menu = document.getElementById("nav-auth-menu");
  if (!toggle || !menu) return;

  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    const isOpen = !menu.classList.contains("hidden");
    menu.classList.toggle("hidden", isOpen);
    toggle.setAttribute("aria-expanded", String(!isOpen));
  });

  document.addEventListener("click", (event) => {
    if (
      menu.classList.contains("hidden") ||
      menu.contains(event.target) ||
      event.target === toggle
    )
      return;
    menu.classList.add("hidden");
    toggle.setAttribute("aria-expanded", "false");
  });
});

// ============================================================================
// Unread message + inquiry badge
// ============================================================================
// The Chat tab in the bottom nav and the "Messages" item in the sidebar show
// a live count of unread conversations plus pending inquiries (where the
// current user is the seller). Updates are event-driven via Socket.IO rather
// than polled, so the number moves the moment something happens.

let badgeSocket = null;

async function ensureSocketIO() {
  if (window.io) return true;
  return new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = "https://cdn.socket.io/4.5.4/socket.io.min.js";
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.head.appendChild(script);
  });
}

function renderUnreadBadges(total) {
  document.querySelectorAll("[data-unread-badge]").forEach((el) => {
    if (total > 0) {
      el.textContent = total > 99 ? "99+" : String(total);
      el.classList.remove("hidden");
    } else {
      el.classList.add("hidden");
      el.textContent = "0";
    }
  });
}

async function refreshUnreadBadge() {
  const user = getCurrentUser();
  if (!user) {
    renderUnreadBadges(0);
    return;
  }
  try {
    const [messagesRes, inquiriesRes] = await Promise.all([
      fetch("/api/messages", { credentials: "same-origin" }),
      fetch("/api/inquiries", { credentials: "same-origin" }),
    ]);
    const messagesData = messagesRes.ok ? await messagesRes.json() : null;
    const inquiriesData = inquiriesRes.ok ? await inquiriesRes.json() : null;

    const unreadMessages = messagesData?.success
      ? (messagesData.data || []).reduce(
          (sum, conv) => sum + (Number(conv.unread_count) || 0),
          0,
        )
      : 0;

    // Only inquiries that are still pending AND were received by this user
    // (i.e. they're the seller). Inquiries the user sent themselves don't
    // need their attention, so they don't pin the badge.
    const pendingInquiries = inquiriesData?.success
      ? (inquiriesData.data || []).filter(
          (inq) => inq.status === "pending" && inq.seller_id === user.id,
        ).length
      : 0;

    renderUnreadBadges(unreadMessages + pendingInquiries);
  } catch {
    // Silent - the next event (or visibility change) will retry.
  }
}

async function connectBadgeSocket() {
  if (badgeSocket) return;
  const ok = await ensureSocketIO();
  if (!ok || !window.io) return;

  badgeSocket = io();

  const onEvent = () => refreshUnreadBadge();
  badgeSocket.on("receive_message", onEvent);
  badgeSocket.on("new_inquiry", onEvent);
  badgeSocket.on("inquiry_updated", onEvent);
  badgeSocket.on("messages_read", onEvent);

  // If the socket dropped and reconnected while the tab was inactive, do a
  // one-shot refresh so we're not showing a stale count.
  badgeSocket.on("connect", onEvent);
}

async function startUnreadBadgePolling() {
  if (window.self !== window.top) return;
  if (!document.querySelector("[data-unread-badge]")) return;
  if (!getCurrentUser()) return;

  await refreshUnreadBadge();
  await connectBadgeSocket();

  // Safety net: if the tab was hidden and socket events were missed while
  // the browser throttled background connections, refresh on focus.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshUnreadBadge();
  });
}

window.refreshUnreadBadge = refreshUnreadBadge;

if (typeof window !== "undefined") {
  document.addEventListener("DOMContentLoaded", startUnreadBadgePolling);
}
