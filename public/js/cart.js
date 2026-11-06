// Shopping cart. The cart lives in this browser only (listing ids and
// quantities); prices and availability always come from the server
// (POST /api/checkout/quote), and the order is placed at checkout.

const CART_KEY = "frontier.cart";
let cartMemory = [];

function readCart() {
  try {
    const raw = JSON.parse(localStorage.getItem(CART_KEY) || "[]");
    if (Array.isArray(raw)) return raw.filter((l) => l && Number(l.id) > 0 && Number(l.qty) > 0);
  } catch {
    // Storage blocked: fall back to this page's memory.
  }
  return cartMemory;
}

function writeCart(lines) {
  cartMemory = lines;
  try {
    localStorage.setItem(CART_KEY, JSON.stringify(lines));
  } catch {
    // Storage blocked: the cart lasts while this page is open.
  }
  updateCartBadges();
}

function cartCount() {
  return readCart().length;
}

// Adds a listing, or sets its quantity when it's already in the cart.
function addToCart(id, qty = 1) {
  const lines = readCart().filter((l) => Number(l.id) !== Number(id));
  lines.push({ id: Number(id), qty: Math.max(1, Number(qty) || 1) });
  writeCart(lines);
}

function setCartQty(id, qty) {
  writeCart(readCart().map((l) => (Number(l.id) === Number(id) ? { ...l, qty: Math.max(1, Number(qty) || 1) } : l)));
}

function removeFromCart(id) {
  writeCart(readCart().filter((l) => Number(l.id) !== Number(id)));
}

function clearCart() {
  writeCart([]);
}

function inCart(id) {
  return readCart().some((l) => Number(l.id) === Number(id));
}

const CART_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4h2.2l2.1 10.2a1.6 1.6 0 0 0 1.6 1.3h8.3a1.6 1.6 0 0 0 1.6-1.2L20.5 8H6.1"/><circle cx="9.5" cy="19.5" r="1.4"/><circle cx="17" cy="19.5" r="1.4"/></svg>`;

function updateCartBadges() {
  const n = cartCount();
  document.querySelectorAll("[data-cart-count]").forEach((el) => {
    el.textContent = n > 99 ? "99+" : String(n);
    el.hidden = n === 0;
  });
  document.querySelectorAll(".header-cart").forEach((a) => a.setAttribute("aria-label", n ? `Cart, ${n} item${n === 1 ? "" : "s"}` : "Cart"));
}

// The cart button goes first in the header's sign-in area on every page.
function renderCartButtons() {
  document.querySelectorAll(".header-auth, [data-cart-slot]").forEach((slot) => {
    if (slot.querySelector(".header-cart")) return;
    slot.insertAdjacentHTML("afterbegin", `<a href="/cart.html" class="header-cart" aria-label="Cart">${CART_ICON}<span class="header-cart-count" data-cart-count hidden></span></a>`);
  });
  updateCartBadges();
}
document.addEventListener("DOMContentLoaded", renderCartButtons);
// Another tab changed the cart.
window.addEventListener("storage", (e) => { if (e.key === CART_KEY) updateCartBadges(); });

// "Added to cart" note with a link to the cart.
function showCartToast(title) {
  let toast = document.getElementById("cart-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "cart-toast";
    toast.className = "cart-toast";
    toast.setAttribute("role", "status");
    document.body.appendChild(toast);
  }
  toast.innerHTML = `<span class="cart-toast-icon">${CART_ICON}</span>
    <span class="cart-toast-text"><b>Added to cart</b><small>${escapeHtml(title)}</small></span>
    <a href="/cart.html" class="cart-toast-link">View cart</a>`;
  toast.classList.add("is-shown");
  clearTimeout(showCartToast.timer);
  showCartToast.timer = setTimeout(() => toast.classList.remove("is-shown"), 4000);
}

// Buy now: put the item in the cart and go straight to checkout.
function buyNow(listing, qty = 1) {
  addToCart(listing.id, listing.price_unit === "lot" ? Number(listing.quantity) || 1 : qty);
  window.location.href = "/checkout.html";
}
// Older pages call it by this name.
function openBuyModal(listing, qty = 1) {
  buyNow(listing, qty);
}

// Cart, Details, Payment: where the buyer is in checkout.
function checkoutSteps(current) {
  const steps = ["Cart", "Details", "Payment"];
  return `<ol class="checkout-steps" aria-label="Checkout steps">${steps.map((s, i) => {
    const state = i < current ? "done" : i === current ? "current" : "";
    return `<li class="${state}" ${i === current ? 'aria-current="step"' : ""}><span>${i < current ? "✓" : i + 1}</span>${s}</li>`;
  }).join("")}</ol>`;
}

// "4 head" / "200 birds" / "10 bags"
function cartUnits(item, n) {
  return quantityLabel(n, item.animal_name, item.animal_kind);
}

// Visa / Mastercard: Lipila's secure card form shown inside our page. The card
// number, expiry and CVV are typed into Lipila's page in this box; they never
// pass through Frontier.
function cardFrame(url, total) {
  const lock = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>`;
  return `<div class="card-frame" data-card-frame>
      <div class="card-frame-head">${lock}<span>Secure card payment</span>${total ? `<span class="card-frame-amount">${kwacha(total)}</span>` : ""}</div>
      <iframe src="${escapeHtml(url)}" title="Secure card payment by Lipila" allow="payment" referrerpolicy="no-referrer-when-downgrade"></iframe>
      <p class="card-frame-foot">Visa and Mastercard, secured by Lipila. Your card details never reach Frontier.
        <a href="${escapeHtml(url)}">Form not showing? Open it on its own page</a></p>
    </div>`;
}

// Checks the order every few seconds while the card box is open and calls
// onPaid once Lipila has confirmed the payment.
function watchCardPayment(id, token, onPaid) {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const v = (await apiRequest(`/api/checkout/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}`)).data;
      if (v.status === "paid") { stopped = true; return onPaid(v); }
    } catch {
      // Try again on the next tick.
    }
    setTimeout(tick, 5000);
  };
  setTimeout(tick, 5000);
  return () => { stopped = true; };
}
