// Shared admin page bootstrap: auth guard, chrome, API helper, form modal.
// Requires main.js, icons.js and app-shell.js.

const ADMIN_HEADER = { "X-Frontier-Admin": "1" };

// Every admin API call carries the CSRF header and bounces to the login page
// if the session has expired.
async function adminApi(url, options = {}) {
  try {
    return await apiRequest(url, { ...options, headers: { ...ADMIN_HEADER, ...options.headers } });
  } catch (error) {
    if (error.status === 401 && !url.includes("/auth/login")) {
      window.location.href = `/admin/login.html?next=${encodeURIComponent(location.pathname + location.search)}`;
      await new Promise(() => {}); // stop the caller while the page navigates
    }
    throw error;
  }
}

async function adminLogout() {
  try {
    await adminApi("/api/admin/auth/logout", { method: "POST" });
  } finally {
    window.location.href = "/admin/login.html";
  }
}

/**
 * Renders the sidebar/topbar/bottom-nav, verifies the session, and resolves
 * with the signed-in admin. Page content stays hidden until then.
 */
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
    /* badge is best-effort */
  }
}

function statusPill(status, label) {
  const text = label || String(status).replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  return `<span class="status-pill st-${escapeHtml(status)}">${escapeHtml(text)}</span>`;
}

/**
 * Generic modal form.
 *   openFormModal({ title, body, submitText, wide, onSubmit(form) => Promise })
 * onSubmit may throw an Error with `.errors` ({ field: message }) to
 * highlight fields; the modal stays open until onSubmit resolves.
 */
function openFormModal({ title, body, submitText = "Save", wide = false, onSubmit, onOpen }) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal-panel ${wide ? "modal-wide" : ""}" role="dialog" aria-modal="true" aria-labelledby="form-modal-title">
      <form novalidate>
        <div class="flex items-center justify-between gap-3 px-5 py-4 border-b border-gray-100 sticky top-0 bg-white z-10">
          <h2 id="form-modal-title" class="text-lg font-bold text-gray-900">${escapeHtml(title)}</h2>
          <button type="button" data-close class="w-9 h-9 rounded-full flex items-center justify-center text-gray-500 hover:bg-gray-100" aria-label="Close"><span class="w-5 h-5">${uiIcon("close")}</span></button>
        </div>
        <div class="p-5 space-y-4">
          <div data-form-alert class="hidden alert alert-error text-sm mb-0" role="alert"></div>
          ${body}
        </div>
        <div class="flex justify-end gap-3 px-5 py-4 border-t border-gray-100 sticky bottom-0 bg-white">
          <button type="button" data-close class="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 font-medium">Cancel</button>
          <button type="submit" data-submit class="inline-flex items-center gap-2 px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold disabled:opacity-70">${escapeHtml(submitText)}</button>
        </div>
      </form>
    </div>`;
  document.body.appendChild(backdrop);
  document.body.classList.add("modal-open");

  const form = backdrop.querySelector("form");
  const submit = form.querySelector("[data-submit]");
  const alertBox = form.querySelector("[data-form-alert]");
  let dirty = false;
  form.addEventListener("input", () => (dirty = true));

  const close = async (force = false) => {
    if (!force && dirty && !(await confirmAction({ title: "Discard changes?", message: "Your unsaved changes will be lost.", confirmText: "Discard", variant: "danger" }))) return;
    document.removeEventListener("keydown", onKey);
    backdrop.remove();
    if (!document.querySelector(".modal-backdrop")) document.body.classList.remove("modal-open");
  };
  const onKey = (e) => {
    if (e.key === "Escape" && !document.querySelector("[aria-labelledby=confirm-action-title]")) close();
  };
  document.addEventListener("keydown", onKey);
  backdrop.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => close()));
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) close();
  });

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
      close(true);
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
  setTimeout(() => form.querySelector("input:not([type=hidden]):not([type=file]), select, textarea")?.focus(), 50);
  return { form, close };
}

function field({ name, label, type = "text", value = "", required = false, placeholder = "", help = "", options = null, rows = 3, attrs = "" }) {
  const id = `f-${name}`;
  let control;
  if (options) {
    control = `<select id="${id}" name="${name}" class="field-input" ${required ? "required" : ""} ${attrs}>
      ${options.map((o) => `<option value="${escapeHtml(o.value)}" ${String(o.value) === String(value ?? "") ? "selected" : ""}>${escapeHtml(o.label)}</option>`).join("")}
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

function formValues(form) {
  return Object.fromEntries(new FormData(form).entries());
}
