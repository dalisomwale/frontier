// Admin dashboard insights: headline numbers and charts (Chart.js, self-hosted
// in /vendor). Data: GET /api/admin/dashboard/insights?range=7d|30d|90d|12m
(function () {
  const C = {
    leaf: "#166534",
    green: "#4d7c0f",
    lime: "#a3e635",
    amber: "#f59e0b",
    gold: "#facc15",
    violet: "#8b5cf6",
    red: "#ef4444",
    teal: "#14b8a6",
    slate: "#94a3b8",
    grid: "#eef1ee",
    ink: "#374151",
    muted: "#6b7280",
  };
  // Chart colours must tell categories apart, so they go beyond the brand greens.
  const PALETTE = [C.leaf, C.gold, C.teal, C.violet, C.amber, C.green, C.red, C.slate, "#d97706", "#0f1f12"];
  const STATUS = {
    new: ["New", C.teal],
    confirmed: ["Awaiting payment", C.amber],
    paid: ["Paid", C.green],
    completed: ["Completed", C.leaf],
    cancelled: ["Cancelled", C.slate],
  };
  const PAY = {
    airtel: ["Airtel Money", "#dc2626"],
    mtn: ["MTN MoMo", "#eab308"],
    zamtel: ["Zamtel Kwacha", "#16a34a"],
    card: ["Visa / Mastercard", C.violet],
    bank_transfer: ["Bank transfer", C.slate],
    mobile: ["Mobile money", C.teal],
  };

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
  function renderKpis(d) {
    const c = d.current;
    const kpis = [
      { label: "Sales (paid)", value: c.sales >= 1e6 ? compactMoney(c.sales) : money(c.sales), title: money(c.sales), hint: `${c.sold} paid order${c.sold === 1 ? "" : "s"}` },
      { label: "Orders", value: c.orders.toLocaleString(), hint: "All orders placed" },
      { label: "Inquiries", value: c.inquiries.toLocaleString(), hint: "Contact Seller messages" },
      { label: "Average order", value: c.avg_order >= 1e6 ? compactMoney(c.avg_order) : money(c.avg_order), title: money(c.avg_order), hint: "Paid orders only" },
    ];
    document.getElementById("ins-kpis").innerHTML = kpis.map((k) => {
      return `<div class="ins-kpi">
        <p class="ins-kpi-label">${k.label}</p>
        <p class="ins-kpi-value" title="${k.title || k.value}">${k.value}</p>
        <p class="ins-kpi-foot"><span class="ins-kpi-hint">${k.hint}</span></p>
      </div>`;
    }).join("");
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
    doughnut("ch-status", d.orders_by_status, STATUS, "orders");
    doughnut("ch-pay", d.payments, PAY, "orders");

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
          { label: "Inquiries", data: top.map((r) => r.inquiries), backgroundColor: C.gold, borderRadius: 3, maxBarThickness: 20 },
        ],
      },
      options: {
        indexAxis: "y",
        onClick: (e, els) => { if (els[0]) window.location.href = `/admin/livestock.html?edit=${top[els[0].index].id}`; },
        plugins: { legend: { position: "top", align: "end" }, tooltip: { callbacks: { title: (items) => top[items[0].dataIndex].title } } },
        scales: { x: axis({ stacked: true, beginAtZero: true, ticks: { precision: 0, padding: 4 } }), y: noGrid({ stacked: true, ticks: { autoSkip: false, color: C.ink } }) },
      },
    });

  }

  const PERIODS = { "7d": 7, "30d": 30, "90d": 90 };

  async function load(range) {
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
    if (!PERIODS[range]) range = "30d";
    const select = document.getElementById("ins-range");
    select.value = range;
    select.addEventListener("change", () => {
      try { localStorage.setItem("frontier.insights.range", select.value); } catch {}
      load(select.value);
    });
    load(range);
  };
})();
