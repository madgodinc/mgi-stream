import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { Streaks } from "./gifts.js";

/**
 * Piggy banks («Копилки»). A TikTok coin is tiny (100 coins are about half a
 * dollar), so one gift rarely deserves an action of its own; instead gifts
 * fill a jar with a coin goal, and a full jar fires its action.
 *
 * The banks stand in a line, in the order the streamer set. Coins go into
 * the one being filled now; when it is full it fires, starts again from
 * zero, and the next one in line is filled, with whatever did not fit
 * carried over. After the last one the line starts again from the first.
 * A paused bank is stepped over.
 *
 * Progress, the current position in the line and the log of fills live in
 * `stateFile`, so a restart mid-stream loses nothing.
 *
 * Emits: change (snapshot), fill ({ bank, nick, top, at, goal }).
 */

const MAX_FILLS_PER_GIFT = 20; // a Universe into a goal of 10 would otherwise fire 4499 times
const LOG_KEEP = 100;
const TOP = 3;
const SAVE_MS = 800;

export class Banks extends EventEmitter {
  constructor({ stateFile = null, now = () => Date.now(), timers = { set: setTimeout, clear: clearTimeout } } = {}) {
    super();
    this.stateFile = stateFile;
    this.now = now;
    this.timers = timers;
    this.streaks = new Streaks({ now });
    this.list = []; // the configured banks, in line order
    this.state = { current: "", jars: {}, log: [] };
    this.saveTimer = null;
    this.#load();
  }

  /** The configured line (cfg.banks, already normalized). Progress of known ids is kept. */
  configure(banks) {
    this.list = banks.map((b) => ({ ...b }));
    const ids = new Set(this.list.map((b) => b.id));
    for (const id of Object.keys(this.state.jars)) if (!ids.has(id)) delete this.state.jars[id];
    // A goal lowered below what is already inside: the jar is simply full at the next coin.
    this.#changed();
  }

  /** One gift event (gifts.js parseGift). Returns how many of its gifts were new. */
  gift(g) {
    const fresh = this.streaks.take(g);
    if (fresh > 0) this.add(fresh * Math.max(1, g.diamonds), g.nick);
    return fresh;
  }

  /** Puts coins into the line. Returns the fills it caused, in order. */
  add(coins, nick) {
    let left = Math.max(0, Math.floor(coins));
    const fills = [];
    while (left > 0) {
      const bank = this.active();
      if (!bank) break; // no bank to fill: the coins are not kept anywhere
      const jar = this.#jar(bank.id);
      if (fills.length >= MAX_FILLS_PER_GIFT) {
        // Enough fireworks for one gift: the rest waits in the jar, one coin short of full.
        const put = Math.min(left, Math.max(0, bank.goal - 1 - jar.have));
        jar.have += put;
        jar.round[nick] = (jar.round[nick] ?? 0) + put;
        break;
      }
      const put = Math.min(left, Math.max(0, bank.goal - jar.have));
      jar.have += put;
      jar.round[nick] = (jar.round[nick] ?? 0) + put;
      left -= put;
      if (jar.have >= bank.goal) fills.push(this.#fill(bank, nick));
    }
    // The fill first: the overlay shows the full jar before it shows the next one.
    for (const f of fills) this.emit("fill", f);
    this.#changed(fills.length > 0);
    return fills;
  }

  /** The bank being filled now: the current one, or the next unpaused one after it. */
  active() {
    const n = this.list.length;
    if (!n) return null;
    const at = Math.max(0, this.list.findIndex((b) => b.id === this.state.current));
    for (let i = 0; i < n; i++) {
      const b = this.list[(at + i) % n];
      if (!b.paused && b.goal > 0) return b;
    }
    return null;
  }

  /** Empties one jar; its log stays. */
  reset(id) {
    const jar = this.state.jars[id];
    if (!jar) return;
    jar.have = 0;
    jar.round = {};
    this.#changed(true);
  }

  /** Makes a bank the one being filled now. */
  focus(id) {
    if (!this.list.some((b) => b.id === id)) return;
    this.state.current = id;
    this.#changed(true);
  }

  snapshot() {
    const active = this.active();
    return {
      active: active?.id ?? "",
      banks: this.list.map((b) => {
        const jar = this.state.jars[b.id] ?? { have: 0, round: {} };
        return { id: b.id, name: b.name, goal: b.goal, have: Math.min(jar.have, b.goal), paused: b.paused, round: top(jar.round, 50) };
      }),
      log: this.state.log.slice(0, 40),
    };
  }

  /** What viewers see by the slime: the jar being filled now. */
  viewerState() {
    const b = this.active();
    if (!b) return { kind: "bank", on: false };
    const jar = this.state.jars[b.id] ?? { have: 0 };
    return { kind: "bank", on: true, id: b.id, name: b.name, have: Math.min(jar.have, b.goal), goal: b.goal };
  }

  /** Writes now; the app calls this on quit. */
  flush() {
    this.timers.clear(this.saveTimer);
    this.saveTimer = null;
    if (!this.stateFile) return;
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(this.stateFile + ".tmp", JSON.stringify(this.state));
      fs.renameSync(this.stateFile + ".tmp", this.stateFile);
    } catch {}
  }

  // ──────────────────────────────────────────────────────────────────────────

  #fill(bank, nick) {
    const jar = this.#jar(bank.id);
    const record = { bank: bank.id, name: bank.name, goal: bank.goal, nick, top: top(jar.round, TOP), at: this.now() };
    jar.have = 0;
    jar.round = {};
    this.state.log.unshift(record);
    this.state.log.length = Math.min(this.state.log.length, LOG_KEEP);
    // The next in line takes over; with one bank that is the same jar again.
    const i = this.list.findIndex((b) => b.id === bank.id);
    this.state.current = this.list[(i + 1) % this.list.length].id;
    this.state.current = this.active()?.id ?? this.state.current;
    return { ...record, steps: bank.steps, game: bank.game };
  }

  #jar(id) {
    return (this.state.jars[id] ??= { have: 0, round: {} });
  }

  #changed(now = false) {
    this.emit("change", this.snapshot());
    if (!this.stateFile) return;
    // A fill is written at once; a coin here and there can wait a moment.
    if (now) return this.flush();
    if (!this.saveTimer) this.saveTimer = this.timers.set(() => this.flush(), SAVE_MS);
  }

  #load() {
    if (!this.stateFile) return;
    try {
      const s = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
      this.state = {
        current: typeof s.current === "string" ? s.current : "",
        jars: s.jars && typeof s.jars === "object" ? s.jars : {},
        log: Array.isArray(s.log) ? s.log.slice(0, LOG_KEEP) : [],
      };
      for (const jar of Object.values(this.state.jars)) {
        jar.have = Math.max(0, Number(jar.have) || 0);
        jar.round = jar.round && typeof jar.round === "object" ? jar.round : {};
      }
    } catch {
      // No file yet, or a broken one: start empty rather than not at all.
    }
  }
}

/** The biggest givers first: [[nick, coins], ...]. */
function top(round, n) {
  return Object.entries(round)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}
