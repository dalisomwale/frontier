
const ADMIN_HEADER = { "X-Frontier-Admin": "1" };

async function adminApi(url, options = {}) {
  try {
    return await apiRequest(url, { ...options, headers: { ...ADMIN_HEADER, ...options.headers } });
  } catch (error) {
    if (error.status === 401 && !url.includes("/auth/login")) {
      window.location.href = `/admin/login.html?next=${encodeURIComponent(location.pathname + location.search)}`;
      await new Promise(() => {});
    }
    throw error;
  }
}

function confirmRemovePhoto() {
  return confirmAction({
    title: "Remove this photo?",
    message: "It will be deleted when you save.",
    confirmText: "Remove",
    variant: "danger",
  });
}

async function adminLogout() {
  if (!(await confirmAction({ title: "Log out?", message: "You'll need to sign in again to use the admin.", confirmText: "Log out" }))) return;
  try {
    await adminApi("/api/admin/auth/logout", { method: "POST" });
  } finally {
    window.location.href = "/admin/login.html";
  }
}

async function initAdminPage(active) {
  renderSidebar(active);
  renderBottomNav("admin");

  const topbar = document.getElementById("admin-topbar");
  if (topbar) {
    topbar.innerHTML = `
      <nav id="page-topnav" class="bg-white border-b border-gray-100 sticky top-0 z-50">
        <div class="px-4 sm:px-6 h-16 flex justify-between items-center">
          <a href="/admin/index.html" class="flex items-center gap-3">
            <div class="brand-mark-full"><img src="/images/logo-full.jpg" alt="Frontier Farms &amp; Consult"></div>
            <span class="font-bold text-gray-900">Admin</span>
          </a>
          <div class="flex items-center gap-2">
            <a href="/" target="_blank" rel="noopener" class="hidden sm:inline-flex text-sm font-medium text-gray-600 hover:text-gray-900 px-3 py-2">View website</a>
            <button type="button" data-logout class="bg-red-600 text-white px-4 py-2 rounded-lg hover:bg-red-700 font-medium text-sm">Logout</button>
          </div>
        </div>
      </nav>`;
  }
  document.querySelectorAll("[data-logout]").forEach((btn) => btn.addEventListener("click", adminLogout));

  const admin = (await adminApi("/api/admin/auth/me")).data;
  const name = document.getElementById("sidebar-admin-name");
  if (name) name.textContent = `Signed in as ${admin.name}`;
  document.body.classList.remove("admin-pending");
  refreshNewInquiryBadge();
  return admin;
}

async function refreshNewInquiryBadge() {
  try {
    const res = await adminApi("/api/admin/inquiries?status=new&limit=1");
    setNewInquiryBadge(res.summary.new);
  } catch {
  }
  try {
    const res = await adminApi("/api/admin/orders?limit=1");
    if (typeof setNewOrderBadge === "function") setNewOrderBadge(res.summary.new);
  } catch {
  }
}

function statusPill(status, label) {
  const text = label || String(status).replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  return `<span class="status-pill st-${escapeHtml(status)}">${escapeHtml(text)}</span>`;
}

// Full-page views inside the admin layout, in place of pop-up windows.
// Each view replaces the page content and shows a path at the top
// (Section / ... / Title); the browser's Back button closes it too.
const adminViews = [];
let adminViewPopBusy = false;

function adminSectionLabel() {
  const active = document.querySelector(".app-sidebar-nav > a.active span");
  return (active && active.textContent.trim()) || (document.querySelector("main h1")?.textContent.trim()) || "Admin";
}

function adminViewHost() {
  return document.querySelector("main.app-content-shifted") || document.querySelector("main");
}

function renderAdminCrumbs() {
  adminViews.forEach((view, depth) => {
    const parts = [`<a href="${location.pathname}" data-crumb="-1">${escapeHtml(adminSectionLabel())}</a>`];
    adminViews.slice(0, depth).forEach((v, i) => parts.push(`<a href="#" data-crumb="${i}">${escapeHtml(v.title)}</a>`));
    parts.push(`<b>${escapeHtml(view.title)}</b>`);
    const nav = view.el.querySelector(":scope > .admin-crumbs");
    nav.innerHTML = parts.join('<span aria-hidden="true">/</span>');
    nav.querySelectorAll("[data-crumb]").forEach((a) => a.addEventListener("click", (e) => {
      e.preventDefault();
      closeAdminViewsTo(Number(a.dataset.crumb));
    }));
  });
}

