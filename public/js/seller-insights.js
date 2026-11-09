// Seller dashboard charts (Chart.js, self-hosted in /vendor), in the same
// style as the admin dashboard. Data: GET /api/seller/insights?range=7d|30d|90d
(function () {
  const C = {
    leaf: "#166534", green: "#4d7c0f", lime: "#a3e635", amber: "#f59e0b", gold: "#facc15",
    violet: "#8b5cf6", red: "#ef4444", teal: "#14b8a6", slate: "#94a3b8", grid: "#eef1ee", ink: "#374151", muted: "#6b7280",
  };
  const PALETTE = [C.leaf, C.gold, C.teal, C.violet, C.amber, C.green, C.red, C.slate];

  const money = (n) => `K ${Math.round(Number(n) || 0).toLocaleString("en-US")}`;
  const compactMoney = (n) => {
    const v = Number(n) || 0;
    if (v >= 1e6) return `K ${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M`;
    if (v >= 1e3) return `K ${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)}k`;
    return `K ${Math.round(v)}`;
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
    if (note) { note.textContent = text; note.hidden = !show; }
    holder.querySelector("canvas").style.visibility = show ? "hidden" : "visible";
  }

  const axis = (extra = {}) => ({ grid: { color: C.grid, drawTicks: false }, border: { display: false }, ticks: { padding: 6 }, ...extra });
  const noGrid = (extra = {}) => ({ grid: { display: false }, border: { display: false }, ticks: { padding: 4, autoSkip: true, maxRotation: 0 }, ...extra });

  // Four cards: sales and orders for the chosen period, and the listings and
  // messages as they stand now.
  let last = null;
  function renderKpis(d = last) {
    if (!d) return;
    last = d;
    const k = d.kpis;
    const now = typeof sellerSummary !== "undefined" && sellerSummary ? sellerSummary : null;
    const kpis = [
      { label: "Sales", value: k.sales >= 1e6 ? compactMoney(k.sales) : money(k.sales), title: money(k.sales), hint: k.orders ? `Average ${money(k.avg_order)} per order` : "In this period", tab: "orders", tone: "forest" },
      { label: "Orders", value: k.orders.toLocaleString(), hint: k.open ? `${k.open} to hand over` : "In this period", tab: "orders", tone: "gold" },
      { label: "Live listings", value: now ? now.listings.live.toLocaleString() : "–", hint: now && now.listings.in_review ? `${now.listings.in_review} in review` : "On the website now", tab: "listings", tone: "night" },
      { label: "Unread messages", value: now ? now.messages.unread.toLocaleString() : "–", hint: now ? `${now.messages.total} in total` : "", tab: "messages", tone: "teal" },
    ];
    document.getElementById("sins-kpis").innerHTML = kpis.map((x) => `<a href="/seller/?tab=${x.tab}" data-tab-link="${x.tab}" class="ins-kpi ins-kpi-link kpi-${x.tone}">
        <p class="ins-kpi-label">${x.label}</p>
        <p class="ins-kpi-value" title="${x.title || x.value}">${x.value}</p>
        <p class="ins-kpi-foot"><span class="ins-kpi-hint">${x.hint}</span></p>
      </a>`).join("");
  }
  window.renderSellerKpis = () => renderKpis();

  function pie(id, rows, map, centerLabel, { format = (v) => String(v), donut = true } = {}) {
    const data = rows.filter((r) => r.value > 0);
    const total = data.reduce((s, r) => s + r.value, 0);
    emptyNote(id, !total);
    const label = (r) => (map && map[r.label] ? map[r.label][0] : r.label);
    draw(id, {
      type: donut ? "doughnut" : "pie",
      data: {
        labels: data.map(label),
        datasets: [{ data: data.map((r) => r.value), backgroundColor: data.map((r, i) => (map && map[r.label] ? map[r.label][1] : PALETTE[i % PALETTE.length])), borderColor: "#fff", borderWidth: 2, hoverOffset: 4 }],
      },
      options: {
        cutout: donut ? "68%" : 0,
        plugins: {
          legend: { position: "bottom", labels: { padding: 12 } },
          tooltip: { callbacks: { label: (ctx) => ` ${ctx.label}: ${format(ctx.parsed)} (${Math.round((ctx.parsed / total) * 100)}%)` } },
        },
      },
      plugins: donut ? [{
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
      }] : [],
    });
  }

  function renderCharts(d) {
    // Sales over time: bars for sales, a line for the number of orders.
    const fmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
    const labels = d.sales.map((b) => (d.weekly ? `w/c ${fmt.format(new Date(b.date))}` : fmt.format(new Date(b.date))));
    emptyNote("sch-sales", !d.sales.some((b) => b.orders));
    draw("sch-sales", {
      type: "bar",
      data: {
        labels,
        datasets: [
          { type: "bar", label: "Sales", data: d.sales.map((b) => b.sales), backgroundColor: C.leaf, borderRadius: 4, maxBarThickness: 28, yAxisID: "y" },
          { type: "line", label: "Orders", data: d.sales.map((b) => b.orders), borderColor: C.gold, backgroundColor: C.gold, pointRadius: 2.5, tension: 0.3, yAxisID: "y1" },
        ],
      },
      options: {
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { position: "top", align: "end" },
          tooltip: { callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${ctx.dataset.yAxisID === "y" ? money(ctx.parsed.y) : ctx.parsed.y}` } },
        },
        scales: {
          x: noGrid({ ticks: { autoSkip: true, maxTicksLimit: 8, maxRotation: 0 } }),
          y: axis({ beginAtZero: true, ticks: { callback: (v) => compactMoney(v), padding: 6 } }),
          y1: { position: "right", beginAtZero: true, grid: { display: false }, border: { display: false }, ticks: { precision: 0 } },
        },
      },
    });

    pie("sch-kind", d.sales_by_kind, null, "", { format: money, donut: false });

    const top = d.top_listings;
    emptyNote("sch-top", !top.length);
    const short = (s) => (s.length > 22 ? `${s.slice(0, 21)}…` : s);
    draw("sch-top", {
      type: "bar",
      data: {
        labels: top.map((r) => short(r.title || "Listing")),
        datasets: [{ label: "Sales", data: top.map((r) => r.sales), backgroundColor: top.map((r, i) => PALETTE[i % PALETTE.length]), borderRadius: 4, maxBarThickness: 22 }],
      },
      options: {
        indexAxis: "y",
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { title: (items) => top[items[0].dataIndex].title, label: (ctx) => ` ${money(ctx.parsed.x)} from ${top[ctx.dataIndex].orders} order${top[ctx.dataIndex].orders === 1 ? "" : "s"}` } },
        },
        scales: { x: axis({ beginAtZero: true, ticks: { callback: (v) => compactMoney(v), padding: 4 } }), y: noGrid({ ticks: { autoSkip: false, color: C.ink } }) },
      },
    });
  }

  const PERIODS = { "7d": 7, "30d": 30, "90d": 90 };

  async function load(range) {
    const box = document.getElementById("seller-insights");
    box.classList.add("is-loading");
    try {
      const { data } = await sellerApi(`/api/seller/insights?range=${range}`);
      renderKpis(data);
      if (setDefaults()) renderCharts(data);
    } catch (error) {
      showNotification(error.message, "error");
    } finally {
      box.classList.remove("is-loading");
    }
  }

  let current = null;
  window.initSellerInsights = function () {
    const select = document.getElementById("sins-range");
    if (!current) {
      let range = "30d";
      try { range = localStorage.getItem("frontier.seller.insights") || "30d"; } catch {}
      if (!PERIODS[range]) range = "30d";
      select.value = range;
      select.addEventListener("change", () => {
        try { localStorage.setItem("frontier.seller.insights", select.value); } catch {}
        current = select.value;
        load(select.value);
      });
    }
    current = select.value;
    load(current);
  };
})();
