// Buyer accounts in the browser: API calls, the signed-in header and the
// "where to go after logging in" rule. Form helpers (withBusy,
// showFieldErrors, bindPasswordToggles, bindPasswordMeter) come from seller.js.
const BUYER_HEADER = { "X-Frontier-Buyer": "1" };
const BUYER_HINT_KEY = "frontier.buyer";

function setBuyerHint(on) {
  try {
    if (on) localStorage.setItem(BUYER_HINT_KEY, "1");
    else localStorage.removeItem(BUYER_HINT_KEY);
  } catch {
  }
}

function buyerHinted() {
  try {
    return localStorage.getItem(BUYER_HINT_KEY) === "1";
  } catch {
    return false;
  }
}

async function buyerApi(url, options = {}) {
  try {
    return await apiRequest(url, { ...options, headers: { ...BUYER_HEADER, ...options.headers } });
  } catch (error) {
    const formRequest = /\/auth\/(login|register|forgot|reset|verify)$/.test(url.split("?")[0]);
    const formPage = /\/account\/(login|register|forgot|reset|verify)(\.html)?$/.test(location.pathname);
    if (error.status === 401 && !formRequest && !formPage) {
      setBuyerHint(false);
      window.location.href = `/account/login?next=${encodeURIComponent(location.pathname + location.search)}`;
      await new Promise(() => {});
    }
    throw error;
  }
}

// After logging in: back to the account, the checkout or the cart only.
function buyerNext(fallback = "/account/") {
  const next = getQueryParams().next || "";
  const allowed = /^\/(account\/|(checkout|cart|pay)(\.html)?([?#]|$))/.test(next) && !next.startsWith("//");
  return allowed ? next : fallback;
}

const buyerInitials = (name) => String(name || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
const buyerFirst = (name) => String(name || "").trim().split(/\s+/)[0] || "Account";

async function buyerLogout() {
  if (!(await confirmAction({ title: "Sign out?", message: "You'll need to sign in again to see your orders or check out.", confirmText: "Sign Out" }))) return;
  try {
    await buyerApi("/api/buyer/auth/logout", { method: "POST" });
  } finally {
    setBuyerHint(false);
    window.location.href = "/";
  }
}

// The account button for a signed-in buyer, in any header.
function buyerChip(buyer) {
  return `<a href="/account/" class="buyer-chip" aria-label="My account">
    <span class="buyer-chip-av">${escapeHtml(buyerInitials(buyer.full_name))}</span>
    <span class="buyer-chip-name">${escapeHtml(buyerFirst(buyer.full_name))}</span></a>`;
}

// Header for the account pages (and the sign-in forms when buyer is null).
function accountHeader(buyer) {
  return `
    <nav id="page-topnav" class="site-topnav sticky top-0 z-50">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center gap-3">
        <a href="/" class="flex items-center gap-3 flex-shrink-0" aria-label="Frontier Marketplace home">
          <div class="brand-mark-full"><img src="/images/logo-full.jpg" alt="Frontier Farms &amp; Consult"></div>
          <span class="hidden sm:block font-bold site-topnav-name">Frontier Marketplace</span>
        </a>
        <div class="site-nav ml-4" data-site-nav aria-label="Categories"></div>
        <div class="flex items-center gap-2 sm:gap-3 header-auth-acc" data-cart-slot>
          ${buyer ? buyerChip(buyer) : `<a href="/account/login" class="header-login-link">Sign In</a>`}
        </div>
      </div>
    </nav>`;
}

// Public pages: show "My account" in place of Log in / Register once a buyer
// is signed in (checked only when this browser has signed in before).
async function initBuyerHeader() {
  const slot = document.querySelector(".header-auth");
  if (!slot || !buyerHinted()) return;
  try {
    const res = await fetch("/api/buyer/auth/me", { credentials: "same-origin" });
    if (!res.ok) return setBuyerHint(false);
    const { data } = await res.json();
    ["login-link", "seller-link"].forEach((id) => { const el = document.getElementById(id); if (el) { el.hidden = true; el.style.display = "none"; } });
    if (!slot.querySelector(".buyer-chip")) slot.insertAdjacentHTML("beforeend", buyerChip(data));
  } catch {
  }
}
document.addEventListener("DOMContentLoaded", initBuyerHeader);
