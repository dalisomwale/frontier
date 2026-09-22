// Main Utility Functions

/**
 * Make API request
 */
async function apiRequest(url, options = {}) {
  try {
    const headers = { ...options.headers };
    if (
      !(options.body instanceof FormData) &&
      options.body !== undefined &&
      !headers["Content-Type"]
    ) {
      headers["Content-Type"] = "application/json";
    }
    const response = await fetch(url, {
      ...options,
      credentials: "same-origin",
      headers,
    });

    const contentType = response.headers.get("content-type") || "";
    const data = contentType.includes("application/json")
      ? await response.json()
      : {
          success: false,
          message: "The server returned an unexpected response.",
        };

    if (!response.ok) {
      throw new Error(data.message || "API request failed");
    }

    return data;
  } catch (error) {
    console.error("API request error:", error);
    throw error;
  }
}

/**
 * Show notification
 */
function showNotification(message, type = "info") {
  const notification = document.createElement("div");
  notification.className = `fixed top-4 right-4 p-4 rounded-lg text-white shadow-lg z-50 notification-${type}`;

  if (type === "success") {
    notification.classList.add("bg-green-500");
  } else if (type === "error") {
    notification.classList.add("bg-red-500");
  } else if (type === "warning") {
    notification.classList.add("bg-yellow-500");
  } else {
    notification.classList.add("bg-blue-500");
  }

  notification.textContent = message;

  document.body.appendChild(notification);

  setTimeout(() => {
    notification.remove();
  }, 3000);
}

/**
 * Show loading spinner
 */
function showLoading() {
  let loader = document.getElementById("loader");
  if (!loader) {
    loader = document.createElement("div");
    loader.id = "loader";
    loader.innerHTML = `
      <div class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
        <div class="bg-white rounded-lg p-8">
          <div class="w-12 h-12 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin"></div>
        </div>
      </div>
    `;
    document.body.appendChild(loader);
  }
}

/**
 * Hide loading spinner
 */
function hideLoading() {
  const loader = document.getElementById("loader");
  if (loader) {
    loader.remove();
  }
}

/**
 * Format currency
 */
function formatCurrency(amount) {
  return new Intl.NumberFormat("en-ZM", {
    style: "currency",
    currency: "ZMW",
    maximumFractionDigits: 2,
  }).format(amount);
}

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      })[character],
  );
}

/**
 * Format date
 */
function formatDate(dateString) {
  const options = {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  };
  return new Date(dateString).toLocaleDateString("en-US", options);
}

/**
 * Format date (short)
 */
function formatDateShort(dateString) {
  const options = {
    year: "numeric",
    month: "short",
    day: "numeric",
  };
  return new Date(dateString).toLocaleDateString("en-US", options);
}

/**
 * Get URL query parameters
 */
function getQueryParams() {
  const params = {};
  const queryString = window.location.search.substring(1);
  const pairs = queryString.split("&");

  pairs.forEach((pair) => {
    const [key, value] = pair.split("=");
    if (key) {
      params[decodeURIComponent(key)] = decodeURIComponent(value || "");
    }
  });

  return params;
}

/**
 * Create pagination HTML
 */
function createPagination(currentPage, totalPages, onPageChange) {
  const pagination = document.createElement("div");
  pagination.className = "flex justify-center items-center gap-2 mt-8";

  const prevBtn = document.createElement("button");
  prevBtn.className =
    "px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50";
  prevBtn.textContent = "← Previous";
  prevBtn.disabled = currentPage === 1;
  prevBtn.addEventListener("click", () => onPageChange(currentPage - 1));
  pagination.appendChild(prevBtn);

  for (
    let i = Math.max(1, currentPage - 2);
    i <= Math.min(totalPages, currentPage + 2);
    i++
  ) {
    const pageBtn = document.createElement("button");
    pageBtn.className = `px-4 py-2 border rounded-lg ${i === currentPage ? "bg-blue-600 text-white border-blue-600" : "border-gray-300 hover:bg-gray-50"}`;
    pageBtn.textContent = i;
    pageBtn.addEventListener("click", () => onPageChange(i));
    pagination.appendChild(pageBtn);
  }

  const nextBtn = document.createElement("button");
  nextBtn.className =
    "px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50";
  nextBtn.textContent = "Next →";
  nextBtn.disabled = currentPage === totalPages;
  nextBtn.addEventListener("click", () => onPageChange(currentPage + 1));
  pagination.appendChild(nextBtn);

  return pagination;
}

/**
 * Validate email
 */
function validateEmail(email) {
  const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return regex.test(email);
}

/**
 * Validate form field
 */
function validateField(fieldName, value) {
  switch (fieldName) {
    case "email":
      return validateEmail(value);
    case "password":
      return value && value.length >= 8;
    case "name":
      return value && value.length >= 2;
    case "phone":
      return value && value.length >= 7;
    case "price":
      return value && !isNaN(value) && parseFloat(value) > 0;
    default:
      return value && value.toString().trim().length > 0;
  }
}

