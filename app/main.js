import { app, BrowserWindow, ipcMain, clipboard, shell, safeStorage, Tray, Menu, nativeImage } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StreamServer } from "./core/server.js";
import { listVoices, Speaker, useSubscription, SUB_VOICES } from "./core/tts.js";
import * as config from "./core/config.js";
import { Account } from "./core/account.js";
import { Music } from "./core/music.js";
import { Updates } from "./core/updates.js";
import { ThemeSetting, settingsPath } from "./core/theme.js";
import updaterPkg from "electron-updater";

const here = path.dirname(fileURLToPath(import.meta.url));
const configDir = app.getPath("userData");

// The device token sits on disk under DPAPI for this Windows user.
const sealed = safeStorage.isEncryptionAvailable();
const account = new Account({
  dir: configDir,
  version: app.getVersion(),
  seal: (s) => (sealed ? safeStorage.encryptString(s).toString("base64") : "plain:" + s),
  unseal: (s) => (s.startsWith("plain:") ? s.slice(6) : safeStorage.decryptString(Buffer.from(s, "base64"))),
});
// Mad's voice comes with the subscription, no gateway key needed.
useSubscription(() => (account.status().ok ? account.token : null));
const music = new Music({ account, workDir: path.join(app.getPath("temp"), "mgi-stream-music") });
music.sweep();
const server = new StreamServer(path.join(here, "overlay"), { fontDir: path.join(here, "ui", "fonts"), music });
// Shared with every MGI program; a dev run keeps to MGI-dev, as theirs do.
// MGI_THEME forces one for the offscreen screenshots.
const themes = new ThemeSetting(settingsPath(!app.isPackaged));
if (process.env.MGI_THEME) themes.current = process.env.MGI_THEME;
// The window's caption buttons follow the theme: dark glyphs on silence paper.
const CAPTION = { silence: "#111111", night: "#8d8d8d", fog: "#8a91a1", amber: "#948a7b" };
function caption(theme) {
  try {
    win?.setTitleBarOverlay({ color: "#00000000", symbolColor: CAPTION[theme] ?? "#a59fba", height: 64 });
  } catch {}
}
themes.on("change", (id) => {
  send("theme", id);
  caption(id);
});

// A dev run has no release to compare against, so it never checks.
const updates = new Updates({ updater: app.isPackaged ? updaterPkg.autoUpdater : null, version: app.getVersion(), dir: configDir });

let win = null;
let tray = null;
// Set once the streamer chose "quit": until then closing the window only hides it.
let quitting = false;
let hintShown = false;
let air = "off";

// One copy at a time: a second launch brings the running one back from the tray.
// An offscreen screenshot run (MGI_SHOT) is not a launch and may run beside it.
if (!process.env.MGI_SHOT && !app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => showWindow());

function showWindow() {
  if (!win || win.isDestroyed()) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

server.on("status", (s) => {
  air = s.state;
  send("status", s);
  updateTray();
});
server.on("message", (m) => send("message", m));
server.on("queue", (q) => send("queue", q));
server.on("speak", (s) => send("speak", s));
server.on("unspoken", (u) => send("unspoken", u));

account.on("change", (s) => send("account", s));
music.on("change", (s) => send("music:state", s));
music.on("request", (r) => send("music:request", r));
music.on("play", ({ track }) => send("music:play", { track, url: server.mediaUrl(track.uid) }));
music.on("stop", () => send("music:stop"));
updates.on("change", (i) => send("update", i));

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 880,
    minHeight: 620,
    backgroundColor: "#07060c",
    icon: path.join(here, "icon.png"),
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: "hidden",
    // Transparent, so the sky runs under the caption buttons instead of a black plate.
    titleBarOverlay: { color: "#00000000", symbolColor: "#a59fba", height: 64 },
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // The window plays the music; a minimized window must not slow it down.
      backgroundThrottling: false,
    },
  });

  // MGI_DEMO=1 boots straight into the sample chat, which is how the screenshots
  // in the README are taken and a quick way to check audio after a change.
  // MGI_TAB=who|reading|obs opens on that tab, for the per-tab screenshots.
  const query = [process.env.MGI_DEMO && "demo", process.env.MGI_TAB && `tab=${process.env.MGI_TAB}`].filter(Boolean).join("&");
  win.loadFile(path.join(here, "ui", "index.html"), query ? { search: query } : {});
  caption(themes.get());
  win.once("ready-to-show", () => {
    // MGI_SHOT=<file.png> renders the window to a file and quits, without
    // taking the screen or the focus from whatever the streamer is running.
    if (!process.env.MGI_SHOT) return win.show();
    // A hidden window does not run transitions: without this a theme's colours
    // would be caught halfway through flowing in.
    win.webContents.insertCSS("*, *::before, *::after { transition: none !important; }");
    setTimeout(async () => {
      const fs = await import("node:fs");
      fs.writeFileSync(process.env.MGI_SHOT, (await win.webContents.capturePage()).toPNG());
      app.quit();
    }, 2500);
  });

  // Closing hides to the tray, so the chat keeps being read and the music
  // keeps playing; "quit" in the tray menu really ends it.
  win.on("close", (e) => {
    if (quitting || !config.load(configDir).trayOnClose) return;
    e.preventDefault();
    win.hide();
    if (!hintShown && tray) {
      hintShown = true;
      tray.displayBalloon({ title: "mgi-stream", content: TRAY_TEXT[lang()].hint, iconType: "info" });
    }
  });

  // Links in the UI belong in the user's browser, not in a second app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