// Close views until only `keep + 1` are left (-1 closes them all).
async function closeAdminViewsTo(keep) {
  let closed = 0;
  for (let i = adminViews.length - 1; i > keep; i--) {
    if (!(await adminViews[i].close(false, false))) break;
    closed++;
  }
  if (closed && history.state && history.state.adminView) {
    adminViewPopBusy = true;
    history.go(-Math.min(closed, history.state.adminView));
  }
}

// openAdminView({ title, params, html, onClose, canLeave }) -> { el, close, setTitle }
//   params    optional address for this view (e.g. { id: 3 }), so it can be shared
//   canLeave  optional async check before closing (unsaved changes)
const VIEW_PARAMS = ["edit", "new", "id"];
function adminListUrl() {
  const q = new URLSearchParams(location.search);
  VIEW_PARAMS.forEach((k) => q.delete(k));
  return location.pathname + (q.toString() ? `?${q}` : "");
}
function adminViewUrl(params) {
  const q = new URLSearchParams(adminListUrl().split("?")[1] || "");
  Object.entries(params || {}).forEach(([k, v]) => q.set(k, v));
  return location.pathname + (q.toString() ? `?${q}` : "");
}

function openAdminView({ title, params, html = "", onClose, canLeave }) {
  const host = adminViewHost();
  // Opened from a link (?edit=5): the page underneath is the plain list.
  if (!adminViews.length && VIEW_PARAMS.some((k) => new URLSearchParams(location.search).has(k))) {
    history.replaceState(null, "", adminListUrl());
  }
  const url = params ? adminViewUrl(params) : location.pathname + location.search;
  const el = document.createElement("section");
  el.className = "admin-view";
  el.innerHTML = `<nav class="admin-crumbs tx-crumbs" aria-label="Breadcrumb"></nav><div class="admin-view-body">${html}</div>`;
  host.appendChild(el);
  host.classList.add("has-view");
  const view = { el, title, scroll: window.scrollY, closed: false };
  const depth = adminViews.length;
  adminViews.push(view);
  history.pushState({ adminView: depth + 1 }, "", url);
  view.pushed = true;
  renderAdminCrumbs();
  window.scrollTo(0, 0);

  const remove = () => {
    if (view.closed) return;
    view.closed = true;
    adminViews.splice(adminViews.indexOf(view), 1);
    el.remove();
    if (!adminViews.length) host.classList.remove("has-view");
    renderAdminCrumbs();
    requestAnimationFrame(() => window.scrollTo(0, view.scroll));
    if (onClose) onClose();
  };
  // Returns true when closed (false if the admin chose to stay).
  view.close = async (force = false, moveHistory = true) => {
    if (view.closed) return true;
    if (!force && canLeave && !(await canLeave())) return false;
    remove();
    if (moveHistory && history.state && history.state.adminView === depth + 1) {
      adminViewPopBusy = true;
      history.back();
    }
    return true;
  };
  view.removeOnPop = async () => {
    if (canLeave && !(await canLeave())) {
      history.pushState({ adminView: depth + 1 }, "", url);
      return;
    }
    remove();
  };
  return {
    el,
    body: el.querySelector(".admin-view-body"),
    close: (force) => view.close(force),
    setTitle(t) { view.title = t; renderAdminCrumbs(); },
  };
}

// Leave every open page view at once (e.g. when another menu item is chosen).
function closeAllAdminViews() {
  [...adminViews].reverse().forEach((v) => v.close(true, false));
}

window.addEventListener("popstate", async (e) => {
  if (adminViewPopBusy) { adminViewPopBusy = false; return; }
  const want = (e.state && e.state.adminView) || 0;
  while (adminViews.length > want) {
    const top = adminViews[adminViews.length - 1];
    const before = adminViews.length;
    await top.removeOnPop();
    if (adminViews.length === before) break;
  }
});

