import { EventEmitter } from "node:events";
import { LIMITS } from "./rules.js";

/**
 * Runs actions one at a time off a queue: a full bank or a gift rule pushes a
 * job (a list of steps), the engine presses keys, darkens the screen, shows
 * a picture, makes the slime talk. Ported from MGI Stream Control's
 * effects/engine.rs.
 *
 * A job lasts until its last step and its last lasting effect are over, so
 * two banks filled back to back darken the screen twice in a row rather than
 * once on top of each other.
 *
 * The kill switch bumps `epoch`: the running job stops at its next wait,
 * queued ones are dropped, held keys are released and the screen comes back.
 *
 * Everything outside is injected, so the queue runs in tests on a fake clock:
 *   input:  down(code), up(code), click(button, down), releaseAll(), foreground() -> exe name
 *   fx:     dim(level, color, fadeMs), media(step) -> Promise (done), clear()
 *   pet:    say(text)
 *   sound:  play(step), stop()
 *
 * Emits: log ({ type: fire|skip|done|stop|error, text, job }), busy (boolean).
 */

const QUEUE_MAX = 30;
const GAP_MS = 400; // between two jobs, so they read as two
const GAME_WAIT_MS = 30000;
const GAME_POLL_MS = 250;
const FADE_IN_MS = 250;
const FADE_OUT_MS = 600;

export class Engine extends EventEmitter {
  constructor({ input = null, fx = null, pet = null, sound = null, timers = { set: setTimeout, clear: clearTimeout } } = {}) {
    super();
    this.input = input;
    this.fx = fx;
    this.pet = pet;
    this.sound = sound;
    this.timers = timers;
    this.queue = [];
    this.epoch = 0;
    this.running = false;
    this.waits = new Set();
    this.dimGen = 0;
    this.lit = false; // the screen is darkened right now
  }

  get queued() {
    return this.queue.length;
  }

  /** Adds a job: { name, who, steps, game }. False when the queue is full. */
  push(job) {
    if (!job?.steps?.length) return false;
    if (this.queue.length >= QUEUE_MAX) {
      this.#log("skip", `queue full: ${job.name}`, job);
      return false;
    }
    this.queue.push(job);
    this.#pump();
    return true;
  }

  /** Stops the running job, drops the queue and undoes everything that lasts. */
  kill() {
    this.epoch++;
    const dropped = this.queue.length;
    this.queue = [];
    for (const w of this.waits) {
      this.timers.clear(w.id);
      w.done(false);
    }
    this.waits.clear();
    this.input?.releaseAll();
    this.dimGen++;
    this.lit = false;
    this.fx?.dim(0, "#000000", 150);
    this.fx?.clear();
    this.sound?.stop();
    this.#log("stop", String(dropped));
  }

