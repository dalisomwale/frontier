// "Buy Now" checkout. Buy Now buttons open /buy.html, a full page with the
// order form on one side and the summary on the other. Nothing is paid here:
// the team confirms with the seller and sends payment details by WhatsApp
// and email.

function buyUrl(listingId, quantity = 1) {
  const qty = Number(quantity) > 1 ? `&qty=${encodeURIComponent(quantity)}` : "";
  return `/buy.html?id=${encodeURIComponent(listingId)}${qty}`;
}

// Kept under its old name: the cards and the listing page call it.
function openBuyModal(listing, quantity = 1) {
  window.location.href = buyUrl(listing.id, quantity);
}

function validateOrder(values, needsAddress) {
  const errors = {};
  const digits = values.phone.replace(/\D/g, "");
  if (!values.full_name || values.full_name.length < 2) errors.full_name = "Please enter your full name.";
  if (!values.phone) errors.phone = "WhatsApp number is required.";
  else if (!/^\+?[\d\s\-()]{7,25}$/.test(values.phone) || digits.length < 7 || digits.length > 15)
    errors.phone = "Please enter a valid number, e.g. 0977 123 456.";
  if (!values.email) errors.email = "Email is required.";
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(values.email)) errors.email = "Please enter a valid email address.";
  if (needsAddress && values.delivery_address.length < 5) errors.delivery_address = "Please enter the delivery address.";
  if (!values.payment_method) errors.payment_method = "Please choose how you'll pay.";
  else if (values.payment_method === "mobile_money") {
    const payDigits = values.payment_phone.replace(/\D/g, "");
    if (!values.mobile_operator) errors.mobile_operator = "Please choose your mobile money operator.";
    else if (!values.payment_phone) errors.payment_phone = "Please enter the mobile money number.";
    else if (!/^\+?[\d\s\-()]{7,25}$/.test(values.payment_phone) || payDigits.length < 7 || payDigits.length > 15)
      errors.payment_phone = "Please enter a valid number, e.g. 0977 123 456.";
  }
  return errors;
}

