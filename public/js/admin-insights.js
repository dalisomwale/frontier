// Admin dashboard insights: headline numbers and charts (Chart.js, self-hosted
// in /vendor). Data: GET /api/admin/dashboard/insights?range=7d|30d|90d|12m
(function () {
  const C = {
    leaf: "#1f3d2b",
    green: "#4d7c0f",
    lime: "#a3e635",
    amber: "#f59e0b",
    sky: "#0ea5e9",
    violet: "#8b5cf6",
    red: "#ef4444",
    teal: "#14b8a6",
    slate: "#94a3b8",
    grid: "#eef1ee",
    ink: "#374151",
    muted: "#6b7280",
  };
  const PALETTE = [C.leaf, C.green, C.amber, C.sky, C.violet, C.teal, C.red, C.slate, "#d97706", "#0369a1"];
  const STATUS = {
    new: ["New", C.sky],
    confirmed: ["Awaiting payment", C.amber],
    paid: ["Paid", C.green],
    completed: ["Completed", C.leaf],
    cancelled: ["Cancelled", C.slate],
  };
  const INQUIRY = {
    new: ["Not replied", C.red],
    contacted: ["Replied", C.amber],
    in_progress: ["In progress", C.sky],
    resolved: ["Resolved", C.green],
  };
  const PAY = {
    airtel: ["Airtel Money", "#dc2626"],
    mtn: ["MTN MoMo", "#eab308"],
    zamtel: ["Zamtel Kwacha", "#16a34a"],
    card: ["Visa / Mastercard", "#1d4ed8"],
    bank_transfer: ["Bank transfer", C.slate],
    mobile: ["Mobile money", C.teal],
  };
  const SELLERS = {
    active: ["Active", C.green],
    pending: ["Waiting for approval", C.amber],
    paused: ["Paused", C.slate],
    rejected: ["Not approved", C.red],
  };
  const RANGE_TEXT = { "7d": "previous 7 days", "30d": "previous 30 days", "90d": "previous 90 days", "12m": "previous 12 months" };

  const money = (n) => `K ${Math.round(Number(n) || 0).toLocaleString("en-US")}`;
  const compactMoney = (n) => {
    const v = Number(n) || 0;
    if (v >= 1e6) return `K ${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M`;
    if (v >= 1e3) return `K ${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)}k`;
    return `K ${v}`;
  };
  const charts = {};

  function setDefaults() {
    if (!window.Chart) return false;
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
    Chart.defaults.font.size = 12;
    Chart.defaults.color = C.muted;
    Chart.defaults.plugins.legend.labels.boxWidth = 10;
    Chart.defaults.plugins.legend.labels.boxHeight = 10;
    Chart.defaults.plugins.legend.labels.usePointStyle = true;
    Chart.defaults.plugins.tooltip.backgroundColor = "#10231a";
    Chart.defaults.plugins.tooltip.padding = 10;
    Chart.defaults.plugins.tooltip.cornerRadius = 8;
    Chart.defaults.maintainAspectRatio = false;
    return true;
  }

  function draw(id, config) {
    const canvas = document.getElementById(id);
    if (!canvas) return;
    if (charts[id]) charts[id].destroy();
    charts[id] = new Chart(canvas, config);
  }

  function emptyNote(id, show, text = "Nothing to show for this period yet.") {
    const holder = document.getElementById(id)?.closest(".ins-chart");
    if (!holder) return;
    let note = holder.querySelector(".ins-empty");
    if (show && !note) {
      note = document.createElement("p");
      note.className = "ins-empty";
      holder.appendChild(note);
    }
    if (note) {
      note.textContent = text;
      note.hidden = !show;
    }
    holder.querySelector("canvas").style.visibility = show ? "hidden" : "visible";
  }

  // --- Headline numbers ------------------------------------------------------
  function change(now, before) {
    if (!before && !now) return { text: "No change", cls: "flat" };
    if (!before) return { text: "New this period", cls: "up" };
    const pct = Math.round(((now - before) / before) * 100);
    if (pct === 0) return { text: "No change", cls: "flat" };
    return { text: `${pct > 0 ? "▲" : "▼"} ${Math.abs(pct)}%`, cls: pct > 0 ? "up" : "down" };
  }

  function renderKpis(d) {
    const c = d.current;
    const p = d.previous;
    const conv = (x) => (x.inquiries ? Math.round((x.orders / x.inquiries) * 100) : 0);
    const kpis = [
      { label: "Sales (paid)", value: c.sales >= 1e6 ? compactMoney(c.sales) : money(c.sales), title: money(c.sales), now: c.sales, before: p.sales, hint: `${c.sold} paid order${c.sold === 1 ? "" : "s"}` },
      { label: "Orders", value: c.orders.toLocaleString(), now: c.orders, before: p.orders, hint: "All orders placed" },
      { label: "Inquiries", value: c.inquiries.toLocaleString(), now: c.inquiries, before: p.inquiries, hint: "Contact Seller messages" },
      { label: "Orders per 100 inquiries", value: String(conv(c)), now: conv(c), before: conv(p), hint: "How often interest turns into an order" },
      { label: "Average order", value: c.avg_order >= 1e6 ? compactMoney(c.avg_order) : money(c.avg_order), title: money(c.avg_order), now: c.avg_order, before: p.avg_order, hint: "Paid orders only" },
      { label: "New listings", value: c.new_listings.toLocaleString(), now: c.new_listings, before: p.new_listings, hint: `${c.new_sellers} new seller${c.new_sellers === 1 ? "" : "s"}` },
    ];
    document.getElementById("ins-kpis").innerHTML = kpis.map((k) => {
      const ch = change(k.now, k.before);
      return `<div class="ins-kpi">
        <p class="ins-kpi-label">${k.label}</p>
        <p class="ins-kpi-value" title="${k.title || k.value}">${k.value}</p>
        <p class="ins-kpi-foot"><span class="ins-change ${ch.cls}" title="Compared with the ${RANGE_TEXT[d.range]}">${ch.text}</span><span class="ins-kpi-hint">${k.hint}</span></p>
      </div>`;
    }).join("");
    document.getElementById("ins-compare").textContent = `Changes compare with the ${RANGE_TEXT[d.range]}.`;
  }

  // --- Charts -------------------------------------------------------------
  const axis = (extra = {}) => ({ grid: { color: C.grid, drawTicks: false }, border: { display: false }, ticks: { padding: 6 }, ...extra });
  const noGrid = (extra = {}) => ({ grid: { display: false }, border: { display: false }, ticks: { padding: 4, autoSkip: true, maxRotation: 0 }, ...extra });

  function doughnut(id, rows, map, centerLabel) {
    const data = rows.filter((r) => r.value > 0);
    const total = data.reduce((s, r) => s + r.value, 0);
    emptyNote(id, !total);
    const label = (r) => (map[r.label] ? map[r.label][0] : r.label);
    draw(id, {
      type: "doughnut",
      data: {
        labels: data.map(label),
        datasets: [{ data: data.map((r) => r.value), backgroundColor: data.map((r, i) => (map[r.label] ? map[r.label][1] : PALETTE[i % PALETTE.length])), borderColor: "#fff", borderWidth: 2, hoverOffset: 4 }],
      },
      options: {
        cutout: "68%",
        plugins: {
          legend: { position: "bottom", labels: { padding: 12 } },
          tooltip: { callbacks: { label: (ctx) => ` ${ctx.label}: ${ctx.parsed} (${Math.round((ctx.parsed / total) * 100)}%)` } },
        },
      },
      plugins: [{
        id: "center",
        afterDraw(chart) {
          if (!total) return;
          const { ctx, chartArea } = chart;
          const x = (chartArea.left + chartArea.right) / 2;
          const y = (chartArea.top + chartArea.bottom) / 2;
          ctx.save();
          ctx.textAlign = "center";
          ctx.fillStyle = "#111827";
          ctx.font = `700 22px ${Chart.defaults.font.family}`;
          ctx.fillText(String(total), x, y + 2);
          ctx.fillStyle = C.muted;
          ctx.font = `500 11px ${Chart.defaults.font.family}`;
          ctx.fillText(centerLabel, x, y + 18);
          ctx.restore();
        },
      }],
    });
  }

  function renderCharts(d) {
    const t = d.timeline;
    const unit = { day: "day", week: "week", month: "month" }[d.bucket];

    // Sales and orders over time
    emptyNote("ch-sales", !t.orders.some(Boolean));
    draw("ch-sales", {
      data: {
        labels: t.labels,
        datasets: [
          { type: "bar", label: "Sales (paid)", data: t.sales, backgroundColor: C.leaf, borderRadius: 4, maxBarThickness: 28, yAxisID: "y", order: 2 },
          { type: "line", label: "Orders", data: t.orders, borderColor: C.amber, backgroundColor: C.amber, tension: 0.35, cubicInterpolationMode: "monotone", pointRadius: t.labels.length > 20 ? 0 : 3, pointHoverRadius: 5, borderWidth: 2.5, yAxisID: "y1", order: 1 },
        ],
      },
      options: {
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { position: "top", align: "end" },
          tooltip: { callbacks: { label: (ctx) => (ctx.dataset.yAxisID === "y" ? ` Sales: ${money(ctx.parsed.y)}` : ` Orders: ${ctx.parsed.y}`) } },
        },
        scales: {
          x: noGrid(),
          y: axis({ beginAtZero: true, ticks: { callback: (v) => compactMoney(v), padding: 6 } }),
          y1: { position: "right", beginAtZero: true, grid: { display: false }, border: { display: false }, ticks: { precision: 0, padding: 6 } },
        },
      },
    });
    document.getElementById("ch-sales-sub").textContent = `Per ${unit}. Bars: paid sales in Kwacha. Line: orders placed.`;

    // Interest vs orders
    emptyNote("ch-demand", !t.inquiries.some(Boolean) && !t.orders.some(Boolean));
    draw("ch-demand", {
      type: "line",
      data: {
        labels: t.labels,
        datasets: [
          { label: "Inquiries", data: t.inquiries, borderColor: C.sky, backgroundColor: "rgba(14,165,233,0.12)", fill: true, tension: 0.35, cubicInterpolationMode: "monotone", pointRadius: 0, pointHoverRadius: 4, borderWidth: 2 },
          { label: "Orders", data: t.orders, borderColor: C.leaf, backgroundColor: C.leaf, tension: 0.35, cubicInterpolationMode: "monotone", pointRadius: 0, pointHoverRadius: 4, borderWidth: 2 },
        ],
      },
      options: {
        interaction: { mode: "index", intersect: false },
        plugins: { legend: { position: "top", align: "end" } },
        scales: { x: noGrid(), y: axis({ beginAtZero: true, ticks: { precision: 0, padding: 6 } }) },
      },
    });

    doughnut("ch-status", d.orders_by_status, STATUS, "orders");
    doughnut("ch-pay", d.payments, PAY, "orders");
    doughnut("ch-inquiry", d.inquiry_status, INQUIRY, "inquiries");

    // Live listings by type (feed types in a lighter green)
    const types = d.listings_by_type;
    emptyNote("ch-types", !types.length, "No live listings yet.");
    draw("ch-types", {
      type: "bar",
      data: {
        labels: types.map((r) => r.label),
        datasets: [{ label: "Live listings", data: types.map((r) => r.value), backgroundColor: types.map((r) => (r.kind === "feed" ? C.lime : C.leaf)), borderRadius: 4, maxBarThickness: 22 }],
      },
      options: { indexAxis: "y", plugins: { legend: { display: false } }, scales: { x: axis({ beginAtZero: true, ticks: { precision: 0, padding: 4 } }), y: noGrid({ ticks: { autoSkip: false, color: C.ink } }) } },
    });
    document.getElementById("ch-types-total").textContent = `${types.reduce((s, r) => s + r.value, 0)} live`;

    // Live listings by province
    const prov = d.listings_by_province;
    emptyNote("ch-province", !prov.length, "No live listings yet.");
    draw("ch-province", {
      type: "bar",
      data: { labels: prov.map((r) => r.label), datasets: [{ label: "Live listings", data: prov.map((r) => r.value), backgroundColor: C.green, borderRadius: 4, maxBarThickness: 22 }] },
      options: { indexAxis: "y", plugins: { legend: { display: false } }, scales: { x: axis({ beginAtZero: true, ticks: { precision: 0, padding: 4 } }), y: noGrid({ ticks: { autoSkip: false, color: C.ink } }) } },
    });

    // Most popular listings (inquiries + orders, stacked)
    const top = d.top_listings;
    emptyNote("ch-top", !top.length);
    const short = (s) => (s.length > 22 ? `${s.slice(0, 21)}…` : s);
    draw("ch-top", {
      type: "bar",
      data: {
        labels: top.map((r) => short(r.title)),
        datasets: [
          { label: "Orders", data: top.map((r) => r.orders), backgroundColor: C.leaf, borderRadius: 3, maxBarThickness: 20 },
          { label: "Inquiries", data: top.map((r) => r.inquiries), backgroundColor: C.sky, borderRadius: 3, maxBarThickness: 20 },
        ],
      },
      options: {
        indexAxis: "y",
        onClick: (e, els) => { if (els[0]) window.location.href = `/admin/livestock.html?edit=${top[els[0].index].id}`; },
        plugins: { legend: { position: "top", align: "end" }, tooltip: { callbacks: { title: (items) => top[items[0].dataIndex].title } } },
        scales: { x: axis({ stacked: true, beginAtZero: true, ticks: { precision: 0, padding: 4 } }), y: noGrid({ stacked: true, ticks: { autoSkip: false, color: C.ink } }) },
      },
    });

    // Sellers: status chips and the top sellers table
    document.getElementById("ins-seller-chips").innerHTML = d.seller_status
      .sort((a, b) => Object.keys(SELLERS).indexOf(a.label) - Object.keys(SELLERS).indexOf(b.label))
      .map((r) => `<span class="ins-chip"><i style="background:${(SELLERS[r.label] || [0, C.slate])[1]}"></i>${(SELLERS[r.label] || [r.label])[0]} <b>${r.value}</b></span>`)
      .join("");
    const ts = d.top_sellers;
    const maxSales = Math.max(1, ...ts.map((s) => s.sales));
    document.getElementById("ins-top-sellers").innerHTML = ts.length
      ? `<table class="ins-table"><thead><tr><th>Seller</th><th class="num">Live listings</th><th class="num">Orders</th><th>Sales (paid)</th></tr></thead><tbody>${ts.map((s) => `
          <tr><td><a href="/admin/sellers.html?id=${s.id}">${escapeHtml(s.name)}</a></td><td class="num">${s.live}</td><td class="num">${s.orders}</td>
          <td><div class="ins-bar-cell"><span class="ins-bar"><span style="width:${Math.round((s.sales / maxSales) * 100)}%"></span></span><span class="ins-bar-val">${money(s.sales)}</span></div></td></tr>`).join("")}</tbody></table>`
      : `<p class="ins-empty-inline">No seller orders in this period yet. Frontier's own stock isn't counted here.</p>`;
  }

  async function load(range) {
    document.querySelectorAll("#ins-range button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.range === range)));
    document.getElementById("insights").classList.add("is-loading");
    try {
      const { data } = await adminApi(`/api/admin/dashboard/insights?range=${range}`);
      renderKpis(data);
      if (setDefaults()) renderCharts(data);
    } catch (error) {
      showNotification(error.message, "error");
    } finally {
      document.getElementById("insights").classList.remove("is-loading");
    }
  }

  window.initInsights = function () {
    let range = "30d";
    try { range = localStorage.getItem("frontier.insights.range") || "30d"; } catch {}
    document.querySelectorAll("#ins-range button").forEach((b) => b.addEventListener("click", () => {
      try { localStorage.setItem("frontier.insights.range", b.dataset.range); } catch {}
      load(b.dataset.range);
    }));
    load(range);
  };
})();
