
function renderBottomNav(variant = "public") {
  const mount = document.getElementById("app-bottom-nav");
  if (!mount) return;
  mount.classList.add("app-bottom-nav");
  mount.dataset.variant = variant;

  // Clean page addresses ("/admin/orders", "/admin/"); an old ".html" link is redirected anyway.
  const path = window.location.pathname.replace(/\.html$/, "").replace(/\/index$/, "/");
  const hash = window.location.hash;
  const feedPage = new URLSearchParams(window.location.search).get("kind") === "feed";

  // Signed-in buyer pages: the account tabs themselves (switched in place by the page).
  if (variant === "buyer") {
    const tab = new URLSearchParams(window.location.search).get("tab") || "orders";
    const items = [
      { href: "/", icon: "home", label: "Home" },
      { key: "orders", icon: "cart", label: "Orders", badge: "orders" },
      { key: "notifications", icon: "bell", label: "Notifications", badge: "notifications" },
      { key: "profile", icon: "users", label: "Profile" },
    ];
    mount.innerHTML = items
      .map((i) => `<a href="${i.href || `/account/?tab=${i.key}`}"${i.key ? ` data-tab-link="${i.key}"` : ""} class="${i.key === tab ? "active" : ""}">
        <span class="relative inline-flex">${uiIcon(i.icon)}${i.badge ? `<span data-badge="${i.badge}" hidden class="absolute -top-1.5 -right-2.5 bg-red-500 text-white text-[10px] font-bold min-w-[16px] h-4 px-1 rounded-full items-center justify-center leading-none">0</span>` : ""}</span><span>${i.label}</span></a>`)
      .join("");
    return;
  }

  const tabs =
    variant === "admin"
      ? [
          { href: "/admin/", icon: "dashboard", label: "Overview", match: ["/admin/"] },
          { href: "/admin/livestock", icon: "listings", label: "Livestock", match: ["/admin/livestock"], feed: false },
          { href: "/admin/livestock?kind=feed", icon: "feed", label: "Feed", match: ["/admin/livestock"], feed: true },
          { href: "/admin/inquiries", icon: "inbox", label: "Inquiries", match: ["/admin/inquiries"], badge: true },
          { href: "/admin/orders", icon: "cart", label: "Orders", match: ["/admin/orders"], orderBadge: true },
          { href: "/admin/transactions", icon: "receipt", label: "Transactions", match: ["/admin/transactions"] },
          { href: "/admin/payouts", icon: "wallet", label: "Payouts", match: ["/admin/payouts"] },
          { href: "/admin/transport", icon: "truck", label: "Transport", match: ["/admin/transport", "/admin/transport-providers", "/admin/transport-pricing"] },
          { href: "/admin/sellers", icon: "users", label: "Sellers", match: ["/admin/sellers"] },
          { href: "/admin/breeds", icon: "tag", label: "Breeds", match: ["/admin/breeds"] },
          { href: "/admin/categories", icon: "layers", label: "Categories", match: ["/admin/categories"] },
        ]
      : [
          { href: "/", icon: "home", label: "Home", match: ["/"], exactHash: "" },
          { href: "/#listings", icon: "search", label: "Browse", match: ["/"], exactHash: "#listings" },
          { href: "/#feed", icon: "feed", label: "Feed", match: ["/"], exactHash: "#feed" },
          { href: "/account/", icon: "users", label: "Account",
            match: ["/account/", "/account/login", "/account/register", "/account/forgot", "/account/reset", "/account/verify"] },
        ];

  mount.innerHTML = tabs
    .map((tab) => {
      const active =
        tab.match.includes(path) && (tab.exactHash === undefined || tab.exactHash === hash) &&
        (tab.feed === undefined || tab.feed === feedPage);
      const badgeAttr = tab.badge ? "data-new-badge" : tab.orderBadge ? "data-order-badge" : "";
      const badge = badgeAttr
        ? `<span ${badgeAttr} class="hidden absolute -top-1.5 -right-2.5 bg-red-500 text-white text-[10px] font-bold min-w-[16px] h-4 px-1 rounded-full items-center justify-center leading-none">0</span>`
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
  const feedPage = new URLSearchParams(window.location.search).get("kind") === "feed";
  mount.classList.add("app-sidebar");

  // Grouped under small headings; "section" starts a new group.
  const items = [
    { key: "dashboard", href: "/admin/", icon: "dashboard", label: "Dashboard" },
    { section: "Listings" },
    { key: "livestock", href: "/admin/livestock", icon: "listings", label: "Manage Listing", crumb: "Livestock" },
    { key: "feed", href: "/admin/livestock?kind=feed", icon: "feed", label: "Manage Feed", crumb: "Feed" },
    { section: "Sales" },
    { key: "orders", href: "/admin/orders", icon: "cart", label: "Orders", orderBadge: true },
    { key: "inquiries", href: "/admin/inquiries", icon: "inbox", label: "Inquiries", badge: true },
    { key: "transactions", href: "/admin/transactions", icon: "receipt", label: "Transactions" },
    { key: "payouts", href: "/admin/payouts", icon: "wallet", label: "Payouts" },
    { key: "feedback", href: "/admin/feedback", icon: "star", label: "Feedback" },
    { section: "Transport" },
    { key: "transport", href: "/admin/transport", icon: "truck", label: "Deliveries" },
    { key: "transport-providers", href: "/admin/transport-providers", icon: "users", label: "Transport providers" },
    { key: "transport-pricing", href: "/admin/transport-pricing", icon: "route", label: "Pricing & settings" },
    { section: "People" },
    { key: "sellers", href: "/admin/sellers", icon: "users", label: "Sellers" },
    { section: "Setup" },
    { key: "breeds", href: "/admin/breeds", icon: "tag", label: "Breeds" },
    {
      key: "categories", href: "/admin/categories", icon: "layers", label: "Categories & Purposes",
      children: [
        { href: "/admin/categories", label: "Livestock", feed: false },
        { href: "/admin/categories?kind=feed", label: "Feed", feed: true },
      ],
    },
    { section: "Website" },
    { key: "site", href: "/", icon: "external", label: "Shop Now", external: true },
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
          (item) => item.section ? `<p class="app-sidebar-section">${item.section}</p>` : `<a href="${item.href}" class="${item.key === active ? "active" : ""}"${item.crumb ? ` data-crumb-label="${item.crumb}"` : ""}${item.external ? ' target="_blank" rel="noopener"' : ""}>
            ${uiIcon(item.icon)}<span>${item.label}</span>
            ${item.badge ? '<span data-new-badge class="nav-badge hidden">0</span>' : ""}
            ${item.orderBadge ? '<span data-order-badge class="nav-badge hidden">0</span>' : ""}
          </a>${item.children ? `<div class="app-sidebar-sub">${item.children.map((c) => {
            const on = item.key === active && c.feed === feedPage;
            return `<a href="${c.href}" class="${on ? "active" : ""}"${on ? ' aria-current="page"' : ""}>${c.label}</a>`;
          }).join("")}</div>` : ""}`,
        )
        .join("")}
    </nav>
    <div class="app-sidebar-footer">
      <p id="sidebar-admin-name" class="text-xs px-3 pb-2 truncate" style="color: var(--sidebar-text)"></p>
      <button type="button" data-logout>${uiIcon("logout")}<span>Logout</span></button>
    </div>`;
}

function setNewOrderBadge(count) {
  document.querySelectorAll("[data-order-badge]").forEach((el) => {
    el.textContent = count > 99 ? "99+" : String(count);
    el.classList.toggle("hidden", !count);
    el.classList.toggle("inline-flex", Boolean(count));
  });
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