  async #pump() {
    if (this.running) return;
    this.running = true;
    this.emit("busy", true);
    while (this.queue.length) {
      const job = this.queue.shift();
      const epoch = this.epoch;
      try {
        await this.#run(job, epoch);
      } catch (err) {
        this.input?.releaseAll();
        this.#log("error", err?.message ?? String(err), job);
      }
      if (this.queue.length) await this.#sleep(GAP_MS, this.epoch);
    }
    this.running = false;
    this.emit("busy", false);
  }

  /** Sleeps; resolves false at once if the kill switch fires meanwhile. */
  #sleep(ms, epoch) {
    if (epoch !== this.epoch) return Promise.resolve(false);
    if (ms <= 0) return Promise.resolve(true);
    return new Promise((done) => {
      const w = { id: 0, done };
      w.id = this.timers.set(() => {
        this.waits.delete(w);
        done(this.epoch === epoch);
      }, ms);
      this.waits.add(w);
    });
  }

  async #waitForGame(job, epoch) {
    const want = String(job.game ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!want.length || !this.input?.foreground) return true;
    let told = false;
    for (let waited = 0; ; waited += GAME_POLL_MS) {
      const fg = String(this.input.foreground() ?? "").toLowerCase();
      if (want.includes(fg)) return true;
      if (!told) this.#log("wait", want[0], job);
      told = true;
      if (waited >= GAME_WAIT_MS || !(await this.#sleep(GAME_POLL_MS, epoch))) {
        if (epoch === this.epoch) this.#log("skip", want[0], job);
        return false;
      }
    }
  }

  async #run(job, epoch) {
    if (!(await this.#waitForGame(job, epoch))) return false;
    this.#log("fire", job.who ?? "", job);
    const lasting = [];
    for (const step of job.steps) {
      if (epoch !== this.epoch) {
        this.input?.releaseAll();
        return false;
      }
      const effect = await this.#step(step, epoch);
      if (effect) lasting.push(effect);
    }
    // The job is over when what it put on the screen is gone.
    await Promise.all(lasting);
    if (epoch !== this.epoch) return false;
    this.#log("done", "", job);
    return true;
  }

  /** Presses `repeat` times: modifiers down, the key, hold, everything up in reverse. */
  async #press(epoch, { code, mods = [], hold_ms = 40, repeat = 1, gap_ms = 60 }, maxHold = LIMITS.holdMs) {
    const n = Math.min(LIMITS.repeat, Math.max(1, repeat));
    const hold = Math.min(maxHold, Math.max(10, hold_ms));
    for (let i = 0; i < n; i++) {
      for (const m of mods) this.input?.down(m);
      this.input?.down(code);
      const held = await this.#sleep(hold, epoch);
      this.input?.up(code);
      for (const m of [...mods].reverse()) this.input?.up(m);
      if (!held) return;
      if (i + 1 < n && !(await this.#sleep(Math.min(LIMITS.delayMs, gap_ms), epoch))) return;
    }
  }

  /** Runs one step; a step that lasts (darkness, a picture) returns a promise of its end. */
  async #step(s, epoch) {
    switch (s.kind) {
      case "key":
        return void (await this.#press(epoch, s));
      case "hold":
        return void (await this.#press(epoch, { ...s, hold_ms: s.seconds * 1000, repeat: 1 }, LIMITS.effectS * 1000));
      case "delay":
        return void (await this.#sleep(Math.min(LIMITS.delayMs, s.ms), epoch));
      case "click": {
        const n = Math.min(LIMITS.repeat, Math.max(1, s.repeat ?? 1));
        for (let i = 0; i < n; i++) {
          this.input?.click(s.button, true);
          const held = await this.#sleep(25, epoch);
          this.input?.click(s.button, false);
          if (!held || (i + 1 < n && !(await this.#sleep(s.gap_ms ?? 100, epoch)))) return;
        }
        return;
      }
      case "dim": {
        const gen = ++this.dimGen;
        this.lit = true;
        this.fx?.dim(s.level, s.color, FADE_IN_MS);
        return this.#sleep(Math.min(LIMITS.effectS, s.seconds) * 1000, epoch).then(async (ok) => {
          // A newer darkening owns the screen now; it brings it back itself.
          if (!ok || gen !== this.dimGen) return;
          this.lit = false;
          this.fx?.dim(0, s.color, FADE_OUT_MS);
          await this.#sleep(FADE_OUT_MS, epoch);
        });
      }
      case "media": {
        if (!s.file) return this.#log("error", "no file", null);
        const shown = Promise.resolve(this.fx?.media(s));
        // Nothing stays up past the ceiling, whatever the file does.
        const cap = this.#sleep((s.seconds > 0 ? s.seconds : LIMITS.effectS) * 1000 + 2000, epoch);
        return Promise.race([shown, cap]);
      }
      case "say":
        return void this.pet?.say(s.text);
      case "sound":
        if (!s.file) return this.#log("error", "no file", null);
        return void this.sound?.play(s);
      default:
        return undefined;
    }
  }

  #log(type, text, job) {
    this.emit("log", { type, text, name: job?.name ?? "", who: job?.who ?? "", at: Date.now() });
  }
}