// A form shown as its own page (Section / Title), with Cancel and Save.
function openFormModal({ title, crumb, body, submitText = "Save", wide = false, onSubmit, onOpen, params }) {
  let dirty = false;
  const view = openAdminView({
    title: crumb || title,
    params,
    canLeave: async () => !dirty || confirmAction({ title: "Discard changes?", message: "Your unsaved changes will be lost.", confirmText: "Discard", variant: "danger" }),
    html: `
      <form novalidate class="admin-form-page ${wide ? "admin-form-wide" : ""}">
        <h1 class="admin-view-title">${escapeHtml(title)}</h1>
        <div class="admin-form-card">
          <div class="space-y-4">
            <div data-form-alert class="hidden alert alert-error text-sm mb-0" role="alert"></div>
            ${body}
          </div>
        </div>
        <div class="admin-form-actions">
          <button type="button" data-close class="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 font-medium bg-white">Cancel</button>
          <button type="submit" data-submit class="inline-flex items-center gap-2 px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold disabled:opacity-70">${escapeHtml(submitText)}</button>
        </div>
      </form>`,
  });

  const form = view.el.querySelector("form");
  const submit = form.querySelector("[data-submit]");
  const alertBox = form.querySelector("[data-form-alert]");
  form.addEventListener("input", () => (dirty = true));
  form.addEventListener("change", () => (dirty = true));
  const close = (force = false) => view.close(force);
  form.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => close()));

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    alertBox.classList.add("hidden");
    form.querySelectorAll(".field-error").forEach((el) => el.classList.add("hidden"));
    form.querySelectorAll(".has-error").forEach((el) => el.classList.remove("has-error"));
    submit.disabled = true;
    const label = submit.innerHTML;
    submit.innerHTML = `<span class="btn-spinner"></span> Saving…`;
    try {
      await onSubmit(form);
      await close(true);
    } catch (error) {
      if (error.errors) {
        for (const [field, message] of Object.entries(error.errors)) {
          const input = form.elements[field];
          if (input?.classList) input.classList.add("has-error");
          const holder = form.querySelector(`[data-error-for="${field}"]`);
          if (holder) {
            holder.textContent = message;
            holder.classList.remove("hidden");
          }
        }
      }
      alertBox.textContent = error.message;
      alertBox.classList.remove("hidden");
      alertBox.scrollIntoView({ block: "nearest" });
    } finally {
      submit.disabled = false;
      submit.innerHTML = label;
    }
  });

  if (onOpen) onOpen(form);
  setTimeout(() => form.querySelector("input:not([type=hidden]):not([type=file]), select, textarea")?.focus({ preventScroll: true }), 50);
  return { form, close, view };
}

// <option>s for a select; options with a `group` are put in <optgroup>s.
function optionsMarkup(options, value) {
  const one = (o) => `<option value="${escapeHtml(o.value)}" ${String(o.value) === String(value ?? "") ? "selected" : ""}>${escapeHtml(o.label)}</option>`;
  if (!options.some((o) => o.group)) return options.map(one).join("");
  let html = "";
  let group = null;
  options.forEach((o) => {
    if (!o.group) return (html += one(o));
    if (o.group !== group) {
      if (group !== null) html += "</optgroup>";
      group = o.group;
      html += `<optgroup label="${escapeHtml(group)}">`;
    }
    html += one(o);
  });
  return html + (group !== null ? "</optgroup>" : "");
}

