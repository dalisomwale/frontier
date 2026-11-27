
const ZAMBIA_PROVINCES = [
  "Central",
  "Copperbelt",
  "Eastern",
  "Luapula",
  "Lusaka",
  "Muchinga",
  "Northern",
  "North-Western",
  "Southern",
  "Western",
];

const LIVESTOCK_TYPES_BY_ANIMAL = {
  Cattle: ["Bull", "Cow", "Heifer", "Steer", "Calf", "Mixed"],
  Goats: ["Buck", "Doe", "Kid", "Wether", "Mixed"],
  Sheep: ["Ram", "Ewe", "Lamb", "Wether", "Mixed"],
  Pigs: ["Boar", "Sow", "Gilt", "Weaner", "Porker", "Mixed"],
  Poultry: ["Hen", "Cock", "Pullet", "Point-of-lay", "Chicks", "Mixed"],
  GENERIC: ["Male", "Female", "Young", "Mixed"],
};

function isAllBreedsPurpose(name) {
  return String(name || "").toLowerCase().replace(/[^a-z]/g, "") === "dualpurpose";
}

function livestockTypesFor(animalName) {
  return LIVESTOCK_TYPES_BY_ANIMAL[animalName] || LIVESTOCK_TYPES_BY_ANIMAL.GENERIC;
}

function quantityLabel(quantity, animalName, kind) {
  const n = Number(quantity) || 0;
  if (kind === "feed") return `${n.toLocaleString()} ${n === 1 ? "bag" : "bags"}`;
  return `${n.toLocaleString()} ${animalName === "Poultry" ? (n === 1 ? "bird" : "birds") : "head"}`;
}

async function apiRequest(url, options = {}) {
  const headers = { ...options.headers };
  let body = options.body;
  if (body !== undefined && !(body instanceof FormData) && typeof body !== "string") {
    body = JSON.stringify(body);
  }
  if (body !== undefined && !(body instanceof FormData) && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  let response;
  try {
    response = await fetch(url, { ...options, body, headers, credentials: "same-origin" });
  } catch {
    const error = new Error("Can't reach the server. Please check your connection and try again.");
    error.status = 0;
    throw error;
  }

  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json")
    ? await response.json()
    : { success: false, message: "The server returned an unexpected response." };

  if (!response.ok || data.success === false) {
    const error = new Error(data.message || "Request failed");
    error.status = response.status;
    error.errors = data.errors || null;
    throw error;
  }
  return data;
}

function showNotification(message, type = "info") {
  const colors = {
    success: "bg-green-600",
    error: "bg-red-600",
    warning: "bg-yellow-500",
    info: "bg-green-800",
  };
  const note = document.createElement("div");
  note.setAttribute("role", type === "error" ? "alert" : "status");
  note.className = `fixed top-4 right-4 left-4 sm:left-auto sm:max-w-sm p-4 rounded-lg text-white shadow-lg z-[200] animate-fade-in ${colors[type] || colors.info}`;
  note.textContent = message;
  document.body.appendChild(note);
  setTimeout(() => note.remove(), type === "error" ? 5000 : 3200);
}

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[c],
  );
}

