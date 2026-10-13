// "Buy Now": the order form, shown as a modal (a bottom sheet on phones).
// Nothing is paid here; the team confirms with the seller and sends payment
// details by WhatsApp and email.

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
  return errors;
}

function openBuyModal(listing, startQuantity = 1) {
  closeBuyModal();
  closeInquiryModal();
  const lastFocus = document.activeElement;
  const thumb = listing.thumb_path || listing.images?.[0]?.thumb_path;
  const lot = listing.price_unit === "lot";
  const max = Math.max(1, Number(listing.quantity) || 1);
  const price = Number(listing.price);
  let qty = lot ? max : Math.min(Math.max(1, Number(startQuantity) || 1), max);
  const total = () => (lot ? price : price * qty);
  const unitWord = (n) => (typeof quantityLabel === "function" ? quantityLabel(n, listing.animal_name) : `${n}`);

  const backdrop = document.createElement("div");
  backdrop.id = "buy-modal";
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal-panel buy-panel" role="dialog" aria-modal="true" aria-labelledby="buy-title">
      <div class="flex items-center justify-between gap-3 px-5 py-4 border-b border-gray-100">
        <h2 id="buy-title" class="text-lg font-bold text-gray-900">Buy livestock</h2>
        <button type="button" data-close class="w-9 h-9 -mr-1 rounded-full flex items-center justify-center text-gray-500 hover:bg-gray-100" aria-label="Close">
          <span class="w-5 h-5">${uiIcon("close")}</span>
        </button>
      </div>

      <form id="buy-form" class="p-5 space-y-4" novalidate>
        <div id="buy-alert" class="hidden alert alert-error text-sm mb-0" role="alert"></div>

        <div class="order-summary">
          <div class="order-thumb">${thumb ? `<img src="${escapeHtml(thumb)}" alt="">` : livestockFallbackMedia("w-8 h-8")}</div>
          <div class="min-w-0 flex-1">
            <p class="text-sm font-semibold text-gray-900 line-clamp-2">${escapeHtml(listing.title)}</p>
            <p class="text-xs text-gray-500 mt-0.5" data-unit-line></p>
          </div>
          <p class="order-total" data-total></p>
        </div>

        ${lot ? "" : `
        <div class="flex items-center justify-between gap-3">
          <div>
            <p class="text-sm font-semibold text-gray-800">Quantity</p>
            <p class="text-xs text-gray-500">${escapeHtml(String(max))} available</p>
          </div>
          <div class="qty-stepper" role="group" aria-label="Quantity">
            <button type="button" data-step="-1" aria-label="Fewer">&minus;</button>
            <input name="quantity" type="number" inputmode="numeric" min="1" max="${max}" value="${qty}" aria-label="Quantity">
            <button type="button" data-step="1" aria-label="More">+</button>
          </div>
        </div>
        <p class="field-error hidden" data-error-for="quantity"></p>`}

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
        </div>
        <div>
          <label for="buy-email" class="field-label">Email</label>
          <input id="buy-email" name="email" type="email" class="field-input" autocomplete="email" inputmode="email" maxlength="255" required>
          <p class="field-error hidden" data-error-for="email"></p>
        </div>

        <fieldset>
          <legend class="field-label">Delivery</legend>
          <div class="choice-grid">
            <label class="choice-card"><input type="radio" name="delivery" value="collect" checked>
              <span class="choice-dot"></span><span><b>Collect from farm</b><small>${escapeHtml(listing.location || "")} Province</small></span></label>
            <label class="choice-card"><input type="radio" name="delivery" value="deliver">
              <span class="choice-dot"></span><span><b>Deliver to me</b><small>Cost confirmed with you</small></span></label>
          </div>
        </fieldset>
        <div data-address hidden>
          <label for="buy-address" class="field-label">Delivery address</label>
          <textarea id="buy-address" name="delivery_address" rows="2" class="field-input" maxlength="300" placeholder="Farm or street, town"></textarea>
          <p class="field-error hidden" data-error-for="delivery_address"></p>
        </div>

        <fieldset>
          <legend class="field-label">Payment</legend>
          <div class="choice-grid">
            <label class="choice-card"><input type="radio" name="payment_method" value="mobile_money" checked>
              <span class="choice-dot"></span><span><b>Mobile money</b><small class="pay-names"><i class="pay-airtel">Airtel</i><i class="pay-mtn">MTN</i><i class="pay-zamtel">Zamtel</i></small></span></label>
            <label class="choice-card"><input type="radio" name="payment_method" value="bank_transfer">
              <span class="choice-dot"></span><span><b>Bank transfer</b><small>Details sent to you</small></span></label>
          </div>
        </fieldset>

        <div class="honeypot" aria-hidden="true">
          <label>Website <input type="text" name="website" tabindex="-1" autocomplete="off"></label>
        </div>

        <button id="buy-submit" type="submit" class="btn-buy btn-lg w-full"></button>
      </form>
    </div>`;

  document.body.appendChild(backdrop);
  document.body.classList.add("modal-open");

  const form = backdrop.querySelector("#buy-form");
  const submit = backdrop.querySelector("#buy-submit");
  const qtyInput = form.elements.quantity;

  function refresh() {
    backdrop.querySelector("[data-total]").textContent = kwacha(total());
    backdrop.querySelector("[data-unit-line]").textContent = lot
      ? `The whole lot, ${unitWord(max)}`
      : `${qty} × ${kwacha(price)}`;
    submit.textContent = `Place order · ${kwacha(total())}`;
    if (qtyInput) {
      backdrop.querySelector('[data-step="-1"]').disabled = qty <= 1;
      backdrop.querySelector('[data-step="1"]').disabled = qty >= max;
    }
  }
  if (qtyInput) {
    backdrop.querySelectorAll("[data-step]").forEach((b) => b.addEventListener("click", () => {
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
  const addressBox = backdrop.querySelector("[data-address]");
  form.querySelectorAll('input[name="delivery"]').forEach((r) => r.addEventListener("change", () => {
    addressBox.hidden = form.elements.delivery.value !== "deliver";
    if (!addressBox.hidden) form.elements.delivery_address.focus();
  }));
  refresh();

  const close = () => {
    closeBuyModal();
    if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
  };
  backdrop.addEventListener("click", (event) => { if (event.target === backdrop) close(); });
  backdrop.querySelector("[data-close]").addEventListener("click", close);
  backdrop._onKey = (event) => { if (event.key === "Escape") close(); };
  document.addEventListener("keydown", backdrop._onKey);

  function readValues() {
    return {
      full_name: form.elements.full_name.value.trim(),
      phone: form.elements.phone.value.trim(),
      email: form.elements.email.value.trim(),
      delivery: form.elements.delivery.value,
      delivery_address: form.elements.delivery_address.value.trim(),
      payment_method: form.elements.payment_method.value,
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
    const alertBox = backdrop.querySelector("#buy-alert");
    alertBox.classList.add("hidden");
    const values = readValues();
    const errors = validateOrder(values, values.delivery === "deliver");
    showErrors(errors);
    if (Object.keys(errors).length) return;

    submit.disabled = true;
    submit.innerHTML = `<span class="btn-spinner"></span> Placing order…`;
    try {
      const res = await apiRequest("/api/orders", {
        method: "POST",
        body: { ...values, quantity: qty, livestock_id: listing.id, website: form.elements.website.value },
      });
      showSuccess(res.data);
    } catch (error) {
      if (error.errors) showErrors(error.errors);
      alertBox.textContent = error.message || "Your order could not be placed. Please try again.";
      alertBox.classList.remove("hidden");
      submit.disabled = false;
      refresh();
    }
  });

  function showSuccess(order) {
    const deliveryText = form.elements.delivery.value === "deliver" ? "Delivery" : "Collect from farm";
    backdrop.querySelector(".modal-panel").innerHTML = `
      <div class="p-6 sm:p-7" role="status">
        <div class="order-done-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg></div>
        <h2 class="text-xl font-bold text-gray-900 mt-4">Order ${escapeHtml(order.reference)} received</h2>
        <p class="text-sm text-gray-600 mt-1.5">We'll confirm availability with the seller and send payment details to your WhatsApp and email.</p>
        <ol class="order-steps" aria-label="Order progress">
          <li class="done">Received</li><li>Confirmed</li><li>Paid</li><li>Completed</li>
        </ol>
        <div class="order-summary">
          <div class="order-thumb">${thumb ? `<img src="${escapeHtml(thumb)}" alt="">` : livestockFallbackMedia("w-8 h-8")}</div>
          <div class="min-w-0 flex-1">
            <p class="text-sm font-semibold text-gray-900 line-clamp-2">${escapeHtml(listing.title)}</p>
            <p class="text-xs text-gray-500 mt-0.5">${escapeHtml(lot ? "The whole lot" : unitWord(order.quantity))} · ${deliveryText}</p>
          </div>
          <p class="order-total">${kwacha(order.total)}</p>
        </div>
        <button type="button" data-close class="btn-contact btn-inquire btn-lg w-full mt-5">Done</button>
      </div>`;
    const done = backdrop.querySelector("[data-close]");
    done.addEventListener("click", close);
    done.focus();
  }

  setTimeout(() => form.elements.full_name.focus(), 50);
}

function closeBuyModal() {
  const existing = document.getElementById("buy-modal");
  if (!existing) return;
  document.removeEventListener("keydown", existing._onKey);
  existing.remove();
  document.body.classList.remove("modal-open");
}
