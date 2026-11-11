# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm install` — install dependencies
- `npm start` — launch the Electron app (`electron .`)

- `npm run dist` — package an AppImage + .deb into `dist/` with electron-builder (config in `package.json` → `build`; `dist:appimage` / `dist:deb` for one target)

There is no build step for development, and no linter or test suite. Only `src/**`, `assets/icon.png` and runtime `dependencies` are packaged (the `build.files` list), so a new runtime file outside `src/` must be added there. `electron` must stay in `devDependencies`, or electron-builder refuses to build. The renderer loads Chart.js via a relative `node_modules` path, which works inside the asar too, so `chart.js` must stay a runtime dependency.

If launched from a VS Code terminal, `ELECTRON_RUN_AS_NODE=1` may be inherited and Electron runs as plain Node (`require("electron")` fails or `ipcMain` is undefined). Use `env -u ELECTRON_RUN_AS_NODE npm start`.

## Architecture

Electron desktop app that shows live CPU and memory usage. Plain JavaScript (CommonJS in main/preload, browser scripts in the renderer), no bundler or framework.

Data flow is one-way, main → renderer:

1. **`src/main.js` (main process)** polls `systeminformation` every 1s in `startMonitoring()`. `getSystemMetrics()` builds a `{ timestamp, cpu, memory, os }` object. A `collecting` flag skips a tick if the previous collection hasn't finished. The result is pushed over the `system-metrics` IPC channel.
2. **`src/preload.js`** uses `contextBridge` to expose `window.systemMonitor.onMetrics(callback)` (returns an unsubscribe function). This is the only bridge: `contextIsolation: true`, `nodeIntegration: false`, so the renderer cannot `require` Node modules.
3. **`src/renderer/app.js`** subscribes via `onMetrics` and `updateDashboard()` updates the DOM and a Chart.js line chart (a rolling window of `MAX_POINTS = 60` samples, updated with animation off).

Other pieces:

- Processes are grouped by name into "apps" in `groupByApp()` (main); each app carries its `processes` array so the renderer's details drawer needs no extra IPC.
- Disks (`si.fsSize`) are refreshed on a separate 10s timer into a module-level `disks` variable, so a hanging `df` can't stall the 1s loop.
- Storage browser (click a disk): `list-dir` returns a folder's entries fast (file sizes via `lstat`, folders unsized), then `dir-sizes` runs `du -x -b -0 -d 1` for folder sizes. Only one `du` runs at a time (a newer request kills the old one), results are cached 5 min, and the renderer drops stale responses via `storageRequest`.
- App icon: `assets/icon.svg` is the source; `assets/icon.png` (512px) is what `BrowserWindow` uses. Re-render the PNG from the SVG after editing it.
- The renderer→main calls are `kill-process`, `list-dir` and `dir-sizes`; `kill-process` (`ipcMain.handle`, exposed as `window.systemMonitor.killProcess`). The PID is validated in main; it sends SIGTERM.
- The renderer keeps per-app history (`appHistory`) for the drawer charts. Colours come from CSS custom properties in `style.css` read via `token()`; status colours (good/warning/critical) are reserved for thresholds, and series colours (`--series-cpu`, `--series-mem`) for identity.

Adding a new metric means touching all three: collect it in `getSystemMetrics()`, then render it in `updateDashboard()` (plus an element in `index.html`). The preload passes the whole payload through, so it only changes for new channels or renderer→main calls.

Chart.js is loaded in `src/renderer/index.html` by a relative `<script>` path into `node_modules/chart.js/dist/chart.umd.js` (global `Chart`), not through `require`/import.