// Listing forms: feed listings (a feed type chosen as the category) have no
// breed, type or age, and are counted and priced in bags.
function applyListingKind(form, kind) {
  const feed = kind === "feed";
  ["breed_id", "livestock_type", "age_months"].forEach((name) => {
    const input = form.elements[name];
    if (!input) return;
    input.closest("div").hidden = feed;
    if (feed) input.value = "";
  });
  const setLabel = (name, text) => {
    const label = form.querySelector(`label[for="f-${name}"]`);
    if (label && label.firstChild) label.firstChild.textContent = text;
  };
  setLabel("category_id", feed ? "Feed Stage" : "Production Purpose");
  setLabel("quantity", feed ? "Quantity (bags)" : "Quantity");
  const blank = form.elements.category_id?.querySelector('option[value=""]');
  if (blank && feed) blank.textContent = blank.textContent.replace(/purposes?/i, (w) => (w.toLowerCase().endsWith("s") ? "stages" : "stage"));
  const perHead = form.elements.price_unit?.querySelector('option[value="head"]');
  if (perHead) perHead.textContent = feed ? "Per bag" : "Per head";
}

function field({ name, label, type = "text", value = "", required = false, placeholder = "", help = "", options = null, rows = 3, attrs = "" }) {
  const id = `f-${name}`;
  let control;
  if (options) {
    control = `<select id="${id}" name="${name}" class="field-input" ${required ? "required" : ""} ${attrs}>
      ${optionsMarkup(options, value)}
    </select>`;
  } else if (type === "textarea") {
    control = `<textarea id="${id}" name="${name}" rows="${rows}" class="field-input" placeholder="${escapeHtml(placeholder)}" ${attrs}>${escapeHtml(value ?? "")}</textarea>`;
  } else {
    control = `<input id="${id}" name="${name}" type="${type}" class="field-input" value="${escapeHtml(value ?? "")}" placeholder="${escapeHtml(placeholder)}" ${required ? "required" : ""} ${attrs}>`;
  }
  return `<div>
    <label for="${id}" class="field-label">${escapeHtml(label)}${required ? ' <span class="text-red-500">*</span>' : ""}</label>
    ${control}
    ${help ? `<p class="text-xs text-gray-500 mt-1">${escapeHtml(help)}</p>` : ""}
    <p class="field-error hidden" data-error-for="${name}"></p>
  </div>`;
}

// Price fields shared by the admin and seller listing forms. The price is
// optional: left empty, the website shows "Price on request".
function plainPrice(value) {
  if (value === null || value === undefined || value === "") return "";
  const n = Number(value);
  return Number.isFinite(n) ? String(Number.isInteger(n) ? n : n.toFixed(2)) : "";
}

function priceFields(item = {}) {
  return `<div class="grid grid-cols-2 sm:grid-cols-3 gap-4 items-end">
    <div class="col-span-2 sm:col-span-1">
      <label for="f-price" class="field-label">Price (K)</label>
      <div class="price-input"><span>K</span><input id="f-price" name="price" type="text" inputmode="decimal" class="field-input"
        value="${escapeHtml(plainPrice(item.price))}" placeholder="Price on request" maxlength="15"></div>
      <p class="field-error hidden" data-error-for="price"></p>
    </div>
    ${field({ name: "price_unit", label: "Priced", value: item.price_unit || "head",
        // "For the lot" is no longer offered; kept only for older listings priced that way.
        options: [{ value: "head", label: "Per head" }, ...(item.price_unit === "lot" ? [{ value: "lot", label: "For the lot" }] : [])] })}
  </div>`;
}

function appendPriceFields(fd, form) {
  fd.append("price", form.elements.price.value.trim());
  fd.append("price_unit", form.elements.price_unit.value);
}

const MAX_DESCRIPTION_WORDS = 50;

function countWords(value) {
  return (String(value || "").trim().match(/\S+/g) || []).length;
}

function bindWordLimit(textarea, max = MAX_DESCRIPTION_WORDS) {
  if (!textarea) return;
  const hint = document.createElement("p");
  hint.className = "text-xs mt-1";
  textarea.insertAdjacentElement("afterend", hint);
  const update = () => {
    const n = countWords(textarea.value);
    hint.textContent = `${n} / ${max} words`;
    hint.className = `text-xs mt-1 ${n > max ? "text-red-600 font-semibold" : "text-gray-500"}`;
  };
  textarea.addEventListener("input", update);
  update();
}

function formValues(form) {
  return Object.fromEntries(new FormData(form).entries());
}

