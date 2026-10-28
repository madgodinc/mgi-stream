import { app, BrowserWindow, ipcMain, clipboard, shell, safeStorage, Tray, Menu, nativeImage, globalShortcut, dialog } from "electron";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { StreamServer } from "./core/server.js";
import { listVoices, Speaker, useSubscription, SUB_VOICES } from "./core/tts.js";
import * as config from "./core/config.js";
import { Account } from "./core/account.js";
import { Music } from "./core/music.js";
import { Wishlist } from "./core/wishlist.js";
import { Pet } from "./core/pet.js";
import { Banks } from "./core/banks.js";
import { Engine } from "./core/actions.js";
import { createInput } from "./core/input.js";
import { giftRulesFor } from "./core/rules.js";
import { accelerator } from "./core/keys.js";
import { FxLayer } from "./fx.js";
import { Updates } from "./core/updates.js";
import { ThemeSetting, settingsPath } from "./core/theme.js";
import updaterPkg from "electron-updater";

const here = path.dirname(fileURLToPath(import.meta.url));
// MGI_USERDATA points a screenshot or test run at its own settings, never the streamer's.
if (process.env.MGI_USERDATA) app.setPath("userData", process.env.MGI_USERDATA);
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
// The queue is kept on disk, so a restart in the middle of a stream picks it up.
const music = new Music({
  account,
  workDir: path.join(app.getPath("temp"), "mgi-stream-music"),
  stateFile: path.join(configDir, "music-queue.json"),
});
music.sweep();
const wishlist = new Wishlist(path.join(configDir, "wishlist.json"));
const pet = new Pet();
// The jars outlive the app like the music queue does: a restart mid-stream keeps every coin.
const banks = new Banks({ stateFile: path.join(configDir, "banks-state.json") });
banks.configure(config.load(configDir).banks);
const server = new StreamServer(path.join(here, "overlay"), { fontDir: path.join(here, "ui", "fonts"), music, pet, banks });

// ── actions: what a full bank or a gift rule does on the streamer's PC ────────
// Keys go through SendInput (core/input.js); darkness and pictures through a
// click-through layer over the game (fx.js); sounds through this app's own
// window, the «Приложение» output, which the chat voice no longer uses.
const mediaDir = path.join(configDir, "media");
const mediaUrl = (file) => pathToFileURL(path.join(mediaDir, path.basename(file))).href;
let input = null;
let inputError = "";
try {
  input = createInput();
} catch (err) {
  inputError = err.message;
}
const fxLayer = new FxLayer({ here, mediaDir, input });
const engine = new Engine({
  input,
  fx: fxLayer,
  pet: { say: (text) => pet.say(text) },
  sound: {
    play: (s) => send("fx:sound", { url: mediaUrl(s.file), volume: s.volume }),
    stop: () => send("fx:sound", null),
  },
});
engine.on("log", (l) => send("fx:log", l));
engine.on("busy", (b) => send("fx:busy", b));

function act(job) {
  if (!config.load(configDir).fx.enabled) return send("fx:log", { type: "off", name: job.name, who: job.who, at: Date.now() });
  engine.push(job);
}

banks.on("change", (s) => send("banks:state", s));
banks.on("fill", (f) => {
  pet.bankFilled(f);
  act({ name: f.name, who: f.nick, steps: f.steps, game: f.game });
});
// Every such gift is one firing; past ten from one event the queue would only drop them.
const PER_GIFT_MAX = 10;
server.on("gift", (g) => {
  for (const rule of giftRulesFor(config.load(configDir).gifts, g.name)) {
    for (let i = 0; i < Math.min(g.fresh, PER_GIFT_MAX); i++) act({ name: rule.gift, who: g.nick, steps: rule.steps, game: rule.game });
  }
});

// The kill switch has to work with the game in front: a global shortcut.
let killKey = "";
function bindKill(combo) {
  if (combo === killKey) return;
  if (killKey) globalShortcut.unregister(accelerator(killKey));
  killKey = "";
  let ok = false;
  try {
    ok = Boolean(combo) && globalShortcut.register(accelerator(combo), () => engine.kill());
  } catch {}
  if (ok) killKey = combo;
  send("fx:killKey", { combo, ok });
}
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
  if (!process.env.MGI_SHOT) bindKill(config.load(configDir).fx.killKey);
});

