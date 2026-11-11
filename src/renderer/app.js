const MAX_POINTS = 60;
const MAX_TABLE_ROWS = 50;
const TOP_LIST = 8;

const css = getComputedStyle(document.documentElement);
const token = name => css.getPropertyValue(name).trim();

const COLORS = {
  cpu: token("--series-cpu"),
  mem: token("--series-mem"),
  track: token("--track"),
  grid: token("--grid"),
  muted: token("--muted"),
  surface: token("--surface"),
  good: token("--good"),
  warning: token("--warning"),
  critical: token("--critical")
};

// Sequential blue ramp, light -> dark, for per-core load.
const CORE_RAMP = ["#e6f0fc", "#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95"];

const $ = id => document.getElementById(id);

// ---------- Formatting ----------

function fmtBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

const fmtTime = ts => new Date(ts).toLocaleTimeString();

function fmtUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d ? `${d}d ${h}h` : `${h}h ${m}m`;
}

// Status is shown as colour + text label, never colour alone.
function levelOf(pct) {
  if (pct >= 85) return { label: "Critical", color: COLORS.critical };
  if (pct >= 60) return { label: "High", color: COLORS.warning };
  return { label: "Normal", color: COLORS.good };
}

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

// ---------- Charts ----------

Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
Chart.defaults.color = COLORS.muted;
Chart.defaults.animation = false;

function gauge(canvas) {
  return new Chart(canvas, {
    type: "doughnut",
    data: { datasets: [{ data: [0, 100], backgroundColor: [COLORS.good, COLORS.track], borderWidth: 0 }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      rotation: -135,
      circumference: 270,
      cutout: "80%",
      plugins: { legend: { display: false }, tooltip: { enabled: false } }
    }
  });
}

function setGauge(chart, pct, valueEl, badgeEl) {
  const s = levelOf(pct);
  chart.data.datasets[0].data = [pct, 100 - pct];
  chart.data.datasets[0].backgroundColor = [s.color, COLORS.track];
  chart.update("none");
  valueEl.textContent = `${pct.toFixed(1)}%`;
  badgeEl.textContent = s.label;
  badgeEl.style.setProperty("--status-color", s.color);
}

function lineChart(canvas, datasets, { yMax, yTick, legend }) {
  return new Chart(canvas, {
    type: "line",
    data: {
      labels: [],
      datasets: datasets.map(d => ({
        ...d,
        data: [],
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHitRadius: 10,
        tension: 0.3,
        fill: false
      }))
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        y: {
          min: 0,
          max: yMax,
          beginAtZero: true,
          border: { display: false },
          grid: { color: COLORS.grid },
          ticks: { callback: yTick, maxTicksLimit: 5 }
        },
        x: {
          border: { display: false },
          grid: { display: false },
          ticks: { maxTicksLimit: 6, maxRotation: 0 }
        }
      },
      plugins: {
        legend: legend
          ? { position: "top", align: "end", labels: { boxWidth: 10, boxHeight: 10, useBorderRadius: true, borderRadius: 3 } }
          : { display: false },
        tooltip: {
          callbacks: { label: ctx => ` ${ctx.dataset.label}: ${yTick(ctx.parsed.y)}` }
        }
      }
    }
  });
}

function pushPoint(chart, label, values) {
  chart.data.labels.push(label);
  values.forEach((v, i) => chart.data.datasets[i].data.push(v));

  if (chart.data.labels.length > MAX_POINTS) {
    chart.data.labels.shift();
    chart.data.datasets.forEach(d => d.data.shift());
  }

  chart.update("none");
}

const pctTick = v => `${+Number(v).toFixed(1)}%`;
const mbTick = v => `${Number(v).toFixed(0)} MB`;

const cpuGauge = gauge($("cpuGauge"));
const memGauge = gauge($("memGauge"));

const historyChart = lineChart(
  $("performanceChart"),
  [
    { label: "CPU", borderColor: COLORS.cpu, backgroundColor: COLORS.cpu },
    { label: "Memory", borderColor: COLORS.mem, backgroundColor: COLORS.mem }
  ],
  { yMax: 100, yTick: pctTick, legend: true }
);

