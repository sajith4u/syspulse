
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs/promises");
const { execFile } = require("child_process");
const si = require("systeminformation");

let mainWindow;
let monitoringInterval;

// Sum processes sharing a name (e.g. many chrome processes) into one app row.
function groupByApp(list) {
  const apps = new Map();

  for (const p of list) {
    const app = apps.get(p.name) || { name: p.name, count: 0, cpu: 0, memPercent: 0, memBytes: 0, processes: [] };
    const memBytes = p.memRss * 1024; // memRss is in KB
    app.count += 1;
    app.cpu += p.cpu;
    app.memPercent += p.mem;
    app.memBytes += memBytes;
    app.processes.push({
      pid: p.pid,
      user: p.user,
      state: p.state,
      started: p.started,
      cpu: p.cpu,
      memPercent: p.mem,
      memBytes,
      command: [p.path ? `${p.path}/${p.command}` : p.command, p.params].filter(Boolean).join(" ")
    });
    apps.set(p.name, app);
  }

  return [...apps.values()];
}

ipcMain.handle("kill-process", (_event, pid) => {
  // Renderer input is untrusted: only real PIDs, never init (1) or ourselves.
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) {
    return { ok: false, error: `Refusing to kill PID ${pid}` };
  }

  try {
    process.kill(pid, "SIGTERM");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.code === "EPERM" ? "Permission denied (process owned by another user)" : error.message };
  }
});

// ---------- Storage browser ----------

let runningDu = null;
const duCache = new Map(); // dir -> { at, sizes }
const DU_CACHE_MS = 5 * 60 * 1000; // shortcut: stale for up to 5 min after files change; add a refresh button if that matters

// Size of each direct subfolder of `dir`, via `du`. Resolves null if superseded.
function folderSizes(dir) {
  const cached = duCache.get(dir);
  if (cached && Date.now() - cached.at < DU_CACHE_MS) return Promise.resolve(cached.sizes);

  runningDu?.kill(); // only one scan at a time; a newer click wins

  return new Promise(resolve => {
    // -x: stay on this filesystem, -b: bytes, -0: NUL-separated (safe for odd names)
    const child = execFile("du", ["-x", "-b", "-0", "-d", "1", "--", dir], { maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      if (runningDu === child) runningDu = null;
      if (error?.signal) return resolve(null);

      // du exits 1 when some subfolders are unreadable but still reports the rest.
      const sizes = new Map();
      for (const record of stdout.split("\0")) {
        const tab = record.indexOf("\t");
        if (tab > 0) sizes.set(record.slice(tab + 1), Number(record.slice(0, tab)));
      }
      duCache.set(dir, { at: Date.now(), sizes });
      resolve(sizes);
    });

    runningDu = child;
  });
}

const validDir = dir => typeof dir === "string" && path.isAbsolute(dir);

// Fast: folder contents with file sizes. Folder sizes come from "dir-sizes".
ipcMain.handle("list-dir", async (_event, requested) => {
  if (!validDir(requested)) return { ok: false, error: "Invalid path" };

  const dir = path.resolve(requested);

  try {
    const dirents = await fs.readdir(dir, { withFileTypes: true });

    const entries = await Promise.all(dirents.map(async d => {
      const full = path.join(dir, d.name);

      if (d.isDirectory()) {
        return { name: d.name, path: full, type: "dir", size: null };
      }

      try {
        const stat = await fs.lstat(full);
        return { name: d.name, path: full, type: d.isSymbolicLink() ? "link" : "file", size: stat.size, modified: stat.mtimeMs };
      } catch {
        return { name: d.name, path: full, type: "file", size: null };
      }
    }));

    return { ok: true, path: dir, entries };
  } catch (error) {
    return { ok: false, error: error.code === "EACCES" ? "Permission denied" : error.message };
  }
});

// Slow (runs du): { total, sizes: { [childPath]: bytes } }.
ipcMain.handle("dir-sizes", async (_event, requested) => {
  if (!validDir(requested)) return { ok: false, error: "Invalid path" };

  const dir = path.resolve(requested);
  const sizes = await folderSizes(dir);
  if (!sizes) return { ok: false, cancelled: true };

  return { ok: true, total: sizes.get(dir) ?? null, sizes: Object.fromEntries(sizes) };
});

app.on("will-quit", () => runningDu?.kill());

async function getSystemMetrics() {
  const [cpu, memory, osInfo, cpuInfo, processes] = await Promise.all([
    si.currentLoad(),
    si.mem(),
    si.osInfo(),
    si.cpu(),
    si.processes()
  ]);

  return {
    timestamp: Date.now(),

    apps: groupByApp(processes.list),

    processCounts: {
      all: processes.all,
      running: processes.running,
      sleeping: processes.sleeping,
      blocked: processes.blocked
    },

    disks,

    cpu: {
      usage: Number(cpu.currentLoad.toFixed(2)),
      perCore: cpu.cpus.map(c => c.load),
      loadAvg: cpu.avgLoad,
      cores: cpuInfo.cores,
      model: cpuInfo.brand
    },

    memory: {
      total: memory.total,
      // "active" excludes buffers/cache, which the kernel frees on demand.
      used: memory.active,
      buffcache: memory.buffcache,
      free: memory.free,
      swapTotal: memory.swaptotal,
      swapUsed: memory.swapused,
      usage: Number(
        ((memory.active / memory.total) * 100).toFixed(2)
      )
    },

    os: {
      hostname: osInfo.hostname,
      platform: osInfo.platform,
      distro: osInfo.distro,
      release: osInfo.release,
      uptime: si.time().uptime
    }
  };
}

// Disks change slowly and `df` can hang on a dead network mount,
// so poll them separately instead of blocking the 1s metrics loop.
let disks = [];

function refreshDisks() {
  si.fsSize()
    .then(list => {
      disks = list
        .filter(d => d.size > 0 && !d.fs.startsWith("/dev/loop")) // skip snap loop mounts
        .map(d => ({ mount: d.mount, fs: d.fs, size: d.size, used: d.used, usage: d.use }))
        .sort((a, b) => b.usage - a.usage);
    })
    .catch(error => console.error("Disk error:", error));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    icon: path.join(__dirname, "../assets/icon.png"),

    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(
    path.join(__dirname, "renderer/index.html")
  );

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function startMonitoring() {
  let collecting = false;

  monitoringInterval = setInterval(async () => {
    if (!mainWindow || mainWindow.isDestroyed() || collecting) {
      return;
    }

    collecting = true;

    try {
      const metrics = await getSystemMetrics();

      mainWindow.webContents.send(
        "system-metrics",
        metrics
      );
    } catch (error) {
      console.error("Monitoring error:", error);
    } finally {
      collecting = false;
    }
  }, 1000);
}

app.whenReady().then(() => {
  createWindow();
  refreshDisks();
  setInterval(refreshDisks, 10000);
  startMonitoring();
});

app.on("window-all-closed", () => {
  clearInterval(monitoringInterval);

  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (mainWindow === null) {
    createWindow();
  }
});