/**
 * Show modal
 */
function showModal(title, content, buttons = []) {
  const modal = document.createElement("div");
  modal.className =
    "fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50";
  modal.id = "modal-overlay";

  let buttonHTML = "";
  buttons.forEach((btn) => {
    buttonHTML += `
      <button class="px-4 py-2 rounded-lg font-medium ${btn.class || "bg-gray-300 text-gray-900"}" 
              id="btn-${btn.id}">
        ${btn.text}
      </button>
    `;
  });

  modal.innerHTML = `
    <div class="bg-white rounded-lg shadow-lg max-w-md w-full mx-4">
      <div class="p-6">
        <h3 class="text-xl font-bold text-gray-900 mb-4">${title}</h3>
        <div class="mb-6">
          ${content}
        </div>
        <div class="flex justify-end gap-2">
          ${buttonHTML}
          <button class="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 font-medium" 
                  id="btn-cancel">
            Cancel
          </button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  function closeModal() {
    modal.remove();
  }

  document.getElementById("btn-cancel").addEventListener("click", closeModal);

  buttons.forEach((btn) => {
    const btnElement = document.getElementById(`btn-${btn.id}`);
    if (btnElement) {
      btnElement.addEventListener("click", () => {
        if (btn.action) {
          btn.action();
        }
        closeModal();
      });
    }
  });

  return closeModal;
}

/**
 * Promise-based confirmation dialog. Replaces window.confirm() so
 * destructive and irreversible actions get a styled prompt that matches the
 * rest of the UI and is keyboard-accessible.
 *
 * Resolves true when the user confirms, false when they cancel, press
 * Escape, click the backdrop, or press Enter on the cancel path.
 *
 *   if (!(await confirmAction({ title: "Delete?", message: "Cannot be undone.", variant: "danger", confirmText: "Delete" }))) return;
 */
function confirmAction({
  title = "Are you sure?",
  message = "",
  confirmText = "Confirm",
  cancelText = "Cancel",
  variant = "primary",
} = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className =
      "fixed inset-0 z-[100] flex items-center justify-center bg-black bg-opacity-50 p-4";

    const confirmClass =
      variant === "danger"
        ? "bg-red-600 hover:bg-red-700 text-white"
        : "bg-blue-600 hover:bg-blue-700 text-white";

    overlay.innerHTML = `
      <div class="bg-white rounded-xl shadow-xl max-w-sm w-full p-6" role="dialog" aria-modal="true" aria-labelledby="confirm-action-title">
        <h3 id="confirm-action-title" class="text-lg font-bold text-gray-900 mb-2">${escapeHtml(title)}</h3>
        ${message ? `<p class="text-sm text-gray-600 mb-6 whitespace-pre-line">${escapeHtml(message)}</p>` : `<div class="mb-6"></div>`}
        <div class="flex gap-3 justify-end">
          <button type="button" data-confirm-cancel class="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 font-medium">${escapeHtml(cancelText)}</button>
          <button type="button" data-confirm-ok class="px-4 py-2 rounded-lg font-medium ${confirmClass}">${escapeHtml(confirmText)}</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const okBtn = overlay.querySelector("[data-confirm-ok]");
    const cancelBtn = overlay.querySelector("[data-confirm-cancel]");

    const onKey = (event) => {
      if (event.key === "Escape") {
        finish(false);
      } else if (event.key === "Enter") {
        event.preventDefault();
        finish(true);
      }
    };

    function finish(result) {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      resolve(result);
    }

    okBtn.addEventListener("click", () => finish(true));
    cancelBtn.addEventListener("click", () => finish(false));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) finish(false);
    });

    document.addEventListener("keydown", onKey);
    okBtn.focus();
  });
}

/**
 * Close all modals
 */
function closeAllModals() {
  const modals = document.querySelectorAll('[id$="overlay"]');
  modals.forEach((modal) => modal.remove());
}

/**
 * Render empty state
 */
function renderEmptyState(container, message) {
  container.innerHTML = `
    <div class="text-center py-12">
      <h3 class="text-lg font-semibold text-gray-900 mb-2">No Data</h3>
      <p class="text-gray-600">${message}</p>
    </div>
  `;
}

/**
 * Render loading skeleton
 */
function renderSkeleton(container, count = 3) {
  let html = "";
  for (let i = 0; i < count; i++) {
    html += `
      <div class="animate-pulse">
        <div class="bg-gray-300 h-48 rounded-lg mb-4"></div>
        <div class="bg-gray-300 h-4 rounded mb-2"></div>
        <div class="bg-gray-300 h-4 rounded w-3/4"></div>
      </div>
    `;
  }
  container.innerHTML = html;
}

/**
 * Create image preview
 */
function createImagePreview(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      resolve(e.target.result);
    };
    reader.readAsDataURL(file);
  });
}
