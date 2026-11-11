
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("systemMonitor", {
  killProcess: (pid) => ipcRenderer.invoke("kill-process", pid),
  listDir: (dir) => ipcRenderer.invoke("list-dir", dir),
  dirSizes: (dir) => ipcRenderer.invoke("dir-sizes", dir),

  onMetrics: (callback) => {
    const listener = (_event, data) => callback(data);

    ipcRenderer.on("system-metrics", listener);

    return () => {
      ipcRenderer.removeListener(
        "system-metrics",
        listener
      );
    };
  }
});
