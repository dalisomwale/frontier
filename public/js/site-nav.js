// Top bar menus on the public pages: Livestock ▾ and Feed ▾ (big panels on
// desktop) and Sell with us; on phones a ☰ button opens a full-screen menu
// with Livestock / Feed tabs. Any header with [data-site-nav] gets it.
//
// Both panels list every animal / feed type with its purposes / stages
// underneath.
//
// Picking a livestock purpose filters the listings on the home page (or goes
// there from other pages); feed links open the Feed page.
(function () {
  const NAV_PHOTOS = {
    cattle: "/images/livestock/cattle-fallback.webp",
    goat: "/images/livestock/goat.webp",
    sheep: "/images/livestock/sheep.webp",
    pig: "/images/livestock/pig.webp",
    poultry: "/images/livestock/poultry.webp",
    chicken: "/images/livestock/poultry.webp",
  };
  const NAV_ICONS = [
    [/pig|swine|hog/i, "🐖"], [/poultry|chicken|broiler|layer|hen/i, "🐔"], [/dairy|milk/i, "🐄"],
    [/beef|cattle|cow/i, "🐂"], [/fish|tilapia|aqua/i, "🐟"], [/duck/i, "🦆"], [/goat/i, "🐐"],
    [/sheep|lamb/i, "🐑"], [/rabbit/i, "🐇"], [/horse/i, "🐎"], [/turkey/i, "🦃"], [/pet|dog|cat/i, "🐕"],
  ];
  const TINTS = ["#fbcfe8", "#fde68a", "#bfdbfe", "#fecaca", "#a5f3fc", "#d9f99d", "#e9d5ff", "#e5e7eb"];
  const esc = (s) => (typeof escapeHtml === "function" ? escapeHtml(s) : String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`));
  const icon = (name) => (NAV_ICONS.find(([re]) => re.test(name)) || [null, "🌾"])[1];
  const photoOf = (a) => a.image_path || NAV_PHOTOS[Object.keys(NAV_PHOTOS).find((k) => a.name.toLowerCase().includes(k))] || "";
  const feedHref = (typeId, stageId) => `/feed.html?type=${encodeURIComponent(typeId)}${stageId ? `&stage=${encodeURIComponent(stageId)}` : ""}`;
  const listHref = (animalId, purposeId) => `/?animal_id=${encodeURIComponent(animalId)}${purposeId ? `&category_id=${encodeURIComponent(purposeId)}` : ""}#listings`;

  const getJson = (url) => fetch(url, { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : Promise.reject(r))).then((r) => r.data || []);
  const cache = {};
  const once = (key, fn) => (cache[key] ??= fn().catch((e) => { delete cache[key]; throw e; }));
  const animals = () => once("animals", () => getJson("/api/animals?kind=livestock"));
  const feeds = () => once("feeds", () => getJson("/api/animals?kind=feed"));
  const purposes = (id) => once(`p${id}`, () => getJson(`/api/categories?animal_id=${encodeURIComponent(id)}`));

  // On the home page the listings filter in place.
  function goLivestock(animalId, purposeId) {
    if (typeof window.siteNavPick === "function") {
      closeAll();
      return window.siteNavPick(animalId, purposeId);
    }
    location.href = listHref(animalId, purposeId);
  }

  let header, panel, sheet, openTab = null, hoverTimer = null;

  function closeAll() {
    openTab = null;
    if (panel) panel.hidden = true;
    header?.querySelectorAll("[data-nav-tab]").forEach((b) => { b.classList.remove("is-open"); b.setAttribute("aria-expanded", "false"); });
    if (sheet) { sheet.hidden = true; document.body.classList.remove("site-sheet-open"); }
  }

  // ---------- desktop panels ----------
  // Same layout as the Feed menu: every animal with its purposes underneath.
  async function livestockPanel() {
    const list = await animals();
    if (!list.length) return `<p class="snav-empty">No livestock yet.</p>`;
    const all = await Promise.all(list.map((a) => purposes(a.id).catch(() => [])));
    return `<div class="snav-feed">${list.map((a, i) => {
      const photo = photoOf(a);
      return `
      <div class="snav-feed-col">
        <a class="snav-feed-head" href="${listHref(a.id)}" data-animal="${a.id}">${photo ? `<i class="snav-head-photo" style="background-image:url('${esc(photo)}')"></i>` : `<i style="background:#fef3c7">${icon(a.name)}</i>`}${esc(a.name)}</a>
        <ul>${all[i].map((p) => `<li><a href="${listHref(a.id, p.id)}" data-animal="${a.id}" data-purpose="${p.id}">${esc(p.name)}</a></li>`).join("")}</ul>
      </div>`;
    }).join("")}</div>`;
  }

  async function feedPanel() {
    const list = await feeds();
    if (!list.length) return `<p class="snav-empty">No feed yet.</p>`;
    const stages = await Promise.all(list.map((f) => purposes(f.id).catch(() => [])));
    return `<div class="snav-feed">${list.map((f, i) => `
      <div class="snav-feed-col">
        <a class="snav-feed-head" href="${feedHref(f.id)}"><i style="background:${TINTS[i % TINTS.length]}">${icon(f.name)}</i>${esc(f.name)}</a>
        <ul>${stages[i].map((s) => `<li><a href="${feedHref(f.id, s.id)}">${esc(s.name)}</a></li>`).join("")}</ul>
      </div>`).join("")}</div>`;
  }

  async function showPanel(tab, activeIndex = 0) {
    openTab = tab;
    header.querySelectorAll("[data-nav-tab]").forEach((b) => {
      const on = b.dataset.navTab === tab;
      b.classList.toggle("is-open", on);
      b.setAttribute("aria-expanded", on ? "true" : "false");
    });
    panel.hidden = false;
    if (!panel.innerHTML || panel.dataset.tab !== tab) panel.innerHTML = `<div class="snav-loading">Loading…</div>`;
    panel.dataset.tab = tab;
    try {
      const html = tab === "feed" ? await feedPanel() : await livestockPanel();
      if (openTab === tab) panel.innerHTML = html;
    } catch {
      if (openTab === tab) panel.innerHTML = `<p class="snav-empty">Could not load. Please try again.</p>`;
    }
  }

  // ---------- phone menu ----------
  async function sheetBody(tab = "livestock", drill = null) {
    const body = sheet.querySelector("[data-sheet-body]");
    sheet.querySelectorAll("[data-sheet-tab]").forEach((b) => b.classList.toggle("is-on", b.dataset.sheetTab === tab));
    body.innerHTML = `<div class="snav-loading">Loading…</div>`;
    try {
      if (drill) {
        const list = tab === "feed" ? await feeds() : await animals();
        const item = list.find((x) => String(x.id) === String(drill));
        const ps = await purposes(drill);
        body.innerHTML = `<div class="snav-drill">
          <button type="button" class="snav-back" data-sheet-back>‹ ${tab === "feed" ? "Feed" : "Livestock"}</button>
          <h3>${esc(item ? item.name : "")}</h3>
          <div class="snav-pgrid snav-pgrid-1">${ps.map((p) => tab === "feed"
            ? `<a href="${feedHref(drill, p.id)}">${esc(p.name)}<span aria-hidden="true">›</span></a>`
            : `<a href="${listHref(drill, p.id)}" data-animal="${drill}" data-purpose="${p.id}">${esc(p.name)}<span aria-hidden="true">›</span></a>`).join("")}</div>
          <a class="snav-all" href="${tab === "feed" ? feedHref(drill) : listHref(drill)}" ${tab === "feed" ? "" : `data-animal="${drill}"`}>All ${esc(item ? item.name.toLowerCase() : "")} →</a>
        </div>`;
        return;
      }
      const list = tab === "feed" ? await feeds() : await animals();
      body.innerHTML = `<div class="snav-list">${list.map((x, i) => `
        <button type="button" class="snav-row" data-sheet-drill="${x.id}">
          ${tab === "feed"
            ? `<span class="snav-ph snav-ph-icon" style="background:${TINTS[i % TINTS.length]}">${icon(x.name)}</span>`
            : photoOf(x) ? `<span class="snav-ph" style="background-image:url('${esc(photoOf(x))}')"></span>` : `<span class="snav-ph snav-ph-icon">${icon(x.name)}</span>`}
          <b>${esc(x.name)}</b><span class="snav-chev" aria-hidden="true">›</span>
        </button>`).join("") || `<p class="snav-empty">Nothing here yet.</p>`}</div>`;
    } catch {
      body.innerHTML = `<p class="snav-empty">Could not load. Please try again.</p>`;
    }
  }

  function buildSheet() {
    sheet = document.createElement("div");
    sheet.className = "snav-sheet";
    sheet.hidden = true;
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-label", "Menu");
    sheet.innerHTML = `
      <div class="snav-sheet-top">
        <a href="/" class="snav-sheet-brand"><span class="brand-mark-full"><img src="/images/logo-full.jpg" alt=""></span><b>Frontier Marketplace</b></a>
        <button type="button" class="snav-x" data-sheet-close aria-label="Close menu">✕</button>
      </div>
      <form class="snav-search" action="/" role="search"><span aria-hidden="true">🔍</span><input name="q" type="search" placeholder="Search livestock, feed, provinces" aria-label="Search"></form>
      <div class="snav-seg"><button type="button" data-sheet-tab="livestock" class="is-on">Livestock</button><button type="button" data-sheet-tab="feed">Feed</button></div>
      <div class="snav-sheet-body" data-sheet-body></div>
      <div class="snav-sheet-foot">
        <a href="/seller/register.html" class="snav-sell">Sell with us</a>
        <span data-sheet-auth></span>
      </div>`;
    document.body.appendChild(sheet);
    let tab = "livestock";
    sheet.addEventListener("click", (e) => {
      const t = e.target;
      if (t.closest("[data-sheet-close]")) return closeAll();
      const tabBtn = t.closest("[data-sheet-tab]");
      if (tabBtn) { tab = tabBtn.dataset.sheetTab; return sheetBody(tab); }
      const drill = t.closest("[data-sheet-drill]");
      if (drill) return sheetBody(tab, drill.dataset.sheetDrill);
      if (t.closest("[data-sheet-back]")) return sheetBody(tab);
      const pick = t.closest("a[data-animal]");
      if (pick && typeof window.siteNavPick === "function") {
        e.preventDefault();
        goLivestock(pick.dataset.animal, pick.dataset.purpose || null);
      }
    });
    sheet.querySelector(".snav-search").addEventListener("submit", (e) => {
      const q = e.target.q.value.trim();
      if (!q) e.preventDefault();
    });
  }

  function openSheet() {
    closeAll();
    sheet.hidden = false;
    document.body.classList.add("site-sheet-open");
    // Log in / Register, or the account once signed in.
    const chip = header.querySelector(".buyer-chip");
    sheet.querySelector("[data-sheet-auth]").innerHTML = chip
      ? `<a href="/account/" class="snav-auth-btn snav-auth-solid">My account</a>`
      : `<a href="/account/login.html" class="snav-auth-btn">Log in</a><a href="/account/register.html" class="snav-auth-btn snav-auth-solid">Register</a>`;
    sheetBody("livestock");
    sheet.querySelector("[data-sheet-close]").focus();
  }

  // ---------- set up ----------
  function init() {
    const slot = document.querySelector("[data-site-nav]:not([data-ready])");
    if (!slot) return false;
    slot.dataset.ready = "1";
    header = slot.closest("nav") || document.getElementById("page-topnav");
    header.classList.add("has-site-nav");
    slot.innerHTML = `
      <button type="button" class="snav-tab" data-nav-tab="livestock" aria-haspopup="true" aria-expanded="false">Livestock <span class="snav-caret" aria-hidden="true">▾</span></button>
      <button type="button" class="snav-tab" data-nav-tab="feed" aria-haspopup="true" aria-expanded="false">Feed <span class="snav-caret" aria-hidden="true">▾</span></button>
      <a class="snav-tab" href="/seller/register.html">Sell with us</a>`;
    panel = document.createElement("div");
    panel.className = "snav-panel";
    panel.hidden = true;
    header.appendChild(panel);

    // ☰ for phones, at the end of the bar
    const burger = document.createElement("button");
    burger.type = "button";
    burger.className = "snav-burger";
    burger.setAttribute("aria-label", "Open menu");
    burger.innerHTML = `<span></span><span></span><span></span>`;
    const authBox = header.querySelector(".header-auth, .header-auth-acc");
    if (authBox && authBox.parentElement === slot.parentElement) authBox.after(burger);
    else if (authBox) authBox.appendChild(burger);
    else slot.after(burger);
    burger.addEventListener("click", openSheet);
    buildSheet();

    const hoverable = window.matchMedia("(hover: hover) and (pointer: fine)");
    slot.querySelectorAll("[data-nav-tab]").forEach((btn) => {
      btn.addEventListener("click", () => (openTab === btn.dataset.navTab ? closeAll() : showPanel(btn.dataset.navTab)));
      btn.addEventListener("mouseenter", () => {
        if (!hoverable.matches) return;
        clearTimeout(hoverTimer);
        hoverTimer = setTimeout(() => { if (openTab !== btn.dataset.navTab) showPanel(btn.dataset.navTab); }, 120);
      });
    });
    const leave = () => { if (!hoverable.matches) return; clearTimeout(hoverTimer); hoverTimer = setTimeout(closeAll, 260); };
    const stay = () => clearTimeout(hoverTimer);
    slot.addEventListener("mouseleave", leave);
    panel.addEventListener("mouseleave", leave);
    panel.addEventListener("mouseenter", stay);
    slot.addEventListener("mouseenter", stay);

    panel.addEventListener("click", (e) => {
      const pick = e.target.closest("a[data-animal]");
      if (pick && typeof window.siteNavPick === "function") {
        e.preventDefault();
        goLivestock(pick.dataset.animal, pick.dataset.purpose || null);
      }
    });
    document.addEventListener("click", (e) => {
      if (openTab && !e.composedPath().some((el) => el === panel || el === slot)) closeAll();
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAll(); });
    return true;
  }

  // Some pages (the account pages) draw their header after loading.
  document.addEventListener("DOMContentLoaded", () => {
    if (init()) return;
    const watch = new MutationObserver(() => { if (init()) watch.disconnect(); });
    watch.observe(document.body, { childList: true, subtree: true });
  });
})();