const MEM_PARTS = [
  { key: "used", label: "Used by apps", color: COLORS.cpu },
  { key: "buffcache", label: "Buffers / cache", color: COLORS.mem },
  { key: "free", label: "Free", color: "#c9cdd3" }
];

const memDonut = new Chart($("memDonut"), {
  type: "doughnut",
  data: {
    labels: MEM_PARTS.map(p => p.label),
    datasets: [{
      data: [0, 0, 0],
      backgroundColor: MEM_PARTS.map(p => p.color),
      borderColor: COLORS.surface,
      borderWidth: 2
    }]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    cutout: "65%",
    plugins: {
      legend: { display: false },
      tooltip: { callbacks: { label: ctx => ` ${ctx.label}: ${fmtBytes(ctx.parsed)}` } }
    }
  }
});

// Drawer charts: one measure each, so each keeps its own honest axis.
const appCpuChart = lineChart(
  $("appCpuChart"),
  [{ label: "CPU", borderColor: COLORS.cpu, backgroundColor: COLORS.cpu }],
  { yTick: pctTick }
);
const appMemChart = lineChart(
  $("appMemChart"),
  [{ label: "Memory", borderColor: COLORS.mem, backgroundColor: COLORS.mem }],
  { yTick: mbTick }
);

// ---------- State ----------

let latestApps = [];
let selectedName = null;
let appHistory = new Map(); // app name -> [{ time, cpu, memMB }]

function recordAppHistory(apps, time) {
  const next = new Map();

  for (const app of apps) {
    const points = appHistory.get(app.name) || [];
    points.push({ time, cpu: app.cpu, memMB: app.memBytes / 1024 ** 2 });
    if (points.length > MAX_POINTS) points.shift();
    next.set(app.name, points);
  }

  appHistory = next; // apps that exited drop out
}

// ---------- Widgets ----------

function renderHeader(metrics) {
  const { os } = metrics;
  $("hostInfo").textContent = `${os.hostname} · ${os.distro} ${os.release} · up ${fmtUptime(os.uptime)}`;
  $("lastUpdated").textContent = `Updated ${fmtTime(metrics.timestamp)}`;
}

function renderCpu(cpu) {
  setGauge(cpuGauge, cpu.usage, $("cpuUsage"), $("cpuStatus"));
  $("cpuCores").textContent = cpu.cores;
  $("loadAvg").textContent = cpu.loadAvg.toFixed(2);
  $("cpuModel").textContent = cpu.model;
  $("cpuModel").title = cpu.model;

  $("coreTiles").replaceChildren(...cpu.perCore.map((load, i) => {
    const step = Math.min(CORE_RAMP.length - 1, Math.floor((load / 100) * CORE_RAMP.length));
    const tile = el("div", { className: "core", title: `Core ${i}: ${load.toFixed(1)}%` }, [
      `C${i}`,
      el("strong", { textContent: `${load.toFixed(0)}%` })
    ]);
    tile.style.background = CORE_RAMP[step];
    tile.style.color = step >= 4 ? "#ffffff" : "#111827";
    return tile;
  }));
}

function renderMemory(memory) {
  setGauge(memGauge, memory.usage, $("memoryUsage"), $("memStatus"));
  $("memoryDetails").textContent = `${fmtBytes(memory.used)} / ${fmtBytes(memory.total)}`;
  $("swapDetails").textContent = memory.swapTotal
    ? `${fmtBytes(memory.swapUsed)} / ${fmtBytes(memory.swapTotal)}`
    : "None";

  memDonut.data.datasets[0].data = MEM_PARTS.map(p => memory[p.key]);
  memDonut.update("none");

  $("memLegend").replaceChildren(...MEM_PARTS.map(p => {
    const swatch = el("span", { className: "swatch" });
    swatch.style.background = p.color;
    return el("li", {}, [
      swatch,
      p.label,
      el("span", { className: "value", textContent: fmtBytes(memory[p.key]) })
    ]);
  }));
}

function renderProcessCounts(counts, apps) {
  $("procAll").textContent = counts.all;
  $("procRunning").textContent = counts.running;
  $("procSleeping").textContent = counts.sleeping;
  $("procBlocked").textContent = counts.blocked;
  $("appCount").textContent = `${apps.length} distinct applications`;
}

