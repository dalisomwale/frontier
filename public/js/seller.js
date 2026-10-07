const SELLER_HEADER = { "X-Frontier-Seller": "1" };

async function sellerApi(url, options = {}) {
  try {
    return await apiRequest(url, { ...options, headers: { ...SELLER_HEADER, ...options.headers } });
  } catch (error) {
    if (error.status === 401 && !url.includes("/auth/")) {
      setSellerHint(false);
      window.location.href = `/seller/login.html?next=${encodeURIComponent(location.pathname + location.search)}`;
      await new Promise(() => {});
    }
    throw error;
  }
}

async function sellerLogout() {
  if (!(await confirmAction({ title: "Log out?", message: "You'll need to sign in again to manage your listings.", confirmText: "Log out" }))) return;
  try {
    await sellerApi("/api/seller/auth/logout", { method: "POST" });
  } finally {
    setSellerHint(false);
    window.location.href = "/";
  }
}

function safeNext(fallback = "/seller/") {
  const next = getQueryParams().next || "";
  return next.startsWith("/seller/") && !next.startsWith("//") ? next : fallback;
}

function sellerState(l) {
  if (l.review_status === "pending") return { key: "pending", label: "In review" };
  if (l.review_status === "rejected") return { key: "rejected", label: "Changes needed" };
  if (l.status === "published") return { key: "published", label: "Live" };
  return { key: "unpublished", label: "Hidden" };
}

function sellerPageHeader(seller) {
  return `
    <nav class="site-header sticky top-0 z-50">
      <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center gap-3">
        <a href="/" class="flex items-center gap-3 flex-shrink-0" aria-label="Frontier Marketplace home">
          <div class="brand-mark-full"><img src="/images/logo-full.jpg" alt="Frontier Farms &amp; Consult"></div>
          <span class="hidden sm:block font-bold text-gray-900">Frontier Marketplace</span>
        </a>
        <div class="ml-auto flex items-center gap-2">
          ${seller ? `<span class="hidden md:inline text-sm text-gray-500 mr-1">${escapeHtml(seller.business_name || seller.name)}</span>` : ""}
          <a href="/" class="hidden sm:inline-flex text-sm font-medium text-gray-600 hover:text-gray-900 px-3 py-2">View website</a>
          ${seller ? `<button type="button" data-seller-logout class="text-sm font-medium px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50">Logout</button>` : ""}
        </div>
      </div>
    </nav>`;
}

function bindPasswordToggles(root = document) {
  root.querySelectorAll("[data-toggle-password]").forEach((btn) => {
    btn.innerHTML = `<span class="w-5 h-5 block">${uiIcon("eye")}</span>`;
    btn.addEventListener("click", () => {
      const input = document.getElementById(btn.dataset.togglePassword);
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      btn.innerHTML = `<span class="w-5 h-5 block">${uiIcon(show ? "eyeOff" : "eye")}</span>`;
      btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
    });
  });
}

function showFieldErrors(form, error) {
  form.querySelectorAll(".field-error").forEach((el) => el.classList.add("hidden"));
  form.querySelectorAll(".has-error").forEach((el) => el.classList.remove("has-error"));
  for (const [name, message] of Object.entries(error.errors || {})) {
    form.elements[name]?.classList?.add("has-error");
    const holder = form.querySelector(`[data-error-for="${name}"]`);
    if (holder) {
      holder.textContent = message;
      holder.classList.remove("hidden");
    }
  }
}

async function withBusy(button, busyText, task) {
  const label = button.innerHTML;
  button.disabled = true;
  button.innerHTML = `<span class="btn-spinner"></span> ${escapeHtml(busyText)}`;
  try {
    return await task();
  } finally {
    button.disabled = false;
    button.innerHTML = label;
  }
}

["input", "change"].forEach((type) =>
  document.addEventListener(type, (e) => {
    const input = e.target;
    if (!input.classList?.contains("has-error")) return;
    input.classList.remove("has-error");
    input.form?.querySelector(`[data-error-for="${input.name}"]`)?.classList.add("hidden");
  }),
);
