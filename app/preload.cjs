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
  account: {
    get: () => ipcRenderer.invoke("account:get"),
    signIn: () => ipcRenderer.invoke("account:signIn"),
    cancel: () => ipcRenderer.invoke("account:cancel"),
    signOut: () => ipcRenderer.invoke("account:signOut"),
    refresh: () => ipcRenderer.invoke("account:refresh"),
    cabinet: () => ipcRenderer.invoke("account:cabinet"),
  },
  theme: {
    get: () => ipcRenderer.invoke("theme:get"),
    set: (id) => ipcRenderer.invoke("theme:set", id),
  },
  updates: {
    state: () => ipcRenderer.invoke("updates:state"),
    check: () => ipcRenderer.invoke("updates:check"),
    install: () => ipcRenderer.invoke("updates:install"),
    skip: (v) => ipcRenderer.invoke("updates:skip", v),
    seen: () => ipcRenderer.invoke("updates:seen"),
    history: () => ipcRenderer.invoke("updates:history"),
  },
  music: {
    state: () => ipcRenderer.invoke("music:state"),
    control: (cmd) => ipcRenderer.invoke("music:control", cmd),
    progress: (p) => ipcRenderer.send("music:progress", p),
    ended: (uid) => ipcRenderer.send("music:ended", { uid }),
    copyUrl: () => ipcRenderer.invoke("music:copyUrl"),
  },
  on: (channel, fn) => ipcRenderer.on(channel, (_e, payload) => fn(payload)),
});
