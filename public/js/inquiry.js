// Inquiry form (modal on desktop, bottom sheet on phones). Used by the
// listing cards and the details page. The listing is attached automatically -
// visitors only enter their name, phone, email and message.

const INQUIRY_LIMITS = { nameMin: 2, nameMax: 120, messageMin: 10, messageMax: 2000 };

function validateInquiry(values) {
  const errors = {};
  const digits = values.phone.replace(/\D/g, "");

  if (!values.full_name) errors.full_name = "Full name is required.";
  else if (values.full_name.length < INQUIRY_LIMITS.nameMin)
    errors.full_name = "Please enter your full name.";

  if (!values.phone) errors.phone = "Phone number is required.";
  else if (!/^\+?[\d\s\-()]{7,25}$/.test(values.phone) || digits.length < 7 || digits.length > 15)
    errors.phone = "Please enter a valid phone number, e.g. 0977 123 456 or +260 977 123 456.";

  if (!values.email) errors.email = "Email is required.";
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(values.email))
    errors.email = "Please enter a valid email address.";

  if (!values.message) errors.message = "Message is required.";
  else if (values.message.length < INQUIRY_LIMITS.messageMin)
    errors.message = `Please write at least ${INQUIRY_LIMITS.messageMin} characters.`;
  else if (values.message.length > INQUIRY_LIMITS.messageMax)
    errors.message = `Please keep your message under ${INQUIRY_LIMITS.messageMax} characters.`;

  return errors;
}

