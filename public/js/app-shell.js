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
    // Signed-in app pages (Dashboard/Messages/Profile): no Marketplace tab -
    // those pages are about managing your own account, not browsing.
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
    // Home already surfaces the full listings feed and its own filters, so
    // there's no separate Market tab here - just Home, Sell, Chat, Account.
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

  mount.innerHTML = tabs
    .map(
      (tab) =>
        `<a href="${tab.href}" class="${tab.active ? "active" : ""}">${uiIcon(tab.icon)}<span>${tab.label}</span></a>`,
    )
    .join("");

  setupTabRouterLinks(mount, variant);
}

function renderSidebar(active) {
  const mount = document.getElementById("app-sidebar");
  if (!mount) return;
  mount.classList.add("app-sidebar");

  const user = getCurrentUser();
  const items = [
    { key: "dashboard", href: "/dashboard.html", icon: "dashboard", label: "Overview" },
    { key: "messages", href: "/messages.html", icon: "messages", label: "Messages" },
  ];
  if (user?.role === "seller") {
    items.push({
      key: "listings",
      href: "/listing.html?mine=1",
      icon: "listings",
      label: "My Listings",
    });
  }
  items.push({ key: "profile", href: "/profile.html", icon: "profile", label: "Profile" });

  mount.innerHTML = `
    <div class="app-sidebar-brand">
      <div class="brand-mark-full"><img src="/images/logo-full.jpg" alt="Frontier Farms &amp; Consult"></div>
    </div>
    <nav class="app-sidebar-nav">
      ${items
        .map(
          (item) =>
            `<a href="${item.href}" class="${item.key === active ? "active" : ""}">${uiIcon(item.icon)}<span>${item.label}</span></a>`,
        )
        .join("")}
    </nav>
    <div class="app-sidebar-footer">
      <button type="button" id="app-shell-logout">${uiIcon("logout")}<span>Logout</span></button>
    </div>
  `;

  document.getElementById("app-shell-logout")?.addEventListener("click", async () => {
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
  if (!document.getElementById("tab-self-content") || !document.getElementById("tab-frame-host")) {
    return;
  }

  mount.querySelectorAll("a[href]").forEach((link) => {
    link.addEventListener("click", (event) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      let url;
      try {
        url = new URL(link.getAttribute("href"), window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) return;

      event.preventDefault();
      showTab(url);
      history.pushState({ tabKey: tabKeyFor(url) }, "", url.pathname + url.search);
      renderBottomNav(variant);
    });
  });
}

window.addEventListener("popstate", () => {
  if (!document.getElementById("tab-self-content") || !document.getElementById("tab-frame-host")) {
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
    if (menu.classList.contains("hidden") || menu.contains(event.target) || event.target === toggle) return;
    menu.classList.add("hidden");
    toggle.setAttribute("aria-expanded", "false");
  });
});
