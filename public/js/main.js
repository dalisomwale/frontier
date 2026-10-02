
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

function quantityLabel(quantity, animalName) {
  const n = Number(quantity) || 0;
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
    info: "bg-blue-600",
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
      active ? "bg-blue-600 text-white border-blue-600" : "border-gray-300 bg-white hover:bg-gray-50"
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
      variant === "danger" ? "bg-red-600 hover:bg-red-700 text-white" : "bg-blue-600 hover:bg-blue-700 text-white";

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
      <div class="bg-white rounded-lg shadow-md overflow-hidden animate-pulse">
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

function footerYear() {
  const el = document.getElementById("footer-year");
  if (el) el.textContent = new Date().getFullYear();
}
document.addEventListener("DOMContentLoaded", footerYear);
