import { BrowserWindow, screen } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The layer over the game: one transparent, click-through, always-on-top
 * window that darkens or tints the screen and shows pictures and videos.
 * Ported from MGI Stream Control's effects/overlay.rs.
 *
 * It never takes focus (focusable: false gives it WS_EX_NOACTIVATE, shown
 * with showInactive), lets every click through to the game, and covers the
 * monitor of the window in front when an effect starts. It stays hidden
 * between effects so the game keeps its fast path, and is closed after a
 * long quiet spell, since a renderer costs memory all stream long.
 *
 * A game in exclusive fullscreen draws over any window; in Dota 2 that means
 * "Borderless window" or "Windowed" for the darkening to be seen.
 */

const CLOSE_AFTER_MS = 10 * 60000;

export class FxLayer {
  constructor({ here, mediaDir, input }) {
    this.here = here;
    this.mediaDir = mediaDir;
    this.input = input;
    this.win = null;
    this.ready = null;
    this.level = 0;
    this.media = new Map(); // id -> resolve
    this.nextId = 1;
    this.idleTimer = null;
  }

  dim(level, color, fade) {
    this.level = level;
    if (level <= 0 && !this.win) return;
    this.#send({ type: "dim", level, color, fade }, level > 0);
    if (level <= 0) this.#hideLater(fade);
  }

  /** Shows a picture or video; resolves when it has left the screen. */
  media(step) {
    const id = this.nextId++;
    const url = pathToFileURL(path.join(this.mediaDir, path.basename(step.file))).href;
    return new Promise((resolve) => {
      this.media.set(id, resolve);
      this.#send({ type: "media", id, url, pos: step.pos, size: step.size, seconds: step.seconds, volume: step.volume }, true);
    });
  }

  clear() {
    for (const done of this.media.values()) done();
    this.media.clear();
    if (this.win) this.#send({ type: "clear" }, false);
    this.#hideLater(200);
  }

  /** The page reports a finished picture or video. */
  done(id) {
    this.media.get(id)?.();
    this.media.delete(id);
    if (!this.media.size) this.#hideLater(0);
  }

  close() {
    clearTimeout(this.idleTimer);
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
    this.ready = null;
  }

  // ──────────────────────────────────────────────────────────────────────────

  #open() {
    if (this.win && !this.win.isDestroyed()) return this.ready;
    this.win = new BrowserWindow({
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      title: "mgi-stream effects",
      webPreferences: {
        preload: path.join(this.here, "fx-preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        autoplayPolicy: "no-user-gesture-required",
      },
    });
    // Above a borderless game, and every click goes through to it.
    this.win.setAlwaysOnTop(true, "screen-saver");
    this.win.setIgnoreMouseEvents(true);
    this.win.on("closed", () => {
      this.win = null;
      this.ready = null;
    });
    this.ready = this.win.loadFile(path.join(this.here, "overlay", "fx.html")).catch(() => {});
    return this.ready;
  }

  /** The monitor of the window in front: the game's. */
  #display() {
    try {
      const r = this.input?.foregroundRect?.();
      if (r && r.width > 0) return screen.getDisplayMatching(screen.screenToDipRect(null, r));
    } catch {}
    return screen.getPrimaryDisplay();
  }

  async #send(msg, show) {
    clearTimeout(this.idleTimer);
    await this.#open();
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    if (show && !win.isVisible()) {
      win.setBounds(this.#display().bounds);
      win.showInactive();
      win.setAlwaysOnTop(true, "screen-saver");
    }
    win.webContents.send("fx", msg);
  }

  #idle() {
    return this.level <= 0 && this.media.size === 0;
  }

  #hideLater(fade) {
    setTimeout(() => {
      if (!this.#idle() || !this.win || this.win.isDestroyed()) return;
      this.win.hide();
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => this.#idle() && this.close(), CLOSE_AFTER_MS);
    }, fade + 80);
  }
}
