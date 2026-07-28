const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mgi", {
  getConfig: () => ipcRenderer.invoke("config:get"),
  saveConfig: (cfg) => ipcRenderer.invoke("config:save", cfg),
  voices: () => ipcRenderer.invoke("voices:list"),
  preview: (cfg) => ipcRenderer.invoke("tts:preview", cfg),
  start: (cfg, mock) => ipcRenderer.invoke("run:start", { cfg, mock }),
  stop: () => ipcRenderer.invoke("run:stop"),
  copyUrl: () => ipcRenderer.invoke("overlay:copy"),
  openUrl: () => ipcRenderer.invoke("overlay:open"),
  on: (channel, fn) => ipcRenderer.on(channel, (_e, payload) => fn(payload)),
});