async function shrinkImage(file) {
  if (file.size < 1.5 * 1024 * 1024 || !window.createImageBitmap) return file;
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.85));
    return blob ? new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" }) : file;
  } catch {
    return file;
  }
}

function photoField({ label = "Photo", current = null, help = "" } = {}) {
  return `
    <div data-photo-field>
      <span class="field-label">${escapeHtml(label)}</span>
      <div class="flex flex-col sm:flex-row sm:items-start gap-4">
        <div class="photo-field-preview" data-photo-preview></div>
        <div class="flex flex-col gap-2 min-w-0">
          <div class="flex flex-wrap gap-2">
            <label class="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 font-medium text-sm cursor-pointer">
              <span class="w-4 h-4">${uiIcon("camera")}</span><span data-photo-upload-label>${current ? "Replace photo" : "Upload photo"}</span>
              <input type="file" accept="image/jpeg,image/png,image/webp" class="sr-only" data-photo-input>
            </label>
            <button type="button" data-photo-remove class="${current ? "" : "hidden"} inline-flex items-center gap-2 px-3 py-2 rounded-lg text-red-600 hover:bg-red-50 font-medium text-sm">
              <span class="w-4 h-4">${uiIcon("trash")}</span>Remove
            </button>
          </div>
          <p class="text-xs text-gray-500">${escapeHtml(help || "JPEG, PNG or WebP.")}</p>
        </div>
      </div>
    </div>`;
}

function bindPhotoField(form, current) {
  const box = form.querySelector("[data-photo-field]");
  const preview = box.querySelector("[data-photo-preview]");
  const input = box.querySelector("[data-photo-input]");
  const removeBtn = box.querySelector("[data-photo-remove]");
  const uploadLabel = box.querySelector("[data-photo-upload-label]");
  const state = { file: null, remove: false, url: null };

  function paint(src) {
    preview.innerHTML = src
      ? `<img src="${escapeHtml(src)}" alt="Photo preview">`
      : `<span class="flex flex-col items-center gap-1"><span class="w-6 h-6">${uiIcon("camera")}</span><span>No photo</span></span>`;
    removeBtn.classList.toggle("hidden", !src);
    uploadLabel.textContent = src ? "Replace photo" : "Upload photo";
  }

  input.addEventListener("change", async () => {
    const file = input.files[0];
    input.value = "";
    if (!file) return;
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
      showNotification("Photos must be JPEG, PNG or WebP images.", "warning");
      return;
    }
    if (state.url) URL.revokeObjectURL(state.url);
    state.file = await shrinkImage(file);
    state.remove = false;
    state.url = URL.createObjectURL(state.file);
    paint(state.url);
    form.dispatchEvent(new Event("input"));
  });

  removeBtn.addEventListener("click", async () => {
    if (!state.file && current && !(await confirmRemovePhoto())) return;
    if (state.url) URL.revokeObjectURL(state.url);
    state.file = null;
    state.url = null;
    state.remove = Boolean(current);
    paint(null);
    form.dispatchEvent(new Event("input"));
  });

  paint(current);

  return {
    state,
    async apply(baseUrl) {
      if (state.file) {
        const fd = new FormData();
        fd.append("image", state.file, state.file.name || "photo.jpg");
        await adminApi(`${baseUrl}/photo`, { method: "POST", body: fd });
      } else if (state.remove) {
        await adminApi(`${baseUrl}/photo`, { method: "DELETE" });
      }
      if (state.url) URL.revokeObjectURL(state.url);
    },
  };
}

const MAX_PURPOSE_PHOTOS = 8;

function photosField({ label = "Photos", help = "" } = {}) {
  return `
    <div data-photos-field>
      <div class="flex items-baseline justify-between mb-2">
        <span class="field-label !mb-0">${escapeHtml(label)}</span>
        <span class="text-xs text-gray-500" data-photos-count></span>
      </div>
      <div class="photo-grid" data-photos-grid></div>
      <input type="file" accept="image/jpeg,image/png,image/webp" multiple class="sr-only" data-photos-input>
      <p class="text-xs text-gray-500 mt-2">${escapeHtml(help || `Up to ${MAX_PURPOSE_PHOTOS} photos.`)}</p>
    </div>`;
}