function renderCheckout(root, listing, startQuantity = 1) {
  const photo = listing.images?.[0]?.image_path || listing.images?.[0]?.thumb_path || listing.thumb_path;
  const lot = listing.price_unit === "lot";
  const max = Math.max(1, Number(listing.quantity) || 1);
  const price = Number(listing.price);
  let qty = lot ? max : Math.min(Math.max(1, Number(startQuantity) || 1), max);
  const total = () => (lot ? price : price * qty);
  const units = (n) => quantityLabel(n, listing.animal_name);
  const subtitle = [listing.breed_name, listing.category_name, listing.animal_name].filter(Boolean).join(", ");

  root.innerHTML = `
    <nav class="text-sm mb-5" aria-label="Breadcrumb">
      <a href="${listingUrl(listing.id)}" class="inline-flex items-center gap-1 font-medium text-blue-600 hover:text-blue-700"><span class="w-4 h-4">${uiIcon("chevronLeft")}</span>Back to listing</a>
    </nav>
    <h1 class="text-xl sm:text-2xl font-bold text-gray-900 mb-6">Buy livestock</h1>

    <form id="buy-form" class="checkout" novalidate>
      <div class="checkout-main">
        <div id="buy-alert" class="hidden alert alert-error text-sm" role="alert"></div>

        <section class="checkout-section">
          <h2>Your details</h2>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label for="buy-name" class="field-label">Full name</label>
              <input id="buy-name" name="full_name" type="text" class="field-input" autocomplete="name" maxlength="120" required>
              <p class="field-error hidden" data-error-for="full_name"></p>
            </div>
            <div>
              <label for="buy-phone" class="field-label">WhatsApp Number</label>
              <input id="buy-phone" name="phone" type="tel" class="field-input" autocomplete="tel" inputmode="tel" maxlength="25" required placeholder="0977 123 456">
              <p class="field-error hidden" data-error-for="phone"></p>
            </div>
            <div class="sm:col-span-2">
              <label for="buy-email" class="field-label">Email</label>
              <input id="buy-email" name="email" type="email" class="field-input" autocomplete="email" inputmode="email" maxlength="255" required>
              <p class="field-error hidden" data-error-for="email"></p>
            </div>
          </div>
        </section>

        <section class="checkout-section">
          <h2>Delivery</h2>
          <div class="choice-grid">
            <label class="choice-card"><input type="radio" name="delivery" value="collect" checked>
              <span class="choice-dot"></span><span><b>Collect from farm</b><small>${escapeHtml(listing.location || "")} Province</small></span></label>
            <label class="choice-card"><input type="radio" name="delivery" value="deliver">
              <span class="choice-dot"></span><span><b>Deliver to me</b><small>Cost confirmed with you</small></span></label>
          </div>
          <div data-address hidden class="mt-4">
            <label for="buy-address" class="field-label">Delivery address</label>
            <textarea id="buy-address" name="delivery_address" rows="3" class="field-input" maxlength="300" placeholder="Farm or street, town"></textarea>
            <p class="field-error hidden" data-error-for="delivery_address"></p>
          </div>
        </section>

        <section class="checkout-section">
          <h2>Payment</h2>
          <div class="choice-grid">
            <label class="choice-card"><input type="radio" name="payment_method" value="mobile_money">
              <span class="choice-dot"></span><span><b>Mobile money</b><small>Airtel, MTN or Zamtel</small></span></label>
            <label class="choice-card"><input type="radio" name="payment_method" value="bank_transfer">
              <span class="choice-dot"></span><span><b>Bank transfer</b><small>Details sent to you</small></span></label>
          </div>
          <p class="field-error hidden" data-error-for="payment_method"></p>

          <div data-momo hidden class="momo-box">
            <p class="field-label">Operator</p>
            <div class="operator-grid" role="radiogroup" aria-label="Mobile money operator">
              <label class="operator-card op-airtel"><input type="radio" name="mobile_operator" value="airtel"><span class="op-tick" aria-hidden="true"></span><span>Airtel Money</span></label>
              <label class="operator-card op-mtn"><input type="radio" name="mobile_operator" value="mtn"><span class="op-tick" aria-hidden="true"></span><span>MTN MoMo</span></label>
              <label class="operator-card op-zamtel"><input type="radio" name="mobile_operator" value="zamtel"><span class="op-tick" aria-hidden="true"></span><span>Zamtel Kwacha</span></label>
            </div>
            <p class="field-error hidden" data-error-for="mobile_operator"></p>

            <div data-momo-number hidden class="mt-4">
              <label for="buy-momo" class="field-label" data-momo-label>Mobile money number</label>
              <input id="buy-momo" name="payment_phone" type="tel" class="field-input" autocomplete="tel" inputmode="tel" maxlength="25" placeholder="0977 123 456">
              <p class="field-error hidden" data-error-for="payment_phone"></p>
            </div>
          </div>
          <p class="text-xs text-gray-500 mt-3">You don't pay now. We confirm with the seller first, then send payment details to your WhatsApp and email.</p>
        </section>

        <div class="honeypot" aria-hidden="true">
          <label>Website <input type="text" name="website" tabindex="-1" autocomplete="off"></label>
        </div>

        <button type="submit" class="btn-buy btn-lg w-full checkout-submit-mobile" data-submit></button>
      </div>

      <aside class="checkout-summary">
        <div class="checkout-photo">${photo ? `<img src="${escapeHtml(photo)}" alt="${escapeHtml(listing.title)}">` : livestockFallbackMedia("w-14 h-14")}</div>
        <div class="p-4 sm:p-5">
          <p class="font-semibold text-gray-900">${escapeHtml(listing.title)}</p>
          <p class="text-xs text-gray-500 mt-0.5">${escapeHtml([subtitle, listing.location].filter(Boolean).join(" · "))}</p>
          <p class="text-sm text-gray-600 mt-3"><span class="font-semibold text-gray-800">${kwacha(price)}</span> ${priceUnitLabel(listing)}</p>

          ${lot ? `<p class="text-sm text-gray-600 mt-3">The whole lot: ${escapeHtml(units(max))}</p>` : `
          <div class="flex items-center justify-between gap-3 mt-4">
            <div>
              <p class="text-sm font-semibold text-gray-800">Quantity</p>
              <p class="text-xs text-gray-500">${escapeHtml(units(max))} available</p>
            </div>
            <div class="qty-stepper" role="group" aria-label="Quantity">
              <button type="button" data-step="-1" aria-label="Fewer">&minus;</button>
              <input name="quantity" type="number" inputmode="numeric" min="1" max="${max}" value="${qty}" aria-label="Quantity">
              <button type="button" data-step="1" aria-label="More">+</button>
            </div>
          </div>
          <p class="field-error hidden" data-error-for="quantity"></p>`}

          <div class="buy-total"><span>Total</span><strong data-total></strong></div>
          <button type="submit" class="btn-buy btn-lg w-full checkout-submit-desktop" data-submit></button>
        </div>
      </aside>
    </form>`;

  const form = root.querySelector("#buy-form");
  const submits = root.querySelectorAll("[data-submit]");
  const qtyInput = form.elements.quantity;

  let placing = false;
  // Place order stays disabled until every required field is filled in.
  function updateReady() {
    if (placing) return;
    const values = readValues();
    const ready = !Object.keys(validateOrder(values, values.delivery === "deliver")).length;
    submits.forEach((b) => {
      b.disabled = !ready;
      b.title = ready ? "" : "Fill in your details and payment to place the order";
    });
  }

  function refresh() {
    root.querySelector("[data-total]").textContent = kwacha(total());
    submits.forEach((b) => { b.textContent = `Place order · ${kwacha(total())}`; });
    updateReady();
    if (qtyInput) {
      root.querySelector('[data-step="-1"]').disabled = qty <= 1;
      root.querySelector('[data-step="1"]').disabled = qty >= max;
    }
  }
  if (qtyInput) {
    root.querySelectorAll("[data-step]").forEach((b) => b.addEventListener("click", () => {
      qty = Math.min(max, Math.max(1, qty + Number(b.dataset.step)));
      qtyInput.value = qty;
      refresh();
    }));
    qtyInput.addEventListener("input", () => {
      const n = Number.parseInt(qtyInput.value, 10);
      if (Number.isFinite(n)) qty = Math.min(max, Math.max(1, n));
      refresh();
    });
    qtyInput.addEventListener("blur", () => { qtyInput.value = qty; });
  }
  const addressBox = root.querySelector("[data-address]");
  form.querySelectorAll('input[name="delivery"]').forEach((r) => r.addEventListener("change", () => {
    addressBox.hidden = form.elements.delivery.value !== "deliver";
    if (!addressBox.hidden) form.elements.delivery_address.focus();
  }));
  const momoBox = root.querySelector("[data-momo]");
  const momoNumber = root.querySelector("[data-momo-number]");
  const OPERATOR_NAMES = { airtel: "Airtel Money", mtn: "MTN MoMo", zamtel: "Zamtel Kwacha" };
  form.querySelectorAll('input[name="payment_method"]').forEach((r) => r.addEventListener("change", () => {
    momoBox.hidden = form.elements.payment_method.value !== "mobile_money";
  }));
  form.querySelectorAll('input[name="mobile_operator"]').forEach((r) => r.addEventListener("change", () => {
    momoNumber.hidden = false;
    root.querySelector("[data-momo-label]").textContent = `${OPERATOR_NAMES[r.value]} number`;
    const momoInput = form.elements.payment_phone;
    if (!momoInput.value && form.elements.phone.value.trim()) momoInput.value = form.elements.phone.value.trim();
    momoInput.focus();
    updateReady();
  }));
  form.addEventListener("input", updateReady);
  form.addEventListener("change", updateReady);
  refresh();

  function readValues() {
    return {
      full_name: form.elements.full_name.value.trim(),
      phone: form.elements.phone.value.trim(),
      email: form.elements.email.value.trim(),
      delivery: form.elements.delivery.value,
      delivery_address: form.elements.delivery_address.value.trim(),
      payment_method: form.elements.payment_method.value,
      mobile_operator: form.elements.mobile_operator.value,
      payment_phone: form.elements.payment_phone.value.trim(),
    };
  }

  function showErrors(errors) {
    form.querySelectorAll("[data-error-for]").forEach((el) => {
      const name = el.dataset.errorFor;
      const input = form.elements[name];
      const msg = errors[name];
      el.textContent = msg || "";
      el.classList.toggle("hidden", !msg);
      if (input && input.classList) {
        input.classList.toggle("has-error", Boolean(msg));
        input.setAttribute("aria-invalid", msg ? "true" : "false");
      }
    });
    const first = Object.keys(errors).find((k) => form.elements[k] && form.elements[k].focus);
    if (first) form.elements[first].focus();
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const alertBox = root.querySelector("#buy-alert");
    alertBox.classList.add("hidden");
    const values = readValues();
    const errors = validateOrder(values, values.delivery === "deliver");
    showErrors(errors);
    if (Object.keys(errors).length) return;

    placing = true;
    submits.forEach((b) => {
      b.disabled = true;
      b.innerHTML = `<span class="btn-spinner"></span> Placing order…`;
    });
    try {
      const res = await apiRequest("/api/orders", {
        method: "POST",
        body: { ...values, quantity: qty, livestock_id: listing.id, website: form.elements.website.value },
      });
      showSuccess(res.data, values.delivery);
    } catch (error) {
      if (error.errors) showErrors(error.errors);
      alertBox.textContent = error.message || "Your order could not be placed. Please try again.";
      alertBox.classList.remove("hidden");
      alertBox.scrollIntoView({ behavior: "smooth", block: "center" });
      placing = false;
      refresh();
    }
  });

  function showSuccess(order, delivery) {
    const thumb = listing.images?.[0]?.thumb_path || photo;
    root.innerHTML = `
      <div class="checkout-done" role="status">
        <div class="order-done-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg></div>
        <h1 class="text-xl sm:text-2xl font-bold text-gray-900 mt-4">Order ${escapeHtml(order.reference)} received</h1>
        <p class="text-sm text-gray-600 mt-2">We'll confirm availability with the seller and send payment details to your WhatsApp and email.</p>
        <ol class="order-steps" aria-label="Order progress">
          <li class="done">Received</li><li>Confirmed</li><li>Paid</li><li>Completed</li>
        </ol>
        <div class="order-summary">
          <div class="order-thumb">${thumb ? `<img src="${escapeHtml(thumb)}" alt="">` : livestockFallbackMedia("w-8 h-8")}</div>
          <div class="min-w-0 flex-1">
            <p class="text-sm font-semibold text-gray-900 line-clamp-2">${escapeHtml(listing.title)}</p>
            <p class="text-xs text-gray-500 mt-0.5">${escapeHtml(lot ? "The whole lot" : units(order.quantity))} · ${delivery === "deliver" ? "Delivery" : "Collect from farm"}</p>
          </div>
          <p class="order-total">${kwacha(order.total)}</p>
        </div>
        <a href="/#listings" class="btn-contact btn-inquire btn-lg w-full mt-6">Back to listings</a>
      </div>`;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
}
