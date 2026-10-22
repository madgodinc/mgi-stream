import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";

/**
 * The look every MGI program of one Windows user shares, stored next to the
 * language in %LOCALAPPDATA%\MGI\settings.json (`"theme": "night"`), the same
 * file and key the Tauri programs use (mgi-shared docs/themes.md). Picking a
 * theme here re-dresses Stream Control, Guard and the Assistant, and the
 * other way round. Emits `change` with the id when another program moved it.
 */

export const THEMES = ["studio", "silence", "night", "fog", "amber"];
export const DEFAULT = "studio";

export function settingsPath(dev) {
  const base = process.env.LOCALAPPDATA;
  return base ? path.join(base, dev ? "MGI-dev" : "MGI", "settings.json") : null;
}

function readObject(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** The first-run theme question was answered, here or in another MGI program. */
export const readAsked = (file) => Boolean(file && readObject(file).theme_asked === true);

export const readTheme = (file) => {
  const t = file ? readObject(file).theme : null;
  return THEMES.includes(t) ? t : DEFAULT;
};

/** Sets the theme and keeps every other key; written whole through a rename. */
export function writeTheme(file, theme) {
  const m = { ...readObject(file), theme, theme_asked: true, updated: Date.now() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2));
  fs.renameSync(tmp, file);
}

export class ThemeSetting extends EventEmitter {
  constructor(file) {
    super();
    this.file = file;
    this.current = readTheme(file);
    this.watcher = null;
  }

  get() {
    return this.current;
  }

  /** What the window needs at start: the theme and whether to ask for one. */
  state() {
    return { theme: this.current, asked: readAsked(this.file) };
  }

  set(theme) {
    if (!THEMES.includes(theme)) throw new Error(`unknown theme: ${theme}`);
    this.current = theme;
    if (this.file) writeTheme(this.file, theme);
    return theme;
  }

  /** Follows the file: another MGI program picked a theme. */
  watch() {
    if (!this.file) return;
    const dir = path.dirname(this.file);
    try {
      fs.mkdirSync(dir, { recursive: true });
      this.watcher = fs.watch(dir, (_e, name) => {
        if (name && name !== path.basename(this.file)) return;
        // A rename lands as several events; read once it settled.
        clearTimeout(this.settle);
        this.settle = setTimeout(() => {
          const next = readTheme(this.file);
          if (next === this.current) return;
          this.current = next;
          this.emit("change", next);
        }, 60);
      });
    } catch {}
  }

  stop() {
    this.watcher?.close();
  }
}