function openInquiryModal(listing) {
  closeInquiryModal();
  const lastFocus = document.activeElement;
  const thumb = listing.thumb_path || listing.images?.[0]?.thumb_path;
  const subtitle = [listing.category_name, listing.breed_name].filter(Boolean).join(" · ");

  const backdrop = document.createElement("div");
  backdrop.id = "inquiry-modal";
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal-panel" role="dialog" aria-modal="true" aria-labelledby="inquiry-title">
      <div class="flex items-start justify-between gap-3 p-5 pb-4 border-b border-gray-100">
        <div class="flex items-center gap-3 min-w-0">
          <div class="w-14 h-14 rounded-lg overflow-hidden bg-blue-50 flex-shrink-0">
            ${thumb ? `<img src="${escapeHtml(thumb)}" alt="" class="w-full h-full object-cover">` : livestockFallbackMedia("w-9 h-9")}
          </div>
          <div class="min-w-0">
            <p class="text-xs font-semibold uppercase tracking-wide text-blue-600">Inquiry About</p>
            <h2 id="inquiry-title" class="text-base sm:text-lg font-bold text-gray-900 leading-snug line-clamp-2">${escapeHtml(listing.title)}</h2>
            ${subtitle ? `<p class="text-xs text-gray-500 mt-0.5">${escapeHtml(subtitle)}</p>` : ""}
          </div>
        </div>
        <button type="button" data-close class="w-9 h-9 -mr-1 rounded-full flex items-center justify-center text-gray-500 hover:bg-gray-100 flex-shrink-0" aria-label="Close">
          <span class="w-5 h-5">${uiIcon("close")}</span>
        </button>
      </div>

      <form id="inquiry-form" class="p-5 space-y-4" novalidate>
        <div id="inquiry-alert" class="hidden alert alert-error text-sm mb-0" role="alert"></div>

        <div>
          <label for="inq-name" class="field-label">Full Name</label>
          <input id="inq-name" name="full_name" type="text" class="field-input" autocomplete="name"
            maxlength="${INQUIRY_LIMITS.nameMax}" required placeholder="e.g. Chanda Mulenga">
          <p class="field-error hidden" data-error-for="full_name"></p>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label for="inq-phone" class="field-label">Phone Number</label>
            <input id="inq-phone" name="phone" type="tel" class="field-input" autocomplete="tel" inputmode="tel"
              maxlength="25" required placeholder="0977 123 456">
            <p class="field-error hidden" data-error-for="phone"></p>
          </div>
          <div>
            <label for="inq-email" class="field-label">Email</label>
            <input id="inq-email" name="email" type="email" class="field-input" autocomplete="email" inputmode="email"
              maxlength="255" required placeholder="you@example.com">
            <p class="field-error hidden" data-error-for="email"></p>
          </div>
        </div>

        <div>
          <div class="flex items-baseline justify-between">
            <label for="inq-message" class="field-label">Message</label>
            <span id="inq-count" class="text-xs text-gray-400">0 / ${INQUIRY_LIMITS.messageMax}</span>
          </div>
          <textarea id="inq-message" name="message" rows="4" class="field-input resize-y" required
            maxlength="${INQUIRY_LIMITS.messageMax}"
            placeholder="Tell us what you're looking for - quantity, timing, questions about the animals…"></textarea>
          <p class="field-error hidden" data-error-for="message"></p>
        </div>

        <div class="honeypot" aria-hidden="true">
          <label>Website <input type="text" name="website" tabindex="-1" autocomplete="off"></label>
        </div>

        <button id="inquiry-submit" type="submit"
          class="w-full inline-flex items-center justify-center gap-2 bg-blue-600 text-white px-5 py-3 rounded-lg hover:bg-blue-700 font-semibold transition disabled:opacity-70 disabled:cursor-wait">
          Send Inquiry
        </button>
        <p class="text-xs text-gray-500 text-center">
          Your details go only to the Frontier Marketplace team, who will contact you about this listing.
        </p>
      </form>
    </div>`;

  document.body.appendChild(backdrop);
  document.body.classList.add("modal-open");

  const form = backdrop.querySelector("#inquiry-form");
  const submit = backdrop.querySelector("#inquiry-submit");
  const message = backdrop.querySelector("#inq-message");
  const counter = backdrop.querySelector("#inq-count");

  const close = () => {
    closeInquiryModal();
    if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
  };
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) close();
  });
  backdrop.querySelector("[data-close]").addEventListener("click", close);
  backdrop._onKey = (event) => {
    if (event.key === "Escape") close();
  };
  document.addEventListener("keydown", backdrop._onKey);

  message.addEventListener("input", () => {
    counter.textContent = `${message.value.length} / ${INQUIRY_LIMITS.messageMax}`;
  });

  function showErrors(errors) {
    form.querySelectorAll("[data-error-for]").forEach((el) => {
      const field = el.dataset.errorFor;
      const input = form.elements[field];
      const msg = errors[field];
      el.textContent = msg || "";
      el.classList.toggle("hidden", !msg);
      input.classList.toggle("has-error", Boolean(msg));
      input.setAttribute("aria-invalid", msg ? "true" : "false");
    });
    const first = Object.keys(errors)[0];
    if (first) form.elements[first].focus();
  }

  // Clear a field's error as soon as the visitor fixes it.
  form.querySelectorAll(".field-input").forEach((input) => {
    input.addEventListener("input", () => {
      if (!input.classList.contains("has-error")) return;
      const values = readValues();
      const err = validateInquiry(values)[input.name];
      if (!err) {
        input.classList.remove("has-error");
        form.querySelector(`[data-error-for="${input.name}"]`).classList.add("hidden");
      }
    });
  });

  function readValues() {
    return {
      full_name: form.elements.full_name.value.trim(),
      phone: form.elements.phone.value.trim(),
      email: form.elements.email.value.trim(),
      message: form.elements.message.value.trim(),
    };
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const alertBox = backdrop.querySelector("#inquiry-alert");
    alertBox.classList.add("hidden");

    const values = readValues();
    const errors = validateInquiry(values);
    showErrors(errors);
    if (Object.keys(errors).length) return;

    submit.disabled = true;
    submit.innerHTML = `<span class="btn-spinner"></span> Sending…`;
    try {
      await apiRequest("/api/inquiries", {
        method: "POST",
        body: { ...values, livestock_id: listing.id, website: form.elements.website.value },
      });
      showSuccess();
    } catch (error) {
      if (error.errors) showErrors(error.errors);
      alertBox.textContent = error.message || "Your inquiry could not be sent. Please try again.";
      alertBox.classList.remove("hidden");
      submit.disabled = false;
      submit.textContent = "Send Inquiry";
    }
  });

  function showSuccess() {
    backdrop.querySelector(".modal-panel").innerHTML = `
      <div class="p-8 text-center" role="status">
        <div class="w-16 h-16 mx-auto mb-4 rounded-full bg-green-100 text-green-600 flex items-center justify-center">
          <span class="w-8 h-8">${uiIcon("check")}</span>
        </div>
        <h2 class="text-xl font-bold text-gray-900 mb-2">Your inquiry has been sent successfully.</h2>
        <p class="text-sm text-gray-600 mb-6">Thank you. The Frontier Marketplace team will contact you shortly about <strong>${escapeHtml(listing.title)}</strong>.</p>
        <button type="button" data-close class="w-full sm:w-auto bg-blue-600 text-white px-8 py-3 rounded-lg hover:bg-blue-700 font-semibold">Done</button>
      </div>`;
    const done = backdrop.querySelector("[data-close]");
    done.addEventListener("click", close);
    done.focus();
  }

  setTimeout(() => form.elements.full_name.focus(), 50);
}

function closeInquiryModal() {
  const existing = document.getElementById("inquiry-modal");
  if (!existing) return;
  document.removeEventListener("keydown", existing._onKey);
  existing.remove();
  document.body.classList.remove("modal-open");
}
