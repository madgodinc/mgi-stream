// The effects layer (overlay/fx.html) hears its orders and reports finished media.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fx", {
  on: (fn) => ipcRenderer.on("fx", (_e, msg) => fn(msg)),
  done: (id) => ipcRenderer.send("fx:done", id),
});