function appButton(name) {
  return el("button", { className: "link", textContent: name, onclick: () => openDetails(name) });
}

// items: [{ label: Node|string, sub?, fraction (0..1), color, value }]
function renderBarList(listEl, items, emptyText) {
  if (!items.length) {
    listEl.replaceChildren(el("li", { className: "muted", textContent: emptyText }));
    return;
  }

  listEl.replaceChildren(...items.map(item => {
    const fill = el("div", { className: "bar-fill" });
    fill.style.width = `${Math.max(0, Math.min(1, item.fraction)) * 100}%`;
    fill.style.background = item.color;

    const label = el("div", { className: "label" }, [item.label]);
    if (item.sub) label.append(el("span", { className: "sub", textContent: item.sub }));

    return el("li", { title: item.title || "" }, [
      label,
      el("div", { className: "bar-track" }, [fill]),
      el("span", { className: "value", textContent: item.value })
    ]);
  }));
}

function renderTopLists(apps) {
  const topCpu = [...apps].sort((a, b) => b.cpu - a.cpu).slice(0, TOP_LIST);
  const maxCpu = Math.max(...topCpu.map(a => a.cpu), 0.1);

  // Bars are scaled to the top app so small values stay comparable.
  renderBarList($("topCpu"), topCpu.map(a => ({
    label: appButton(a.name),
    fraction: a.cpu / maxCpu,
    color: COLORS.cpu,
    value: `${a.cpu.toFixed(1)}%`,
    title: `${a.name}: ${a.cpu.toFixed(2)}% CPU across ${a.count} process(es)`
  })), "No data");

  const topMem = [...apps].sort((a, b) => b.memBytes - a.memBytes).slice(0, TOP_LIST);
  const maxMem = Math.max(...topMem.map(a => a.memBytes), 1);

  renderBarList($("topMem"), topMem.map(a => ({
    label: appButton(a.name),
    fraction: a.memBytes / maxMem,
    color: COLORS.mem,
    value: fmtBytes(a.memBytes),
    title: `${a.name}: ${fmtBytes(a.memBytes)} (${a.memPercent.toFixed(1)}% of RAM)`
  })), "No data");
}

function renderDisks(disks) {
  // Disk bars are absolute (0-100%) and coloured by status: fullness is a state.
  renderBarList($("diskList"), disks.map(d => ({
    label: el("button", { className: "link", textContent: d.mount, onclick: () => openStorage(d.mount) }),
    sub: `${fmtBytes(d.used)} of ${fmtBytes(d.size)} · ${d.fs}`,
    fraction: d.usage / 100,
    color: levelOf(d.usage).color,
    value: `${d.usage.toFixed(0)}%`,
    title: `${d.mount}: ${d.usage.toFixed(1)}% used (${levelOf(d.usage).label})`
  })), "Loading disks…");
}

function renderAppsTable(apps) {
  const key = $("sortBy").value;
  const filter = $("appFilter").value.trim().toLowerCase();

  const rows = apps
    .filter(a => !filter || a.name.toLowerCase().includes(filter))
    .sort((a, b) => b[key] - a[key])
    .slice(0, MAX_TABLE_ROWS)
    .map(app => {
      const tr = el("tr", {}, [
        el("td", {}, [appButton(app.name)]),
        el("td", { textContent: app.count }),
        el("td", { textContent: app.cpu.toFixed(1) }),
        el("td", { textContent: fmtBytes(app.memBytes) }),
        el("td", { textContent: app.memPercent.toFixed(1) })
      ]);
      tr.classList.toggle("selected", app.name === selectedName);
      return tr;
    });

  $("appsBody").replaceChildren(...rows);
}

// ---------- Details drawer ----------

function openDetails(name) {
  selectedName = name;
  $("appDetails").hidden = false;
  $("backdrop").hidden = false;
  renderAppsTable(latestApps);
  renderDetails();
  $("closeDetails").focus();
}

function closeDetails() {
  selectedName = null;
  $("appDetails").hidden = true;
  $("backdrop").hidden = true;
  renderAppsTable(latestApps);
}

