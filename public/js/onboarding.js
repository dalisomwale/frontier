// Sign-up in steps, shared by the customer, seller and transport provider
// registration pages. Needs seller.js (showFieldErrors).
//
// Markup: a <form> holding
//   <div data-ob-progress></div>
//   <section class="ob-step" data-title="Your Details"> ...fields... </section>  (one per step)
//   <div class="ob-nav"><button data-ob-back>…</button><button data-ob-next>…</button><button type="submit" data-ob-submit>…</button></div>
//
//   const steps = obSteps(form, { check(i) { return { field: "message" } }, onStep(i) {} });
//   steps.showErrors(errors)  // after the server answers: opens the step with the first problem
const OB_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const obPhoneOk = (v) => String(v || "").replace(/\D/g, "").length >= 9;

function obSteps(form, { check = () => ({}), onStep = () => {} } = {}) {
  const steps = [...form.querySelectorAll(".ob-step")];
  const back = form.querySelector("[data-ob-back]");
  const next = form.querySelector("[data-ob-next]");
  const submit = form.querySelector("[data-ob-submit]");
  const progress = form.querySelector("[data-ob-progress]");
  let at = 0;
  let reached = 0;

  progress.innerHTML = `
    <ol class="ob-progress" aria-label="Sign-up steps">${steps.map((s, i) => `
      <li data-i="${i}"><button type="button" tabindex="-1"><span class="ob-dot">${i + 1}</span><span class="ob-name">${escapeHtml(s.dataset.title)}</span></button></li>`).join("")}
    </ol>
    <p class="ob-count" aria-live="polite"></p>`;
  const items = [...progress.querySelectorAll("li")];
  items.forEach((li, i) => li.querySelector("button").addEventListener("click", () => { if (i <= reached) show(i); }));

  function show(i, { focus = true } = {}) {
    at = Math.max(0, Math.min(steps.length - 1, i));
    reached = Math.max(reached, at);
    steps.forEach((s, n) => { s.hidden = n !== at; });
    items.forEach((li, n) => {
      li.className = n < at ? "is-done" : n === at ? "is-now" : "";
      li.querySelector(".ob-dot").innerHTML = n < at ? "✓" : String(n + 1);
      li.querySelector("button").tabIndex = n <= reached && n !== at ? 0 : -1;
      if (n === at) li.setAttribute("aria-current", "step");
      else li.removeAttribute("aria-current");
    });
    progress.querySelector(".ob-count").textContent = `Step ${at + 1} of ${steps.length} · ${steps[at].dataset.title}`;
    const last = at === steps.length - 1;
    back.hidden = at === 0;
    next.hidden = last;
    submit.hidden = !last;
    onStep(at);
    const top = form.getBoundingClientRect().top;
    if (top < 0) form.scrollIntoView({ behavior: "smooth", block: "start" });
    if (focus) {
      const first = steps[at].querySelector("input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file]), select, textarea");
      if (first && window.matchMedia("(min-width: 640px)").matches) setTimeout(() => first.focus({ preventScroll: true }), 50);
    }
  }

  // The fields of a step that has a problem.
  const stepOf = (name) => steps.findIndex((s) => s.querySelector(`[name="${name}"], [data-error-for="${name}"]`));

  function goNext() {
    const errors = check(at) || {};
    showFieldErrors(form, { errors });
    if (Object.keys(errors).length) {
      const first = steps[at].querySelector(".has-error") || steps[at].querySelector(".field-error:not(.hidden)");
      if (first) first.scrollIntoView({ behavior: "smooth", block: "center" });
      if (first && first.focus) first.focus({ preventScroll: true });
      return;
    }
    show(at + 1);
  }
  // An error goes away as soon as its field is changed.
  const clear = (name) => {
    const holder = form.querySelector(`[data-error-for="${name}"]`);
    if (holder) holder.classList.add("hidden");
    if (form.elements[name] && form.elements[name].classList) form.elements[name].classList.remove("has-error");
  };
  ["input", "change"].forEach((type) => form.addEventListener(type, (e) => { if (e.target.name) clear(e.target.name); }));
  next.addEventListener("click", goNext);
  back.addEventListener("click", () => { showFieldErrors(form, {}); show(at - 1); });
  // Enter (a phone keyboard's Go key) moves on instead of sending the form early.
  form.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.target.tagName !== "INPUT" || ["checkbox", "radio", "file"].includes(e.target.type)) return;
    if (at < steps.length - 1) { e.preventDefault(); goNext(); }
  });
  // Every step checked again before sending (in case one was skipped back to).
  form.addEventListener("submit", (e) => {
    for (let i = 0; i < steps.length; i++) {
      const errors = check(i) || {};
      if (Object.keys(errors).length) {
        e.preventDefault();
        e.stopImmediatePropagation();
        show(i);
        showFieldErrors(form, { errors });
        return;
      }
    }
  }, true);

  show(0, { focus: false });
  return {
    show,
    clear,
    current: () => at,
    // Server errors: show them and open the step with the first one.
    showErrors(errors = {}) {
      const names = Object.keys(errors);
      const idx = names.map(stepOf).filter((n) => n >= 0);
      if (idx.length) show(Math.min(...idx), { focus: false });
      showFieldErrors(form, { errors });
    },
  };
}
