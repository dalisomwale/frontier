
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

function renderEmptyState(container, { title = "Nothing here yet", message = "", icon = "listings", action = "" } = {}) {
  container.innerHTML = `
    <div class="empty-state col-span-full">
      <div class="empty-icon">${typeof uiIcon === "function" ? uiIcon(icon) : ""}</div>
      <h3 class="text-base font-semibold text-gray-900 mb-1">${escapeHtml(title)}</h3>
      ${message ? `<p class="text-sm text-gray-500 max-w-md mx-auto">${escapeHtml(message)}</p>` : ""}
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
  // The newsletter sign-up: its own band just above the footer.
  if (!document.querySelector(".news-band") && !location.pathname.startsWith("/newsletter/")) {
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
  const box = hero.parentElement;
  const b = box.getBoundingClientRect();
  const cs = getComputedStyle(box);
  const nav = document.getElementById("page-topnav");
  const top = hero.classList.contains("page-band")
    ? (nav ? nav.offsetHeight : 0)
    : b.top + window.scrollY + parseFloat(cs.paddingTop);
  const left = b.left + parseFloat(cs.paddingLeft);
  const right = b.right - parseFloat(cs.paddingRight);
  const w = document.documentElement.clientWidth;
  hero.style.marginTop = `${-top}px`;
  hero.style.marginLeft = `${-left}px`;
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
