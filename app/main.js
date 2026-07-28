import { app, BrowserWindow, ipcMain, clipboard, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StreamServer } from "./core/server.js";
import { listVoices, Speaker } from "./core/tts.js";
import * as config from "./core/config.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const configDir = app.getPath("userData");
const server = new StreamServer(path.join(here, "overlay"));

let win = null;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

server.on("status", (s) => send("status", s));
server.on("message", (m) => send("message", m));
server.on("queue", (q) => send("queue", q));
server.on("speak", (s) => send("speak", s));

function createWindow() {
  win = new BrowserWindow({
    width: 1020,
    height: 760,
    minWidth: 880,
    minHeight: 620,
    backgroundColor: "#0b0a09",
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#0b0a09", symbolColor: "#8b8478", height: 38 },
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // MGI_DEMO=1 boots straight into the sample chat, which is how the screenshots
  // in the README are taken and a quick way to check audio after a change.
  win.loadFile(path.join(here, "ui", "index.html"), process.env.MGI_DEMO ? { search: "demo" } : {});
  win.once("ready-to-show", () => win.show());

  // Links in the UI belong in the user's browser, not in a second app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

app.whenReady().then(createWindow);

app.on("window-all-closed", async () => {
  await server.stop();
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ── bridge ────────────────────────────────────────────────────────────────────

ipcMain.handle("config:get", () => config.load(configDir));
ipcMain.handle("config:save", (_e, cfg) => config.save(configDir, cfg));

ipcMain.handle("voices:list", async () => {
  try {
    return { ok: true, voices: await listVoices() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("tts:preview", async (_e, cfg) => {
  try {
    const mp3 = await new Speaker(cfg).synth("Проверка голоса. Chat, one two three.");
    return { ok: true, audio: mp3.toString("base64") };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("run:start", async (_e, { cfg, mock }) => {
  const saved = config.save(configDir, cfg);
  if (!mock && !saved.username.trim()) {
    return { ok: false, error: "Enter the TikTok username of the stream first." };
  }
  try {
    await server.start(saved, { mock });
    return { ok: true, url: server.overlayUrl };
  } catch (err) {
    await server.stop();
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("run:stop", async () => {
  await server.stop();
  return { ok: true };
});

ipcMain.handle("overlay:copy", () => {
  clipboard.writeText(server.overlayUrl);
  return server.overlayUrl;
});

ipcMain.handle("overlay:open", () => shell.openExternal(server.overlayUrl));