app.on("before-quit", () => {
  quitting = true;
  stopHelpers();
  // Nothing stays held or dark after the app is gone.
  engine.kill();
  fxLayer.close();
  banks.flush();
  globalShortcut.unregisterAll();
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
  const was = config.load(configDir).pet?.enabled;
  const saved = config.save(configDir, cfg);
  // Settings are edited mid-stream, so a running session takes them as they land.
  server.update(saved);
  banks.configure(saved.banks);
  if (!process.env.MGI_SHOT) bindKill(saved.fx.killKey);
  // The slime on or off is a different page in the music window: reopen it.
  if (was !== saved.pet.enabled && alive(helpers.studio)) {
    stopHelper("studio");
    openStudio(saved.music.windowBg || "green");
  }
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
    startHelpers(saved);
    return { ok: true, url: server.overlayUrl, musicUrl: server.musicUrl, username: saved.username };
  } catch (err) {
    await server.stop();
    // The status event already carried a translatable code for this failure.
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("run:stop", async () => {
  await server.stop();
  stopHelpers();
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

// ── banks and actions ─────────────────────────────────────────────────────────

ipcMain.handle("banks:state", () => ({ ...banks.snapshot(), input: Boolean(input), inputError, killKey: { combo: killKey, ok: Boolean(killKey) }, busy: engine.running }));
ipcMain.handle("banks:reset", (_e, id) => banks.reset(id));
ipcMain.handle("banks:focus", (_e, id) => banks.focus(id));
// «Проверить»: the whole fill as viewers will see it, the jar itself untouched.
ipcMain.handle("banks:test", (_e, id) => {
  const b = config.load(configDir).banks.find((x) => x.id === id);
  if (!b) return { ok: false };
  // A test runs whatever is in front: the streamer pressed the button in this window.
  banks.emit("fill", { bank: b.id, name: b.name, goal: b.goal, nick: "тест", top: [], at: Date.now(), steps: b.steps, game: "" });
  return { ok: true, live: server.running };
});
ipcMain.handle("gifts:test", (_e, id) => {
  const r = config.load(configDir).gifts.find((x) => x.id === id);
  if (!r) return { ok: false };
  act({ name: r.gift || "?", who: "тест", steps: r.steps });
  return { ok: true, live: server.running };
});
ipcMain.handle("fx:kill", () => engine.kill());
ipcMain.on("fx:done", (_e, id) => fxLayer.done(id));

const PICK = {
  media: { name: "Картинка или видео", extensions: ["png", "jpg", "jpeg", "gif", "webp", "apng", "mp4", "webm", "mov", "m4v"] },
  sound: { name: "Звук", extensions: ["mp3", "wav", "ogg", "m4a", "opus"] },
};
const MEDIA_MAX = 300 * 1024 * 1024;
/** Copies a picked file into the app's media folder under a content name: the same file twice is stored once. */
ipcMain.handle("fx:pick", async (_e, kind) => {
  const filter = PICK[kind] ?? PICK.media;
  const res = await dialog.showOpenDialog(win, { properties: ["openFile"], filters: [filter] });
  const src = res.filePaths?.[0];
  if (res.canceled || !src) return null;
  const ext = path.extname(src).slice(1).toLowerCase();
  if (!filter.extensions.includes(ext)) return { error: "format" };
  if (fs.statSync(src).size > MEDIA_MAX) return { error: "size" };
  const bytes = fs.readFileSync(src);
  const file = `${crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 16)}.${ext}`;
  fs.mkdirSync(mediaDir, { recursive: true });
  if (!fs.existsSync(path.join(mediaDir, file))) fs.writeFileSync(path.join(mediaDir, file), bytes);
  return { file, name: path.basename(src, path.extname(src)).slice(0, 60) };
});
ipcMain.handle("fx:mediaUrl", (_e, file) => (file ? mediaUrl(file) : ""));

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
// A few roses from a made-up viewer, so the streamer sees the slime react.
ipcMain.handle("pet:test", () => {
  if (!server.running || !server.pet) return { ok: false };
  for (let n = 1; n <= 5; n++) server.pet.gift({ nick: "тест", giftId: 5655, name: "Rose", count: n, streakable: true, end: n === 5 });
  return { ok: true };
});
ipcMain.handle("wishlist:get", () => wishlist.list());
ipcMain.handle("wishlist:add", (_e, uid) => {
  const s = music.snapshot();
  return wishlist.add([s.current, ...s.queue, ...s.pending].find((t) => t?.uid === uid));
});
ipcMain.handle("wishlist:remove", (_e, id) => wishlist.remove(id));
// The wishlist as the streamer's playlist, from the top or from one track;
// viewers' requests still go first.
ipcMain.handle("wishlist:play", (_e, { id, nick }) => {
  if (!music.live) return { ok: false, error: "notRunning" };
  return { ok: music.playWishlist(() => wishlist.list(), nick, id) };
});
ipcMain.handle("wishlist:stop", () => music.stopWishlist());
ipcMain.handle("wishlist:open", (_e, id) => wishlist.has(id) && shell.openExternal(`https://www.youtube.com/watch?v=${id}`));
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

// ── sound helpers: the music window and the headphone copy ─────────────────────
// Studio takes no browser source, only a window and an application's sound.
// So the music overlay is a window of its own, in a process of its own, and it
// is the one that plays the music; this process speaks the chat. A third,
// hidden process plays both to the headphones. Each helper is started through
// WMI, so it is not a child of this process and a capture of mgi-stream's
// sound leaves the other two out.

const helpers = { studio: null, voice: null, monitor: null }; // role -> pid

/** Its own exe name too, for capture tools that pick a sound by program file. */
function helperExe(role) {
  if (!app.isPackaged) return process.execPath;
  const link = path.join(path.dirname(process.execPath), `mgi-stream-${role}.exe`);
  try {
    const want = fs.statSync(process.execPath);
    const have = fs.existsSync(link) && fs.statSync(link);
    if (!have || have.size !== want.size || have.mtimeMs < want.mtimeMs) {
      fs.rmSync(link, { force: true });
      fs.linkSync(process.execPath, link);
    }
    return link;
  } catch {
    return process.execPath;
  }
}

function alive(pid) {
  try {
    return pid > 0 && process.kill(pid, 0);
  } catch (err) {
    return err.code === "EPERM";
  }
}

function launchHelper(role, url, extra = []) {
  if (alive(helpers[role])) return;
  const q = (a) => `"${String(a).replace(/"/g, "")}"`;
  const args = [...(app.isPackaged ? [] : [app.getAppPath()]), `--mgi-helper=${role}`, `--mgi-url=${url}`, `--mgi-parent=${process.pid}`, ...extra];
  const line = [helperExe(role), ...args].map(q).join(" ").replace(/'/g, "''");
  const ps = `(Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='${line}'}).ProcessId`;
  helpers[role] = -1; // starting
  execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true }, (err, out) => {
    helpers[role] = err ? null : Number(String(out).trim()) || null;
    if (role === "studio") send("music:window", alive(helpers.studio));
  });
}

function stopHelper(role) {
  const pid = helpers[role];
  helpers[role] = null;
  if (pid > 0) {
    try {
      process.kill(pid);
    } catch {}
  }
  if (role === "studio") send("music:window", false);
}

// With the slime on, the music window is its home: the player sits inside it.
function openStudio(bg) {
  const page = config.load(configDir).pet?.enabled ? `${server.overlayUrl}/pet` : server.musicUrl;
  launchHelper("studio", `${page}?bg=${bg}&win=1&sound=1`, [`--mgi-bg=${bg}`]);
}

function startHelpers(cfg) {
  launchHelper("monitor", `${server.overlayUrl}/sound`);
  // The chat voice plays from its own window, so TikTok LIVE Studio can take
  // it apart from the music and from the app itself.
  launchHelper("voice", `${server.overlayUrl}/voice`);
  if ((cfg.music?.enabled || cfg.pet?.enabled) && cfg.music?.autoWindow !== false) openStudio(cfg.music?.windowBg || "green");
}

function stopHelpers() {
  stopHelper("studio");
  stopHelper("voice");
  stopHelper("monitor");
}

// The streamer may close the music window by hand; the button follows.
setInterval(() => {
  if (helpers.studio > 0 && !alive(helpers.studio)) {
    helpers.studio = null;
    send("music:window", false);
  }
  // While the voice window runs it does the talking; the app's own player only keeps the pace.
  send("voice:window", alive(helpers.voice));
}, 2000);

ipcMain.handle("music:window", (_e, bg) => {
  if (alive(helpers.studio)) {
    stopHelper("studio");
    return { ok: true };
  }
  if (!server.running || !server.musicUrl) return { ok: false };
  openStudio(bg);
  return { ok: true };
});

ipcMain.on("music:windowBg", (_e, bg) => {
  if (!alive(helpers.studio)) return;
  stopHelper("studio");
  setTimeout(() => openStudio(bg), 500);
});

ipcMain.on("music:duck", (_e, on) => server.duck(on));

ipcMain.handle("music:copyUrl", () => {
  clipboard.writeText(server.musicUrl);
  return server.musicUrl;
});