function renderDetails() {
  if (selectedName === null) return;

  const app = latestApps.find(a => a.name === selectedName);
  $("detailsTitle").textContent = selectedName;
  $("killAll").disabled = !app;

  if (!app) {
    $("dCount").textContent = "0";
    $("dCpu").textContent = $("dMem").textContent = $("dMemPct").textContent = "--";
    $("detailsBody").replaceChildren(el("tr", {}, [el("td", { colSpan: 6, className: "muted", textContent: "No longer running." })]));
    return;
  }

  $("dCount").textContent = app.count;
  $("dCpu").textContent = `${app.cpu.toFixed(1)}%`;
  $("dMem").textContent = fmtBytes(app.memBytes);
  $("dMemPct").textContent = `${app.memPercent.toFixed(1)}%`;

  const points = appHistory.get(app.name) || [];
  for (const [chart, field] of [[appCpuChart, "cpu"], [appMemChart, "memMB"]]) {
    chart.data.labels = points.map(p => fmtTime(p.time));
    chart.data.datasets[0].data = points.map(p => p[field]);
    chart.update("none");
  }

  const key = $("sortBy").value;
  const rows = [...app.processes]
    .sort((a, b) => b[key] - a[key])
    .flatMap(p => {
      const kill = el("button", {
        className: "danger",
        textContent: "Kill",
        onclick: () => killPids([p.pid], `${app.name} (PID ${p.pid})`)
      });

      return [
        el("tr", { className: "has-command" }, [
          el("td", { textContent: p.pid }),
          el("td", { textContent: p.user }),
          el("td", { textContent: p.state }),
          el("td", { textContent: p.cpu.toFixed(1) }),
          el("td", { textContent: fmtBytes(p.memBytes) }),
          el("td", {}, [kill])
        ]),
        el("tr", {}, [
          el("td", { colSpan: 6, className: "command", textContent: `${p.command}  ·  started ${p.started}` })
        ])
      ];
    });

  $("detailsBody").replaceChildren(...rows);
}

async function killPids(pids, label) {
  if (!confirm(`Kill ${label}?`)) return;

  const errors = [];
  for (const pid of pids) {
    const result = await window.systemMonitor.killProcess(pid);
    if (!result.ok) errors.push(`PID ${pid}: ${result.error}`);
  }

  if (errors.length) alert(errors.join("\n"));
}

// ---------- Storage browser drawer ----------

const MAX_FILE_ROWS = 300;
const KIND = {
  dir: { label: "Folder", color: COLORS.cpu },
  file: { label: "File", color: "#9ca3af" },
  link: { label: "Link", color: "#9ca3af" }
};

let storageMount = null;
let storageRequest = 0; // ignore results from folders the user already left

const joinPath = (base, name) => (base.endsWith("/") ? base + name : `${base}/${name}`);

function openStorage(mount) {
  storageMount = mount;
  $("storageDrawer").hidden = false;
  $("backdrop").hidden = false;
  loadDir(mount);
  $("closeStorage").focus();
}

function closeStorage() {
  storageMount = null;
  storageRequest++;
  $("storageDrawer").hidden = true;
  $("backdrop").hidden = true;
}

function renderCrumbs(dir) {
  // Breadcrumbs start at the mount point the user clicked.
  const parts = dir.slice(storageMount.length).split("/").filter(Boolean);
  const crumbs = [{ name: storageMount, path: storageMount }];
  for (const name of parts) crumbs.push({ name, path: joinPath(crumbs[crumbs.length - 1].path, name) });

  $("crumbs").replaceChildren(...crumbs.flatMap((c, i) => {
    const last = i === crumbs.length - 1;
    const btn = el("button", { className: last ? "link current" : "link", textContent: c.name });
    if (last) btn.setAttribute("aria-current", "page");
    else btn.onclick = () => loadDir(c.path);
    return i ? [el("span", { className: "sep", textContent: "/" }), btn] : [btn];
  }));
}

