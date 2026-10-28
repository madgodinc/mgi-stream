import { app, BrowserWindow } from "electron";

// A helper process (see boot.js): one window on the app's local server, and
// nothing else. It quits with its window, or when the app that started it is gone.

const arg = (k) => process.argv.find((a) => a.startsWith(`--mgi-${k}=`))?.slice(k.length + 7) ?? "";
const role = arg("helper"); // studio | voice | monitor
const url = arg("url");
const parent = Number(arg("parent"));
const bg = arg("bg") || "green";

// Its own profile: two Electron processes cannot share one.
app.setPath("userData", `${app.getPath("userData")}-${role}`);
// Nobody clicks these windows before they have to make a sound.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

const STUDIO_BG = { green: "#00ff00", dark: "#0b0a09", clear: "#00000000" };

// The names TikTok LIVE Studio lists for window capture and application sound
// (Mad, 23.10): «Озвучка», «Музыка», «Приложение» (the main window). The
// headphone window is hidden, so it is never offered there.
const TITLES = { studio: "Музыка", voice: "Озвучка", monitor: "mgi-stream наушники" };

app.whenReady().then(() => {
  const studio = role === "studio";
  const voice = role === "voice";
  const win = new BrowserWindow({
    width: voice ? 380 : 600,
    height: voice ? 200 : 720,
    minWidth: voice ? 280 : 320,
    minHeight: voice ? 140 : 240,
    // The voice window has to be a real window for TikTok LIVE Studio to list
    // its sound, so it shows, then gets out of the way in the taskbar.
    show: studio || voice,
    frame: !studio,
    transparent: studio && bg === "clear",
    backgroundColor: studio ? (STUDIO_BG[bg] ?? STUDIO_BG.green) : "#0b0a09",
    title: TITLES[role] ?? "mgi-stream",
    skipTaskbar: !studio && !voice,
    autoHideMenuBar: true,
    // A capture of a throttled window freezes the picture; a hidden one must keep playing.
    webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false },
  });
  win.on("page-title-updated", (e) => e.preventDefault());
  if (voice) win.once("ready-to-show", () => win.minimize());
  win.loadURL(url);
  // The server may not be up yet, or restarts with the stream: keep knocking.
  win.webContents.on("did-fail-load", () => setTimeout(() => !win.isDestroyed() && win.loadURL(url), 2000));
});

app.on("window-all-closed", () => app.quit());

setInterval(() => {
  try {
    process.kill(parent, 0);
  } catch (err) {
    // EPERM: there, just not ours to signal.
    if (err.code !== "EPERM") app.quit();
  }
}, 2000);
