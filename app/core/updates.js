import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";

/**
 * Updates are offered, never pushed, the way the other MGI programs do it:
 * a newer release on GitHub shows up as an offer with what changed since the
 * installed version; the streamer updates now, later, or skips that version.
 * Nothing downloads or installs on its own in the middle of a stream. After an
 * update the window says once what changed.
 *
 * electron-updater reads latest.yml from the GitHub release; the changes
 * come from docs/history.json in the repository.
 *
 * Emits `change` with {state, version, progress, detail}; state is
 * idle | available | downloading | ready | error.
 */

export const HISTORY_URL = "https://raw.githubusercontent.com/madgodinc/mgi-stream/master/docs/history.json";
const FIRST_CHECK_MS = 8000;
const EVERY_MS = 30 * 60 * 1000;

/** "0.3.10" > "0.3.9" */
export function newer(a, b) {
  const x = String(a || "0").split(".").map(Number);
  const y = String(b || "0").split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
}

export class Updates extends EventEmitter {
  /** `updater` is electron-updater's autoUpdater, or null in a dev run. */
  constructor({ updater, version, dir, fetchImpl = fetch }) {
    super();
    this.updater = updater;
    this.version = version;
    this.file = path.join(dir, "update.json");
    this.fetch = fetchImpl;
    this.info = { state: "idle", version: "", progress: 0, detail: "" };
    if (!updater) return;

    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.on("update-available", (u) => {
      if (this.#read().skipped === u.version) return;
      this.#set({ state: "available", version: u.version, progress: 0, detail: "" });
    });
    updater.on("download-progress", (p) => this.#set({ ...this.info, state: "downloading", progress: (p.percent || 0) / 100 }));
    updater.on("update-downloaded", () => {
      this.#set({ ...this.info, state: "ready", progress: 1 });
      // The streamer already said "update now": restart into the new version.
      setImmediate(() => updater.quitAndInstall(true, true));
    });
    updater.on("error", (err) => {
      // A failed background check is not news; a failed download the streamer asked for is.
      if (this.info.state === "downloading") this.#set({ ...this.info, state: "error", detail: String(err?.message ?? err).slice(0, 160) });
    });
  }

  #read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      return {};
    }
  }

  #write(patch) {
    try {
      fs.writeFileSync(this.file, JSON.stringify({ ...this.#read(), ...patch }));
    } catch {}
  }

  #set(info) {
    this.info = info;
    this.emit("change", info);
  }

  start() {
    if (!this.updater) return;
    setTimeout(() => this.check(), FIRST_CHECK_MS).unref?.();
    setInterval(() => this.check(), EVERY_MS).unref?.();
  }

  async check() {
    if (!this.updater || ["downloading", "ready"].includes(this.info.state)) return this.info;
    try {
      await this.updater.checkForUpdates();
    } catch {}
    return this.info;
  }

  install() {
    if (!this.updater || !["available", "error"].includes(this.info.state)) return;
    this.#set({ ...this.info, state: "downloading", progress: 0, detail: "" });
    this.updater.downloadUpdate().catch(() => {});
  }

  skip(version) {
    this.#write({ skipped: version });
    this.#set({ state: "idle", version: "", progress: 0, detail: "" });
  }

  /** The version the window last ran, then records this one: a newer one means "just updated". */
  seen() {
    const was = this.#read().seen ?? "";
    if (was !== this.version) this.#write({ seen: this.version });
    return was;
  }

  /** Every release with its changes, newest first; empty when GitHub does not answer. */
  async history() {
    try {
      const res = await this.fetch(HISTORY_URL, { signal: AbortSignal.timeout(8000), cache: "no-store" });
      const list = await res.json();
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }
}