function formatDate(value) {
  return new Date(value).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDateShort(value) {
  return new Date(value).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function timeAgo(value) {
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const units = [
    ["year", 31536000],
    ["month", 2592000],
    ["week", 604800],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [unit, size] of units) {
    const n = Math.floor(seconds / size);
    if (n >= 1) return `${n} ${unit}${n > 1 ? "s" : ""} ago`;
  }
  return "just now";
}

function getQueryParams() {
  return Object.fromEntries(new URLSearchParams(window.location.search));
}

function createPagination(currentPage, totalPages, onPageChange) {
  const nav = document.createElement("nav");
  nav.className = "flex justify-center items-center gap-2 mt-8 flex-wrap";
  nav.setAttribute("aria-label", "Pagination");

  const button = (label, page, { disabled = false, active = false } = {}) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    btn.disabled = disabled;
    btn.className = `px-4 py-2 border rounded-lg disabled:opacity-50 ${
      active ? "bg-green-800 text-white border-green-800" : "border-gray-300 bg-white hover:bg-gray-50"
    }`;
    if (active) btn.setAttribute("aria-current", "page");
    btn.addEventListener("click", () => onPageChange(page));
    nav.appendChild(btn);
  };

  button("Previous", currentPage - 1, { disabled: currentPage <= 1 });
  for (let i = Math.max(1, currentPage - 2); i <= Math.min(totalPages, currentPage + 2); i++) {
    button(String(i), i, { active: i === currentPage });
  }
  button("Next", currentPage + 1, { disabled: currentPage >= totalPages });
  return nav;
}

function confirmAction({
  title = "Are you sure?",
  message = "",
  confirmText = "Confirm",
  cancelText = "Cancel",
  variant = "primary",
} = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "fixed inset-0 z-[150] flex items-center justify-center bg-black bg-opacity-50 p-4";
    const confirmClass =
      variant === "danger" ? "bg-red-600 hover:bg-red-700 text-white" : "btn-grad";

    overlay.innerHTML = `
      <div class="bg-white rounded-xl shadow-xl max-w-sm w-full p-6" role="dialog" aria-modal="true" aria-labelledby="confirm-action-title">
        <h3 id="confirm-action-title" class="text-lg font-bold text-gray-900 mb-2">${escapeHtml(title)}</h3>
        ${message ? `<p class="text-sm text-gray-600 mb-6 whitespace-pre-line">${escapeHtml(message)}</p>` : `<div class="mb-6"></div>`}
        <div class="flex gap-3 justify-end">
          <button type="button" data-confirm-cancel class="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 font-medium">${escapeHtml(cancelText)}</button>
          <button type="button" data-confirm-ok class="px-4 py-2 rounded-lg font-medium ${confirmClass}">${escapeHtml(confirmText)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const onKey = (event) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      finish(false);
    };
    function finish(result) {
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(result);
    }
    overlay.querySelector("[data-confirm-ok]").addEventListener("click", () => finish(true));
    overlay.querySelector("[data-confirm-cancel]").addEventListener("click", () => finish(false));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) finish(false);
    });
    document.addEventListener("keydown", onKey, true);
    overlay.querySelector("[data-confirm-ok]").focus();
  });
}

// The cartoon for each icon of an empty message (errors keep the plain icon).
const EMPTY_ART = { listings: "cow", cattle: "cow", tag: "cow", layers: "sack", feed: "sack", inbox: "box", send: "chat", mail: "chat", check: "check", users: "badge", search: "search", cart: "cart", bell: "bell", star: "star", truck: "truck", chat: "chat" };
function renderEmptyState(container, { title = "Nothing here yet", message = "", icon = "listings", action = "", art } = {}) {
  const pic = art === false ? "" : emptyArt(art || EMPTY_ART[icon] || "");
  container.innerHTML = `
    <div class="empty-state col-span-full">
      ${pic || `<div class="empty-icon">${typeof uiIcon === "function" ? uiIcon(icon) : ""}</div>`}
      <p class="font-semibold text-gray-800">${escapeHtml(title)}</p>
      ${message ? `<p class="text-sm mt-1">${escapeHtml(message)}</p>` : ""}
      ${action}
    </div>`;
}

function renderSkeletonCards(container, count = 8) {
  container.innerHTML = Array.from({ length: count })
    .map(
      () => `
      <div class="bg-white rounded-lg border border-gray-200 overflow-hidden animate-pulse">
        <div class="bg-gray-200 aspect-[4/3]"></div>
        <div class="p-3 space-y-2">
          <div class="h-4 bg-gray-200 rounded w-3/4"></div>
          <div class="h-3 bg-gray-200 rounded w-1/2"></div>
          <div class="h-9 bg-gray-100 rounded mt-3"></div>
        </div>
      </div>`,
    )
    .join("");
}

// The public site footer, the same on every page (<footer id="site-footer">).
function renderSiteFooter() {
  const el = document.getElementById("site-footer");
  if (!el) return;
  el.classList.add("site-footer");
  const link = (href, text) => `<a href="${href}">${text}</a>`;
  // The newsletter sign-up: its own band just above the footer, on the home
  // page only.
  const home = /^\/(index(\.html)?)?$/.test(location.pathname);
  if (home && !document.querySelector(".news-band")) {
    const band = document.createElement("section");
    band.className = "news-band";
    band.setAttribute("aria-labelledby", "news-title");
    band.innerHTML = `
      <div class="news-band-inner">
        <h2 id="news-title">Subscribe To Our Newsletter</h2>
        <p class="news-band-sub">News, promotions and fresh livestock and feed, straight to your inbox.</p>
        <form class="news-band-form" data-news-form novalidate>
          <div class="news-band-row">
            <label class="sr-only" for="news-email">Email address</label>
            <input id="news-email" type="email" name="email" placeholder="Your email address" autocomplete="email" maxlength="255" required>
            <input type="text" name="website" class="news-band-hp" tabindex="-1" autocomplete="off" aria-hidden="true">
            <button type="submit">Subscribe</button>
          </div>
          <p class="news-band-msg" data-news-msg role="status" hidden></p>
        </form>
      </div>`;
    el.before(band);
  }
  el.innerHTML = `
    <div class="site-footer-inner">
      <div class="site-footer-grid">
        <div class="site-footer-brand">
          <a href="/" class="site-footer-logo" aria-label="Frontier Marketplace home">
            <span class="site-footer-mark"><img src="/images/logo-full.jpg" alt="" loading="lazy"></span>
            <span><strong>Frontier Marketplace</strong><small>by Frontier Farms &amp; Consult</small></span>
          </a>
          <p>Buy and sell livestock and animal feed from farmers across Zambia.</p>
        </div>
        <nav class="site-footer-col" aria-label="Browse">
          <h2>Browse</h2>
          ${link("/#listings", "Livestock")}
          ${link("/#feed", "Animal Feed")}
        </nav>
        <nav class="site-footer-col" aria-label="Work with us">
          <h2>Work With Us</h2>
          ${link("/seller/register", "Register as a seller")}
          ${link("/seller/login", "Seller sign in")}
          ${link("/transport/register", "Register as a transport provider")}
          ${link("/transport/login", "Transport provider sign in")}
        </nav>
        <nav class="site-footer-col" aria-label="Policies">
          <h2>Policies</h2>
          ${link("/terms", "Terms of Service")}
          ${link("/privacy", "Privacy Policy")}
          ${link("/refund-policy", "Refund Policy")}
          ${link("/return-policy", "Return Policy")}
          ${link("/cancellation-policy", "Cancellation Policy")}
        </nav>
        <div class="site-footer-col site-footer-contact">
          <h2>Contact Us</h2>
          <a href="mailto:info@frontierfc.co.zm">info@frontierfc.co.zm</a>
          <a href="tel:+260974129569">+260 974 129 569</a>
          <a href="tel:+260974594174">+260 974 594 174</a>
          <p>Piziya Office Park, Plot 2374 Thabo Mbeki Road, Lusaka</p>
          ${link("/contact", "All contact details")}
        </div>
      </div>
      <div class="site-footer-bottom">
        <p>&copy; ${new Date().getFullYear()} Frontier Farms &amp; Consult. All rights reserved.</p>
      </div>
    </div>`;
}
document.addEventListener("DOMContentLoaded", renderSiteFooter);

// Newsletter sign-up in the footer.
document.addEventListener("submit", async (event) => {
  const form = event.target.closest && event.target.closest("[data-news-form]");
  if (!form) return;
  event.preventDefault();
  const msg = form.querySelector("[data-news-msg]");
  const button = form.querySelector("button[type=submit]");
  const show = (text, ok) => { msg.textContent = text; msg.hidden = false; msg.classList.toggle("is-error", !ok); };
  const email = form.email.value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    show("Please enter a valid email address.", false);
    return form.email.focus();
  }
  button.disabled = true;
  const label = button.textContent;
  button.textContent = "Subscribing…";
  try {
    const res = await apiRequest("/api/newsletter/subscribe", { method: "POST", body: { email, website: form.website.value } });
    show(res.message, true);
    form.email.value = "";
  } catch (error) {
    show((error.errors && error.errors.email) || error.message, false);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
});

const SELLER_HINT_KEY = "frontier.seller";

function setSellerHint(signedIn) {
  try {
    if (signedIn) localStorage.setItem(SELLER_HINT_KEY, "1");
    else localStorage.removeItem(SELLER_HINT_KEY);
  } catch {
  }
}

async function initSellerLink() {
  const link = document.getElementById("seller-link");
  if (!link) return;
  let hinted = false;
  try {
    hinted = localStorage.getItem(SELLER_HINT_KEY) === "1";
  } catch {
  }
  if (!hinted) return;
  try {
    const res = await fetch("/api/seller/auth/me", { credentials: "same-origin" });
    if (!res.ok) return setSellerHint(false);
    link.href = "/seller/";
    link.textContent = "My Dashboard";
    const login = document.getElementById("login-link");
    if (login) login.hidden = true;
  } catch {
  }
}
document.addEventListener("DOMContentLoaded", initSellerLink);

// Photo picker for handover proof: a grid with "Add photo" and remove
// buttons. Returns { files() } with the chosen File objects.
// One proof file as a link: a photo thumbnail, or a "PDF" tile for a PDF.
function proofFileHtml(path, thumb, alt = "Photo") {
  const href = escapeHtml(path || "");
  if (/\.pdf$/i.test(path || "")) {
    return `<a href="${href}" target="_blank" rel="noopener" class="proof-pdf" title="Open the PDF">${uiIcon("receipt")}<span>PDF</span></a>`;
  }
  return `<a href="${href}" target="_blank" rel="noopener"><img src="${escapeHtml(thumb || path || "")}" alt="${escapeHtml(alt)}"></a>`;
}

// opts.pdf: also take PDF files (used for proof of payment).
function bindPhotoPicker(grid, max = 4, onChange = () => {}, opts = {}) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = opts.pdf ? "image/jpeg,image/png,image/webp,application/pdf" : "image/jpeg,image/png,image/webp";
  input.multiple = true;
  input.hidden = true;
  grid.insertAdjacentElement("afterend", input);
  const files = [];
  const paint = () => {
    grid.innerHTML = files.map((f, i) => `<div class="acc-ph${f.pdf ? " acc-ph-pdf" : ""}">${f.pdf ? `${uiIcon("receipt")}<span title="${escapeHtml(f.file.name)}">${escapeHtml(f.file.name)}</span>` : `<img src="${f.url}" alt="">`}<button type="button" data-rm="${i}" aria-label="Remove file">×</button></div>`).join("")
      + (files.length < max ? `<button type="button" class="acc-ph-add">${uiIcon("camera")}<span>${opts.pdf ? "Add Photo Or PDF" : "Add Photo"}</span></button>` : "");
    grid.querySelector(".acc-ph-add")?.addEventListener("click", () => input.click());
    grid.querySelectorAll("[data-rm]").forEach((b) => b.addEventListener("click", () => {
      const [gone] = files.splice(Number(b.dataset.rm), 1);
      URL.revokeObjectURL(gone.url);
      paint();
      onChange(files.length);
    }));
  };
  input.addEventListener("change", () => {
    [...input.files].slice(0, max - files.length).forEach((file) => {
      const pdf = opts.pdf && file.type === "application/pdf";
      if (!pdf && !/^image\/(jpeg|png|webp)$/.test(file.type)) return showNotification(opts.pdf ? "Add a photo (JPEG, PNG or WebP) or a PDF." : "Photos must be JPEG, PNG or WebP.", "error");
      if (file.size > 12 * 1024 * 1024) return showNotification("Each file must be under 12 MB.", "error");
      files.push({ file, pdf, url: URL.createObjectURL(file) });
    });
    input.value = "";
    paint();
    onChange(files.length);
  });
  paint();
  return { files: () => files.map((f) => f.file), input };
}

// One order's progress, shown the same way to buyers, sellers and admins:
// Paid → Delivered → Buyer confirmed → Handed over → Seller paid.
// o: { paid, failed, sent, received, handed, completed, cancelled, buyer,
//      paysSeller, sellerPaid } - paysSeller adds the last step, Seller paid.
// Buyers see it end at their own confirmation: for them that completes it.
function orderTrackerHtml(o) {
  const done = Boolean(o.completed);
  const live = !o.cancelled;
  const step = (isDone, isNow, isFail) => (isDone || done ? "done" : isFail ? "fail" : isNow && live ? "now" : "todo");
  const stages = [
    ["Paid", step(o.paid, true, o.failed)],
    ["Delivered", step(o.sent, o.paid)],
    [o.buyer ? "Confirmed" : "Buyer confirmed", step(o.received, o.sent)],
    ...(o.buyer ? [] : [["Handed over", step(o.handed, o.received)]]),
    ...(!o.buyer && o.paysSeller ? [["Seller paid", step(o.sellerPaid, o.handed)]] : []),
  ];
  const mark = { done: "✓", fail: "✕", now: "…" };
  return `<ol class="tx-path tx-path-${stages.length}" aria-label="Order progress">${stages.map(([label, st], i) => `
    <li class="tx-step is-${st}"><span class="tx-dot">${mark[st] || i + 1}</span><span class="tx-step-label">${label}</span></li>`).join("")}</ol>`;
}

// A page banner with a picture (like the home page's), e.g. the cart:
// pageHeroHtml({ title: "Your", accent: "Cart", sub: "2 items · K 15,000" }).
// bleed: true makes it reach the edges of the window (top and sides, under
// the floating menu); call fitPageHero() after putting it on the page.
function pageHeroHtml({ title = "", accent = "", sub = "", image = "/images/hero/hero-reel-1.webp", bleed = false } = {}) {
  return `<section class="page-hero${bleed ? " is-bleed" : ""}" style="--page-hero-img:url('${escapeHtml(image)}')">
    <div class="page-hero-copy">
      <h1 class="page-hero-title">${escapeHtml(title)}${accent ? ` <span class="page-hero-accent">${escapeHtml(accent)}</span>` : ""}</h1>
      ${sub ? `<p class="page-hero-sub">${escapeHtml(sub)}</p>` : ""}
    </div>
  </section>`;
}

// Stretches a bleed banner to the window's edges: it starts at the top of the
// page and spans the full width, and its text keeps lining up with the page.
function fitPageHero(again = true) {
  const hero = document.querySelector(".page-hero.is-bleed, .page-band");
  if (!hero) return;
  // Where the banner would sit without stretching, read from what holds it
  // (so nothing moves while measuring): the top of its box's content, or for
  // a title band right under the menu bar, the bottom of the menu bar.
  // A banner placed straight in the page (not inside a box) sits under the
  // menu bar, and its text lines up with what follows it.
  const loose = hero.classList.contains("page-band") || hero.parentElement === document.body;
  const box = loose && hero.nextElementSibling ? hero.nextElementSibling : hero.parentElement;
  const b = box.getBoundingClientRect();
  const cs = getComputedStyle(box);
  const nav = document.getElementById("page-topnav");
  const top = loose
    ? (nav ? nav.offsetHeight : 0)
    : b.top + window.scrollY + parseFloat(cs.paddingTop);
  const left = b.left + parseFloat(cs.paddingLeft);
  const right = b.right - parseFloat(cs.paddingRight);
  const w = document.documentElement.clientWidth;
  hero.style.marginTop = `${-top}px`;
  hero.style.marginLeft = loose ? "0px" : `${-left}px`;
  hero.style.width = `${w}px`;
  hero.style.setProperty("--bleed-top", `${top}px`);
  hero.style.setProperty("--bleed-left", `${left}px`);
  hero.style.setProperty("--bleed-right", `${Math.max(0, w - right)}px`);
  // The banner can make the page tall enough for a scrollbar (or not), which
  // changes the window's width: fit once more to the new width.
  if (again && document.documentElement.clientWidth !== w) fitPageHero(false);
}
window.addEventListener("resize", () => fitPageHero());
document.addEventListener("DOMContentLoaded", () => {
  if (document.querySelector(".page-hero.is-bleed, .page-band")) fitPageHero();
  // The menu bar can change height as it finishes drawing: refit then too.
  // So can the page width (a scrollbar appearing as the page fills in).
  const nav = document.getElementById("page-topnav");
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => fitPageHero());
    if (nav) ro.observe(nav);
    ro.observe(document.documentElement);
  }
});
// A banner title with its last word in the accent colour ("Animal Feed").
function heroTitleHtml(text) {
  const words = String(text || "").trim().split(/\s+/);
  const last = words.pop() || "";
  return `${escapeHtml(words.join(" "))}${words.length ? " " : ""}<span class="page-hero-accent">${escapeHtml(last)}</span>`;
}

// Signed-in pages (buyer, seller, transport): the picture banner across the
// top, above the menu and the page. Its heading is the page or tab being
// shown ("My Deliveries", an order, a form), taken from that page's own
// title, which is then hidden so it isn't shown twice; the line under it is
// the account ("Seller account").
function addPortalHero(main, name, sub) {
  if (!main || document.querySelector(".portal-hero")) return;
  const anchor = main.closest(".acc-layout") || main;
  anchor.insertAdjacentHTML("beforebegin", pageHeroHtml({ title: "", sub, bleed: true }).replace('class="page-hero is-bleed"', 'class="page-hero is-bleed portal-hero"'));
  const hero = document.querySelector(".portal-hero");
  const heading = hero.querySelector(".page-hero-title");
  let shown = null;
  const sync = () => {
    // The page's titles that are on screen now (their box is showing); the
    // last one is the newest view (an order or form opened over a tab).
    const titles = [...main.querySelectorAll("h1")].filter((h) => !h.hidden && h.parentElement && h.parentElement.getClientRects().length);
    const current = titles[titles.length - 1];
    const text = current ? current.textContent.trim() : "";
    main.querySelectorAll("h1.is-in-hero").forEach((h) => { if (h !== current) h.classList.remove("is-in-hero"); });
    if (current && !current.classList.contains("is-in-hero")) current.classList.add("is-in-hero");
    if (text !== shown) { shown = text; heading.innerHTML = text ? heroTitleHtml(text) : `Hello, <span class="page-hero-accent">${escapeHtml(String(name || "").trim().split(/\s+/)[0] || "")}</span>`; }
  };
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; sync(); });
  }).observe(main, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["hidden", "class", "style"] });
  sync();
  fitPageHero();
}

// Cartoons for empty messages ("No orders yet", "No notifications yet"...):
// a friendly character with a face, drawn like the transport truck.
// name: cow, sack, cart, box, chat, bell, star, badge, check, search, truck.
function emptyArt(name) {
  const G = "#166534", GL = "#dcfce7", LIME = "#bef264", T = "#1f2937", Y = "#fde047";
  const eyes = (x1, x2, y) => [x1, x2].map((x) => `<circle cx="${x}" cy="${y}" r="4" fill="${T}"/><circle cx="${x + 1.4}" cy="${y - 1.4}" r="1.3" fill="#fff"/>`).join("");
  const smile = (x, y, w = 14, color = T) => `<path d="M${x} ${y}q${w / 2} ${w * 0.42} ${w} 0" fill="none" stroke="${color}" stroke-width="2.6" stroke-linecap="round"/>`;
  const cheeks = (x1, x2, y) => `<circle cx="${x1}" cy="${y}" r="3.4" fill="#fca5a5" opacity=".8"/><circle cx="${x2}" cy="${y}" r="3.4" fill="#fca5a5" opacity=".8"/>`;
  const face = (cx, cy, gap = 18) => `${eyes(cx - gap / 2, cx + gap / 2, cy)}${cheeks(cx - gap / 2 - 7, cx + gap / 2 + 7, cy + 9)}${smile(cx - 7, cy + 10)}`;
  const shadow = (rx = 70) => `<ellipse cx="110" cy="128" rx="${rx}" ry="6" fill="#e5e7eb"/>`;
  const sparkle = (x, y, c = Y) => `<path d="M${x} ${y - 7}v14M${x - 7} ${y}h14" stroke="${c}" stroke-width="2.6" stroke-linecap="round"/>`;
  const art = {
    cow: `${shadow(78)}
      <path d="M58 112v12M78 112v12M128 112v12M146 112v12" stroke="${T}" stroke-width="7" stroke-linecap="round"/>
      <rect x="44" y="62" width="118" height="54" rx="27" fill="#fff" stroke="${T}" stroke-width="3"/>
      <ellipse cx="76" cy="80" rx="15" ry="11" fill="${T}"/><ellipse cx="118" cy="98" rx="12" ry="8" fill="${T}"/>
      <path d="M44 84q-14 4-12 22" fill="none" stroke="${T}" stroke-width="3" stroke-linecap="round"/>
      <path d="M150 34l-6-12M184 34l6-12" stroke="#d6b98c" stroke-width="5" stroke-linecap="round"/>
      <ellipse cx="141" cy="48" rx="10" ry="6" fill="#fff" stroke="${T}" stroke-width="3" transform="rotate(-25 141 48)"/>
      <ellipse cx="193" cy="48" rx="10" ry="6" fill="#fff" stroke="${T}" stroke-width="3" transform="rotate(25 193 48)"/>
      <rect x="140" y="30" width="54" height="62" rx="24" fill="#fff" stroke="${T}" stroke-width="3"/>
      ${eyes(158, 176, 54)}
      <ellipse cx="167" cy="78" rx="22" ry="13" fill="#fbcfe8" stroke="${T}" stroke-width="2.5"/>
      <circle cx="160" cy="76" r="2.4" fill="${T}"/><circle cx="174" cy="76" r="2.4" fill="${T}"/>${smile(161, 83, 12)}`,
    sack: `${shadow(56)}
      <path d="M72 50q-14 30-10 62q2 12 14 12h68q12 0 14-12q4-32-10-62Z" fill="#fde68a" stroke="#b45309" stroke-width="3"/>
      <path d="M78 52q32-14 64 0" fill="none" stroke="#b45309" stroke-width="3"/>
      <path d="M84 50l-6-20h64l-6 20" fill="#fcd34d" stroke="#b45309" stroke-width="3" stroke-linejoin="round"/>
      <path d="M96 30q14-8 28 0" fill="none" stroke="#b45309" stroke-width="3"/>
      <rect x="84" y="92" width="52" height="20" rx="5" fill="#fff" stroke="#b45309" stroke-width="2"/><path d="M96 104q8-10 18-6q-6 8-18 6Z" fill="${LIME}" stroke="${G}" stroke-width="1.5"/>
      ${face(110, 70)}`,
    cart: `${shadow(64)}
      <path d="M40 40h18l14 58h82" fill="none" stroke="${T}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M62 52h112l-12 40H72Z" fill="${GL}" stroke="${G}" stroke-width="3" stroke-linejoin="round"/>
      ${face(118, 66)}
      <circle cx="84" cy="112" r="9" fill="${T}"/><circle cx="148" cy="112" r="9" fill="${T}"/>
      ${sparkle(186, 34)}`,
    box: `${shadow(64)}
      <path d="M64 56l46-20 46 20-46 20Z" fill="#f3d9b1" stroke="#92400e" stroke-width="3" stroke-linejoin="round"/>
      <path d="M64 56v52l46 18V76Z" fill="#e7c38f" stroke="#92400e" stroke-width="3" stroke-linejoin="round"/>
      <path d="M156 56v52l-46 18V76Z" fill="#dcb47a" stroke="#92400e" stroke-width="3" stroke-linejoin="round"/>
      <path d="M86 46l46 20v14" fill="none" stroke="${LIME}" stroke-width="6"/>
      ${eyes(80, 96, 88)}${cheeks(74, 102, 98)}${smile(81, 98, 12)}`,
    chat: `${shadow(60)}
      <path d="M50 30h120q14 0 14 14v46q0 14-14 14H96l-24 18 4-18H50q-14 0-14-14V44q0-14 14-14Z" fill="${GL}" stroke="${G}" stroke-width="3" stroke-linejoin="round"/>
      ${face(110, 58)}
      <g class="tp-toon-float"><circle cx="190" cy="22" r="4" fill="${LIME}"/><circle cx="202" cy="14" r="3" fill="${LIME}"/></g>`,
    bell: `${shadow(50)}
      <path d="M110 24q-34 0-36 40l-4 36h80l-4-36q-2-40-36-40Z" fill="${Y}" stroke="#a16207" stroke-width="3" stroke-linejoin="round"/>
      <rect x="64" y="98" width="92" height="10" rx="5" fill="#facc15" stroke="#a16207" stroke-width="3"/>
      <circle cx="110" cy="116" r="7" fill="#a16207"/><circle cx="110" cy="20" r="5" fill="#facc15" stroke="#a16207" stroke-width="3"/>
      ${face(110, 62)}
      <g class="tp-toon-float" stroke="${G}" stroke-width="2.6" stroke-linecap="round" fill="none"><path d="M52 40q-8 10 0 22"/><path d="M168 40q8 10 0 22"/></g>`,
    star: `${shadow(56)}
      <path d="M110 22l22 42 46 6-34 32 8 46-42-22-42 22 8-46-34-32 46-6Z" fill="${Y}" stroke="#ca8a04" stroke-width="3" stroke-linejoin="round"/>
      ${face(110, 78)}
      <g class="tp-toon-float">${sparkle(42, 36, LIME)}${sparkle(184, 112, LIME)}</g>`,
    badge: `${shadow(56)}
      <rect x="66" y="28" width="88" height="96" rx="12" fill="#fff" stroke="${G}" stroke-width="3"/>
      <path d="M66 40q0-12 12-12h64q12 0 12 12v6H66Z" fill="${G}"/><rect x="98" y="18" width="24" height="16" rx="4" fill="#d1d5db" stroke="${T}" stroke-width="2"/>
      <circle cx="110" cy="74" r="20" fill="${GL}" stroke="${G}" stroke-width="2.5"/>${eyes(103, 117, 70)}${smile(104, 79, 12)}
      <rect x="82" y="102" width="56" height="6" rx="3" fill="#e5e7eb"/><rect x="92" y="112" width="36" height="5" rx="2.5" fill="#e5e7eb"/>`,
    check: `${shadow(56)}
      <rect x="66" y="26" width="88" height="98" rx="10" fill="#fff" stroke="${G}" stroke-width="3"/>
      <rect x="92" y="18" width="36" height="16" rx="5" fill="${G}"/>
      <path d="M88 60l14 14 28-30" fill="none" stroke="#84cc16" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
      ${face(110, 94)}`,
    search: `${shadow(56)}
      <path d="M136 92l30 28" stroke="${T}" stroke-width="12" stroke-linecap="round"/>
      <circle cx="104" cy="66" r="40" fill="#e0f2fe" stroke="${G}" stroke-width="7"/>
      ${eyes(95, 113, 60)}<path d="M96 80q4-4 8 0t8 0" fill="none" stroke="${T}" stroke-width="2.6" stroke-linecap="round"/>
      <text x="160" y="40" font-family="Arial, Helvetica, sans-serif" font-size="26" font-weight="800" fill="${LIME}" class="tp-toon-float">?</text>`,
  };
  if (name === "truck") return typeof trCartoon === "function" ? trCartoon("road", "medium") : "";
  return art[name] ? `<svg class="tp-toon empty-art" viewBox="0 0 220 140" aria-hidden="true" focusable="false">${art[name]}</svg>` : "";
}