const TRAY_TEXT = {
  ru: { show: "Показать окно", skip: "Пропустить трек", quit: "Выйти", live: "в эфире", off: "не в эфире",
    hint: "Программа работает в трее: чат читается, музыка играет. Выйти можно через меню значка." },
  en: { show: "Show window", skip: "Skip track", quit: "Quit", live: "on air", off: "off air",
    hint: "Still running in the tray: chat is read, music plays. Quit from the icon's menu." },
};
const lang = () => (config.load(configDir).lang === "ru" ? "ru" : "en");

function updateTray() {
  if (!tray) return;
  const t = TRAY_TEXT[lang()];
  const playing = music.snapshot().current;
  tray.setToolTip(`mgi-stream · ${air === "live" ? t.live : t.off}${playing ? ` · ♪ ${playing.title}`.slice(0, 100) : ""}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: t.show, click: showWindow },
      { label: t.skip, enabled: Boolean(playing), click: () => music.skip() },
      { type: "separator" },
      {
        label: t.quit,
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

app.whenReady().then(() => {
  if (!process.env.MGI_THEME) themes.watch();
  account.start();
  updates.start();
  tray = new Tray(nativeImage.createFromPath(path.join(here, "tray.png")).resize({ width: 16, height: 16, quality: "best" }));
  tray.on("click", showWindow);
  music.on("change", updateTray);
  updateTray();
  createWindow();
});

app.on("before-quit", () => {
  quitting = true;
});

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
  updateTray();
  return saved;
});

ipcMain.handle("voices:list", async () => {
  try {
    // Our voices need an MGI key; without one they would only ever fall back.
    const keyed = Boolean(config.load(configDir).mgiKey);
    await account.ready;
    const subscribed = account.status().ok;
    const voices = (await listVoices()).filter((v) => keyed || !v.id.startsWith("mgi:") || (subscribed && SUB_VOICES[v.id]));
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
    return { ok: true, url: server.overlayUrl, musicUrl: server.musicUrl, username: saved.username };
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

// ── account ───────────────────────────────────────────────────────────────────

ipcMain.handle("account:get", async () => {
  await account.ready;
  return account.status();
});
ipcMain.handle("account:signIn", async () => {
  try {
    shell.openExternal(await account.signIn());
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle("account:cancel", () => account.cancelSignIn());
ipcMain.handle("account:signOut", () => account.signOut());
ipcMain.handle("account:refresh", () => account.refresh());
ipcMain.handle("account:cabinet", () => shell.openExternal("https://madgodinc.net/account/"));

// ── music ─────────────────────────────────────────────────────────────────────

ipcMain.handle("music:state", () => music.snapshot());
ipcMain.handle("music:control", (_e, { action, uid, index, what, paused }) => {
  if (action === "skip") music.skip();
  else if (action === "remove") music.remove(uid);
  else if (action === "approve") music.approve(uid);
  else if (action === "move") music.move(uid, index);
  else if (action === "pause") music.setPaused(Boolean(paused));
  else if (action === "ban") {
    // A ban is a setting: it outlives this stream.
    const lists = music.ban(uid, what);
    if (lists) {
      const cfg = config.load(configDir);
      const saved = config.save(configDir, { ...cfg, music: { ...cfg.music, ...lists } });
      server.update(saved);
      return saved;
    }
  }
  return null;
});
ipcMain.on("music:progress", (_e, { uid, position, paused }) => server.musicSync(uid, position, paused));
ipcMain.on("music:ended", (_e, { uid }) => music.finished(uid));
ipcMain.handle("theme:get", () => (process.env.MGI_THEME ? { theme: themes.get(), asked: !process.env.MGI_ASK } : themes.state()));
ipcMain.handle("theme:set", (_e, id) => {
  const t = process.env.MGI_THEME ? (themes.current = id) : themes.set(id);
  caption(t);
  return t;
});

ipcMain.handle("updates:state", () => ({ version: app.getVersion(), info: updates.info }));
ipcMain.handle("updates:check", () => updates.check());
ipcMain.handle("updates:install", () => updates.install());
ipcMain.handle("updates:skip", (_e, v) => updates.skip(v));
ipcMain.handle("updates:seen", () => updates.seen());
ipcMain.handle("updates:history", () => updates.history());

ipcMain.handle("music:copyUrl", () => {
  clipboard.writeText(server.musicUrl);
  return server.musicUrl;
});