function bindPhotosField(form, existing = []) {
  const box = form.querySelector("[data-photos-field]");
  const grid = box.querySelector("[data-photos-grid]");
  const input = box.querySelector("[data-photos-input]");
  const count = box.querySelector("[data-photos-count]");
  const items = existing.map((p) => ({ id: p.id, src: p.image_path }));
  const removed = [];
  const changed = () => form.dispatchEvent(new Event("input"));

  function render() {
    count.textContent = `${items.length} / ${MAX_PURPOSE_PHOTOS}`;
    grid.innerHTML =
      items.map((p, i) => `
        <div class="photo-item ${i === 0 ? "is-cover" : ""}">
          <img src="${escapeHtml(p.src)}" alt="Photo ${i + 1}">
          ${i === 0 ? '<span class="cover-badge">First</span>' : ""}
          <div class="photo-actions">
            ${i === 0 ? "<span></span>" : `<button type="button" data-first="${i}">Make first</button>`}
            <button type="button" data-remove="${i}" aria-label="Remove photo">Remove</button>
          </div>
        </div>`).join("") +
      (items.length < MAX_PURPOSE_PHOTOS
        ? `<button type="button" class="photo-drop" data-add>${uiIcon("camera")}<span>Add photos</span></button>`
        : "");
    grid.querySelectorAll("[data-first]").forEach((b) => b.addEventListener("click", () => {
      items.unshift(items.splice(Number(b.dataset.first), 1)[0]);
      changed();
      render();
    }));
    grid.querySelectorAll("[data-remove]").forEach((b) => b.addEventListener("click", async () => {
      if (items[Number(b.dataset.remove)]?.id && !(await confirmRemovePhoto())) return;
      const [p] = items.splice(Number(b.dataset.remove), 1);
      if (p.id) removed.push(p.id);
      if (p.url) URL.revokeObjectURL(p.url);
      changed();
      render();
    }));
    const add = grid.querySelector("[data-add]");
    if (add) {
      add.addEventListener("click", () => input.click());
      ["dragover", "dragenter"].forEach((t) => add.addEventListener(t, (e) => { e.preventDefault(); add.classList.add("dragover"); }));
      ["dragleave", "drop"].forEach((t) => add.addEventListener(t, () => add.classList.remove("dragover")));
      add.addEventListener("drop", (e) => { e.preventDefault(); addFiles(e.dataTransfer.files); });
    }
  }

  async function addFiles(fileList) {
    const files = [...fileList].filter((f) => /^image\/(jpeg|png|webp)$/.test(f.type));
    if (files.length < fileList.length) showNotification("Only JPEG, PNG and WebP photos can be added.", "warning");
    const room = MAX_PURPOSE_PHOTOS - items.length;
    if (files.length > room) showNotification(`Only ${room} more photo${room === 1 ? "" : "s"} can be added.`, "warning");
    for (const f of files.slice(0, room)) {
      const file = await shrinkImage(f);
      const url = URL.createObjectURL(file);
      items.push({ file, src: url, url });
    }
    changed();
    render();
  }

  input.addEventListener("change", () => { addFiles(input.files); input.value = ""; });
  render();

  return {
    async apply(baseUrl) {
      for (const id of removed) {
        await adminApi(`${baseUrl}/photos/${id}`, { method: "DELETE" });
      }
      const fresh = items.filter((p) => p.file);
      let newIds = [];
      if (fresh.length) {
        const fd = new FormData();
        fresh.forEach((p) => fd.append("images", p.file, p.file.name || "photo.jpg"));
        const res = await adminApi(`${baseUrl}/photos`, { method: "POST", body: fd });
        newIds = res.data.slice(-fresh.length).map((p) => p.id);
      }
      let n = 0;
      const order = items.map((p) => (p.file ? newIds[n++] : p.id)).filter(Boolean);
      if (order.length > 1) {
        await adminApi(`${baseUrl}/photos/order`, { method: "PUT", body: { order } });
      }
      items.forEach((p) => p.url && URL.revokeObjectURL(p.url));
    },
  };
}
