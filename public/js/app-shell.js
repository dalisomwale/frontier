
function renderBottomNav(variant = "public") {
  const mount = document.getElementById("app-bottom-nav");
  if (!mount) return;
  mount.classList.add("app-bottom-nav");
  mount.dataset.variant = variant;

  const path = window.location.pathname.replace(/\/$/, "/index.html");
  const hash = window.location.hash;

  const tabs =
    variant === "admin"
      ? [
          { href: "/admin/index.html", icon: "dashboard", label: "Overview", match: ["/admin/index.html"] },
          { href: "/admin/livestock.html", icon: "listings", label: "Livestock", match: ["/admin/livestock.html"] },
          { href: "/admin/inquiries.html", icon: "inbox", label: "Inquiries", match: ["/admin/inquiries.html"], badge: true },
          { href: "/admin/sellers.html", icon: "users", label: "Sellers", match: ["/admin/sellers.html"] },
          { href: "/admin/categories.html", icon: "layers", label: "Animals", match: ["/admin/categories.html"] },
          { href: "/admin/breeds.html", icon: "tag", label: "Breeds", match: ["/admin/breeds.html"] },
        ]
      : [
          { href: "/", icon: "home", label: "Home", match: ["/index.html"], exactHash: "" },
          { href: "/#listings", icon: "search", label: "Browse", match: ["/index.html"], exactHash: "#listings" },
          { href: "/#categories", icon: "layers", label: "Categories", match: ["/index.html"], exactHash: "#categories" },
        ];

  mount.innerHTML = tabs
    .map((tab) => {
      const active =
        tab.match.includes(path) && (tab.exactHash === undefined || tab.exactHash === hash);
      const badge = tab.badge
        ? `<span data-new-badge class="hidden absolute -top-1.5 -right-2.5 bg-red-500 text-white text-[10px] font-bold min-w-[16px] h-4 px-1 rounded-full items-center justify-center leading-none">0</span>`
        : "";
      return `<a href="${tab.href}" class="${active ? "active" : ""}"${active ? ' aria-current="page"' : ""}>
        <span class="relative inline-flex">${uiIcon(tab.icon)}${badge}</span><span>${tab.label}</span></a>`;
    })
    .join("");

  if (variant === "public") {
    mount.querySelectorAll("a").forEach((link) =>
      link.addEventListener("click", () => setTimeout(() => renderBottomNav("public"), 50)),
    );
  }
}

function renderSidebar(active) {
  const mount = document.getElementById("app-sidebar");
  if (!mount) return;
  mount.classList.add("app-sidebar");

  const items = [
    { key: "dashboard", href: "/admin/index.html", icon: "dashboard", label: "Dashboard" },
    { key: "livestock", href: "/admin/livestock.html", icon: "listings", label: "Livestock" },
    { key: "inquiries", href: "/admin/inquiries.html", icon: "inbox", label: "Inquiries", badge: true },
    { key: "sellers", href: "/admin/sellers.html", icon: "users", label: "Sellers" },
    { key: "categories", href: "/admin/categories.html", icon: "layers", label: "Animals & Purposes" },
    { key: "breeds", href: "/admin/breeds.html", icon: "tag", label: "Breeds" },
    { key: "site", href: "/", icon: "external", label: "View Website", external: true },
  ];

  mount.innerHTML = `
    <div class="app-sidebar-brand">
      <div class="brand-mark-full"><img src="/images/logo-full.jpg" alt="Frontier Farms &amp; Consult"></div>
      <div class="min-w-0">
        <p class="text-white font-semibold text-sm leading-tight">Frontier Marketplace</p>
        <p class="text-xs" style="color: var(--sidebar-text)">Admin</p>
      </div>
    </div>
    <nav class="app-sidebar-nav">
      ${items
        .map(
          (item) => `<a href="${item.href}" class="${item.key === active ? "active" : ""}"${item.external ? ' target="_blank" rel="noopener"' : ""}>
            ${uiIcon(item.icon)}<span>${item.label}</span>
            ${item.badge ? '<span data-new-badge class="nav-badge hidden">0</span>' : ""}
          </a>`,
        )
        .join("")}
    </nav>
    <div class="app-sidebar-footer">
      <p id="sidebar-admin-name" class="text-xs px-3 pb-2 truncate" style="color: var(--sidebar-text)"></p>
      <button type="button" data-logout>${uiIcon("logout")}<span>Logout</span></button>
    </div>`;
}

function setNewInquiryBadge(count) {
  document.querySelectorAll("[data-new-badge]").forEach((el) => {
    el.textContent = count > 99 ? "99+" : String(count);
    el.classList.toggle("hidden", !count);
    el.classList.toggle("inline-flex", Boolean(count));
  });
}

window.addEventListener("hashchange", () => {
  const mount = document.getElementById("app-bottom-nav");
  if (mount?.dataset.variant === "public") renderBottomNav("public");
});
