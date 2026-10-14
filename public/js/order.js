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

// Card checks run in the browser only. The full card number, expiry and CVV
// are never sent to our server: until a payment gateway is connected, the
// order records just the card type and last 4 digits.
function cardBrand(number) {
  const n = String(number).replace(/\D/g, "");
  if (/^4/.test(n)) return "visa";
  if (/^(5[1-5]|2[2-7])/.test(n)) return "mastercard";
  return "";
}

function luhnValid(number) {
  const n = String(number).replace(/\D/g, "");
  if (n.length < 13 || n.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < n.length; i++) {
    let d = Number(n[n.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

function expiryValid(value) {
  const m = String(value).match(/^(\d{2})\s*\/\s*(\d{2})$/);
  if (!m) return false;
  const month = Number(m[1]);
  const year = 2000 + Number(m[2]);
  if (month < 1 || month > 12) return false;
  const now = new Date();
  return year > now.getFullYear() || (year === now.getFullYear() && month >= now.getMonth() + 1);
}

function validateOrder(values) {
  const errors = {};
  const digits = values.phone.replace(/\D/g, "");
  if (!values.full_name || values.full_name.length < 2) errors.full_name = "Please enter your full name.";
  if (!values.phone) errors.phone = "WhatsApp number is required.";
  else if (!/^\+?[\d\s\-()]{7,25}$/.test(values.phone) || digits.length < 7 || digits.length > 15)
    errors.phone = "Please enter a valid number, e.g. 0977 123 456.";
  if (!values.email) errors.email = "Email is required.";
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(values.email)) errors.email = "Please enter a valid email address.";
  if (!values.payment_method) errors.payment_method = "Please choose how you'll pay.";
  else if (values.payment_method === "mobile_money") {
    const payDigits = values.payment_phone.replace(/\D/g, "");
    if (!values.mobile_operator) errors.mobile_operator = "Please choose your mobile money operator.";
    else if (!values.payment_phone) errors.payment_phone = "Please enter the mobile money number.";
    else if (!/^\+?[\d\s\-()]{7,25}$/.test(values.payment_phone) || payDigits.length < 7 || payDigits.length > 15)
      errors.payment_phone = "Please enter a valid number, e.g. 0977 123 456.";
  } else if (values.payment_method === "card") {
    const brand = cardBrand(values.card_number);
    if (!values.card_number) errors.card_number = "Please enter your card number.";
    else if (!brand) errors.card_number = "We accept Visa and Mastercard.";
    else if (!luhnValid(values.card_number)) errors.card_number = "Please check the card number.";
    if (values.card_name.length < 2) errors.card_name = "Please enter the name on the card.";
    if (!expiryValid(values.card_expiry)) errors.card_expiry = "Enter a valid expiry date (MM/YY).";
    if (!/^\d{3}$/.test(values.card_cvc)) errors.card_cvc = "Enter the 3-digit security code.";
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
  const units = (n) => quantityLabel(n, listing.animal_name, listing.animal_kind);
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
          <h2>Payment</h2>
          <div class="choice-grid">
            <label class="choice-card"><input type="radio" name="payment_method" value="mobile_money">
              <span class="choice-dot"></span><span><b>Mobile money</b><small>Airtel, MTN or Zamtel</small></span></label>
            <label class="choice-card"><input type="radio" name="payment_method" value="card">
              <span class="choice-dot"></span><span><b>Visa card</b><small>Visa or Mastercard</small></span></label>
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
          <div data-card hidden class="momo-box">
            <div class="grid grid-cols-2 gap-4">
              <div class="card-full">
                <label for="buy-card-number" class="field-label">Card number</label>
                <div class="card-input">
                  <input id="buy-card-number" name="card_number" type="text" class="field-input" inputmode="numeric" autocomplete="cc-number" maxlength="23" placeholder="1234 5678 9012 3456">
                  <span class="card-brand" data-card-brand></span>
                </div>
                <p class="field-error hidden" data-error-for="card_number"></p>
              </div>
              <div class="card-full">
                <label for="buy-card-name" class="field-label">Name on card</label>
                <input id="buy-card-name" name="card_name" type="text" class="field-input" autocomplete="cc-name" maxlength="80">
                <p class="field-error hidden" data-error-for="card_name"></p>
              </div>
              <div>
                <label for="buy-card-expiry" class="field-label">Expiry</label>
                <input id="buy-card-expiry" name="card_expiry" type="text" class="field-input" inputmode="numeric" autocomplete="cc-exp" maxlength="7" placeholder="MM/YY">
                <p class="field-error hidden" data-error-for="card_expiry"></p>
              </div>
              <div>
                <label for="buy-card-cvc" class="field-label">CVV</label>
                <input id="buy-card-cvc" name="card_cvc" type="password" class="field-input" inputmode="numeric" autocomplete="cc-csc" maxlength="3" placeholder="123">
                <p class="field-error hidden" data-error-for="card_cvc"></p>
              </div>
            </div>
          </div>
          <p class="text-xs text-gray-500 mt-3">You won't be charged now. We'll contact you on WhatsApp to complete the payment.</p>
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
          <p class="text-xs text-gray-500 mt-1">Collect from the farm${listing.location ? ` in ${escapeHtml(listing.location)} Province` : ""}</p>

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
    const ready = !Object.keys(validateOrder(values)).length;
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
  const momoBox = root.querySelector("[data-momo]");
  const momoNumber = root.querySelector("[data-momo-number]");
  const OPERATOR_NAMES = { airtel: "Airtel Money", mtn: "MTN MoMo", zamtel: "Zamtel Kwacha" };
  const cardBox = root.querySelector("[data-card]");
  form.querySelectorAll('input[name="payment_method"]').forEach((r) => r.addEventListener("change", () => {
    momoBox.hidden = form.elements.payment_method.value !== "mobile_money";
    cardBox.hidden = form.elements.payment_method.value !== "card";
    if (!cardBox.hidden) form.elements.card_number.focus();
  }));
  // Card number in groups of 4, with the card type shown; expiry as MM/YY.
  const cardNumber = form.elements.card_number;
  cardNumber.addEventListener("input", () => {
    const digits = cardNumber.value.replace(/\D/g, "").slice(0, 19);
    cardNumber.value = digits.replace(/(\d{4})(?=\d)/g, "$1 ");
    const brand = cardBrand(digits);
    const badge = root.querySelector("[data-card-brand]");
    badge.textContent = brand === "visa" ? "VISA" : brand === "mastercard" ? "Mastercard" : "";
    badge.dataset.brand = brand;
  });
  const cardExpiry = form.elements.card_expiry;
  cardExpiry.addEventListener("input", (e) => {
    let d = cardExpiry.value.replace(/\D/g, "").slice(0, 4);
    if (d.length === 1 && Number(d) > 1) d = `0${d}`;
    cardExpiry.value = d.length > 2 || (d.length === 2 && e.inputType !== "deleteContentBackward") ? `${d.slice(0, 2)}/${d.slice(2)}` : d;
  });
  form.elements.card_cvc.addEventListener("input", (e) => { e.target.value = e.target.value.replace(/\D/g, "").slice(0, 3); });
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
      delivery: "collect",
      payment_method: form.elements.payment_method.value,
      mobile_operator: form.elements.mobile_operator.value,
      payment_phone: form.elements.payment_phone.value.trim(),
      card_number: form.elements.card_number.value.trim(),
      card_name: form.elements.card_name.value.trim(),
      card_expiry: form.elements.card_expiry.value.trim(),
      card_cvc: form.elements.card_cvc.value.trim(),
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

  // What goes to the server. Card number, expiry and CVV stay in the browser.
  function orderPayload(values) {
    const { card_number: cardNo, card_name: cardName, card_expiry: cardExp, card_cvc: cardCvc, ...rest } = values;
    const card = values.payment_method === "card"
      ? { card_brand: cardBrand(cardNo), card_last4: cardNo.replace(/\D/g, "").slice(-4) }
      : {};
    return { ...rest, ...card, quantity: qty, livestock_id: listing.id, website: form.elements.website.value };
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const alertBox = root.querySelector("#buy-alert");
    alertBox.classList.add("hidden");
    const values = readValues();
    const errors = validateOrder(values);
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
        body: orderPayload(values),
      });
      showSuccess(res.data);
    } catch (error) {
      if (error.errors) showErrors(error.errors);
      alertBox.textContent = error.message || "Your order could not be placed. Please try again.";
      alertBox.classList.remove("hidden");
      alertBox.scrollIntoView({ behavior: "smooth", block: "center" });
      placing = false;
      refresh();
    }
  });

  function showSuccess(order) {
    const firstName = form.elements.full_name.value.trim().split(/\s+/)[0];
    const thumb = listing.images?.[0]?.thumb_path || photo;
    root.innerHTML = `
      <div class="checkout-done" role="status">
        <div class="order-done-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg></div>
        <h1 class="text-xl sm:text-2xl font-bold text-gray-900 mt-4">Order ${escapeHtml(order.reference)} placed</h1>
        <p class="text-sm text-gray-600 mt-2">Thank you, ${escapeHtml(firstName)}. ${listing.animal_kind === "feed" ? "The feed is" : "The animals are"} now reserved for you. We'll contact you on both WhatsApp and email to arrange collection.</p>
        <div class="order-summary checkout-done-summary">
          <div class="order-thumb">${thumb ? `<img src="${escapeHtml(thumb)}" alt="">` : livestockFallbackMedia("w-8 h-8")}</div>
          <div class="min-w-0 flex-1">
            <p class="text-sm font-semibold text-gray-900 line-clamp-2">${escapeHtml(listing.title)}</p>
            <p class="text-xs text-gray-500 mt-0.5">${escapeHtml(lot ? "The whole lot" : units(order.quantity))} · Collect from farm</p>
          </div>
          <p class="order-total">${kwacha(order.total)}</p>
        </div>
        <a href="/#listings" class="btn-contact btn-inquire btn-lg w-full mt-6">Back to listings</a>
      </div>`;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
}