async function loadDir(dir) {
  const request = ++storageRequest;
  $("storageTitle").textContent = `Storage · ${storageMount}`;
  renderCrumbs(dir);
  $("storageSummary").textContent = "Loading…";
  $("storageList").replaceChildren();

  const listing = await window.systemMonitor.listDir(dir);
  if (request !== storageRequest) return;

  if (!listing.ok) {
    $("storageSummary").textContent = `Cannot open folder: ${listing.error}`;
    return;
  }

  // Show files right away; folder sizes fill in when du finishes.
  renderEntries(listing.entries, null);

  const result = await window.systemMonitor.dirSizes(dir);
  if (request !== storageRequest || result.cancelled) return;

  if (!result.ok) {
    $("storageSummary").textContent = `Could not measure folder sizes: ${result.error}`;
    return;
  }

  const entries = listing.entries.map(e => (e.type === "dir" ? { ...e, size: result.sizes[e.path] ?? null } : e));
  renderEntries(entries, result.total);
}

function renderEntries(entries, duTotal) {
  const scanning = duTotal === null;

  // Largest first, so big files and folders sit at the top. While scanning,
  // unsized folders go first so they don't jump far when sizes arrive.
  entries = [...entries].sort((a, b) => (b.size ?? Infinity) - (a.size ?? Infinity) || 0);

  const folders = entries.filter(e => e.type === "dir").length;
  const total = duTotal ?? entries.reduce((sum, e) => sum + (e.size || 0), 0);
  const hidden = entries.length - MAX_FILE_ROWS;

  $("storageSummary").textContent =
    (scanning ? "Measuring folder sizes… large folders can take a few minutes · " : `${fmtBytes(total)} · `) +
    `${folders} folders · ${entries.length - folders} files · largest first` +
    (hidden > 0 ? ` · showing top ${MAX_FILE_ROWS}` : "");

  const largest = Math.max(1, ...entries.map(e => e.size || 0));

  renderBarList($("storageList"), entries.slice(0, MAX_FILE_ROWS).map(e => {
    const kind = KIND[e.type];
    const swatch = el("span", { className: "kind" });
    swatch.style.background = kind.color;

    const name = e.type === "dir"
      ? el("button", { className: "link", textContent: `${e.name}/`, onclick: () => loadDir(e.path) })
      : e.name;

    const share = !scanning && total && e.size != null ? ` · ${((e.size / total) * 100).toFixed(1)}% of folder` : "";
    const modified = e.modified ? ` · modified ${new Date(e.modified).toLocaleDateString()}` : "";

    return {
      label: el("span", {}, [swatch, name]),
      sub: `${kind.label}${share}${modified}`,
      fraction: (e.size || 0) / largest,
      color: kind.color,
      value: e.size == null ? (scanning ? "…" : "—") : fmtBytes(e.size),
      title: e.path
    };
  }), "Empty folder");
}

$("closeStorage").addEventListener("click", closeStorage);

function closeDrawers() {
  if (selectedName !== null) closeDetails();
  if (storageMount !== null) closeStorage();
}

$("closeDetails").addEventListener("click", closeDetails);
$("backdrop").addEventListener("click", closeDrawers);
document.addEventListener("keydown", e => {
  if (e.key === "Escape") closeDrawers();
});

$("killAll").addEventListener("click", () => {
  const app = latestApps.find(a => a.name === selectedName);
  if (app) killPids(app.processes.map(p => p.pid), `all ${app.count} "${app.name}" process(es)`);
});

$("sortBy").addEventListener("change", () => {
  renderAppsTable(latestApps);
  renderDetails();
});
$("appFilter").addEventListener("input", () => renderAppsTable(latestApps));

// ---------- Main update ----------

function updateDashboard(metrics) {
  latestApps = metrics.apps;
  recordAppHistory(metrics.apps, metrics.timestamp);

  renderHeader(metrics);
  renderCpu(metrics.cpu);
  renderMemory(metrics.memory);
  renderProcessCounts(metrics.processCounts, metrics.apps);
  renderTopLists(metrics.apps);
  renderDisks(metrics.disks);
  renderAppsTable(metrics.apps);
  renderDetails();

  pushPoint(historyChart, fmtTime(metrics.timestamp), [metrics.cpu.usage, metrics.memory.usage]);
}

window.systemMonitor.onMetrics(updateDashboard);
