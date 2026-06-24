// Minimal, safe bridge: expose only window-control helpers to the loaded page.
// contextIsolation is on, so the page cannot reach Node or Electron internals.
const { contextBridge, ipcRenderer } = require("electron")

contextBridge.exposeInMainWorld("summer", {
  minimize: () => ipcRenderer.send("summer:minimize"),
  hide: () => ipcRenderer.send("summer:hide"),
})
