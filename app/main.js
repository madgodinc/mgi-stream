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
server.on("unspoken", (u) => send("unspoken", u));

function createWindow() {
  win = new BrowserWindow({
    width: 1020,
    height: 760,
    minWidth: 880,
    minHeight: 620,
    backgroundColor: "#07060c",
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: "hidden",
    // Transparent, so the sky runs under the caption buttons instead of a black plate.
    titleBarOverlay: { color: "#00000000", symbolColor: "#a59fba", height: 64 },
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // MGI_DEMO=1 boots straight into the sample chat, which is how the screenshots
  // in the README are taken and a quick way to check audio after a change.
  // MGI_TAB=who|reading|obs opens on that tab, for the per-tab screenshots.
  const query = [process.env.MGI_DEMO && "demo", process.env.MGI_TAB && `tab=${process.env.MGI_TAB}`].filter(Boolean).join("&");
  win.loadFile(path.join(here, "ui", "index.html"), query ? { search: query } : {});
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
ipcMain.handle("config:save", (_e, cfg) => {
  const saved = config.save(configDir, cfg);
  // Settings are edited mid-stream, so a running session takes them as they land.
  server.update(saved);
  return saved;
});

ipcMain.handle("voices:list", async () => {
  try {
    // Our voices need an MGI key; without one they would only ever fall back.
    const keyed = Boolean(config.load(configDir).mgiKey);
    const voices = (await listVoices()).filter((v) => keyed || !v.id.startsWith("mgi:"));
    return { ok: true, voices };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("tts:preview", async (_e, cfg) => {
  try {
    // With the nickname on, the sample carries one, so its speed and pause can be heard too.
    const body = "Проверка голоса. Chat, one two three.";
    const lead = cfg.sayNickname ? (cfg.nicknameTemplate || "{nick}").replace("{nick}", "Катя").trim() : "";
    const mp3 = await new Speaker(cfg).synth(lead ? { lead, body } : body);
    return { ok: true, audio: mp3.toString("base64") };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("run:start", async (_e, { cfg, mock }) => {
  const saved = config.save(configDir, cfg);
  if (!mock && !saved.username.trim()) return { ok: false, code: "noUsername" };
  try {
    await server.start(saved, { mock });
    return { ok: true, url: server.overlayUrl, username: saved.username };
  } catch (err) {
    await server.stop();
    // The status event already carried a translatable code for this failure.
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
