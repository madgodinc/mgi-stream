import { PHRASES, giftText } from "./pet-phrases.js";

/**
 * The slime that lives in the music window: it reacts to what the room does
 * and thinks out loud in a bubble. Bubble only, it never speaks: the voice
 * belongs to the chat.
 *
 * TikTok sends gifts in bursts. A streakable gift (a rose sent with the combo
 * button) arrives as one event per tap with a growing count and a final event
 * that says the streak ended; a plain gift arrives once per send. Either way a
 * viewer who sends fifteen roses gets one thanks for fifteen roses, not
 * fifteen thanks. When the room showers gifts faster than the bubble can say
 * them, thanks are merged per viewer, and past that into one line for the
 * whole crowd, so the bubble never runs minutes behind the room.
 *
 * Everything leaves through `send(message)`; the overlay draws it.
 */

export const PET_DEFAULTS = {
  enabled: true,
  name: "Слаймик",
  color: "mint", // mint | pink | violet | sun | sky
  thanks: true,
  likes: true,
  follows: true,
  thoughts: true,
};

const STREAK_IDLE_MS = 5000; // a streak with no "ended" event is closed after this much quiet
const PLAIN_MERGE_MS = 2500; // plain gifts of one kind from one viewer within this count as one
const LIKE_STEP = 60; // likes between two "love" reactions
const LIKE_GAP_MS = 12000; // and at least this long between them
const LIKE_SAY_MS = 90000; // a thanks for likes at most this often
const FOLLOW_MERGE_MS = 3000;
const GATHER_MS = 600;
const THOUGHT_MIN_MS = 50000;
const THOUGHT_MAX_MS = 110000;
const SLEEP_AFTER_MS = 6 * 60000;
const BIG_DIAMONDS = 99; // a gift worth this much (in total) is a big one
const CROWD_AT = 4; // this many viewers waiting for thanks: one line for all of them
const MERGE_AT = 3; // this many thanks waiting: merged per viewer

export class Pet {
  constructor({ send, now = () => Date.now(), timers = { set: setTimeout, clear: clearTimeout }, random = Math.random } = {}) {
    this.send = send;
    this.now = now;
    this.timers = timers;
    this.random = random;
    this.cfg = { ...PET_DEFAULTS };
    this.lang = "ru";
    this.streaks = new Map(); // viewer|gift -> open gift
    this.thanks = []; // finished gifts waiting for a bubble
    this.follows = [];
    this.lines = []; // other bubbles waiting: [text, mood, style]
    this.hintLines = []; // from MGI Games: what a chat command costs
    this.hintAt = 0;
    this.hintTurn = false;
    this.busyUntil = 0;
    this.likesSince = 0;
    this.likeAt = 0;
    this.likeSaidAt = 0;
    this.lastEventAt = now();
    this.asleep = false;
    this.playing = null;
    this.timer = null;
    this.thoughtTimer = null;
    this.followTimer = null;
    this.gather = null;
    this.running = false;
  }

  configure(cfg = {}, lang = "ru") {
    this.cfg = { ...PET_DEFAULTS, ...cfg };
    this.lang = PHRASES[lang] ? lang : "ru";
    this.send({ kind: "pet-cfg", ...this.cfg });
  }

  start() {
    this.running = true;
    this.lastEventAt = this.now();
    this.asleep = false;
    if (this.cfg.enabled) this.#say(this.#fill(this.#pick("hello"), {}), "happy");
    this.#planThought();
  }

  stop() {
    this.running = false;
    for (const s of this.streaks.values()) this.timers.clear(s.timer);
    this.streaks.clear();
    this.thanks = [];
    this.follows = [];
    this.lines = [];
    this.timers.clear(this.timer);
    this.timers.clear(this.thoughtTimer);
    this.timers.clear(this.followTimer);
    this.timers.clear(this.gather);
    this.timer = this.thoughtTimer = this.followTimer = this.gather = null;
  }

  // ── what the room does ─────────────────────────────────────────────────────

  /**
   * One gift event. `count` is the streak's running total for a streakable
   * gift and the number sent for a plain one; `end` marks the last event of a
   * streak (a plain gift is its own end).
   */
  gift({ nick, giftId, name, diamonds = 1, count = 1, streakable = false, end = true }) {
    if (!this.#on()) return;
    this.#wake();
    const key = `${nick}|${giftId ?? name}`;
    let s = this.streaks.get(key);
    if (!s) {
      s = { nick, name, diamonds, count: 0, timer: null };
      this.streaks.set(key, s);
      // The first tap is seen at once; the thanks waits for the streak to finish.
      this.#react(diamonds >= BIG_DIAMONDS ? "ecstatic" : "happy", diamonds >= BIG_DIAMONDS ? "coins" : "hearts", Math.min(12, 3 + Math.round(diamonds / 10)));
    }
    if (streakable) s.count = Math.max(s.count, count);
    else s.count += count;
    this.timers.clear(s.timer);
    if (streakable && end) return this.#close(key);
    // A streak that ends without saying so, and plain gifts in a row, close after a pause.
    s.timer = this.timers.set(() => this.#close(key), streakable ? STREAK_IDLE_MS : PLAIN_MERGE_MS);
  }

  like(nick, n = 1) {
    if (!this.#on() || !this.cfg.likes) return;
    this.#wake();
    this.likesSince += n;
    const t = this.now();
    if (this.likesSince < LIKE_STEP || t - this.likeAt < LIKE_GAP_MS) return;
    this.likesSince = 0;
    this.likeAt = t;
    this.#react("love", "hearts", 8);
    if (t - this.likeSaidAt > LIKE_SAY_MS && t >= this.busyUntil) {
      this.likeSaidAt = t;
      this.#say(this.#fill(this.#pick("likes"), { nick }), "love");
    }
  }

  follow(nick) {
    if (!this.#on() || !this.cfg.follows) return;
    this.#wake();
    this.follows.push(nick);
    if (this.followTimer) return;
    this.followTimer = this.timers.set(() => {
      this.followTimer = null;
      const who = [...new Set(this.follows)];
      this.follows = [];
      this.#react("surprised", "stars", 6);
      this.#queue(who.length > 1 ? this.#fill(this.#pick("followCrowd"), { list: this.#list(who) }) : this.#fill(this.#pick("follow"), { nick: who[0] }), "happy");
    }, FOLLOW_MERGE_MS);
  }

  share(nick) {
    if (!this.#on() || !this.cfg.follows) return;
    this.#wake();
    this.#react("happy", "stars", 5);
    this.#queue(this.#fill(this.#pick("share"), { nick }), "happy");
  }

  /** Any chat line keeps the slime awake; it does not answer chat. */
  chat() {
    if (!this.#on()) return;
    this.#wake();
  }

  /** A track starts (`track`) or the music stops (null). */
  music(track) {
    this.playing = track;
    if (!this.#on()) return;
    if (!track) return this.send({ kind: "pet", mood: "idle" });
    this.#wake();
    const own = !track.nick;
    this.send({ kind: "pet", mood: "dance" });
    this.#queue(this.#fill(this.#pick(own ? "musicOwn" : "music"), { title: short(track.title, 60), nick: track.nick }), "dance", "thought");
  }

  /**
   * A piggy bank was filled: the slime celebrates and names who dropped the
   * last coin, and the biggest giver of that round when it is someone else.
   * Shown even with gift thanks off: it is the moment the room worked for.
   */
  bankFilled({ name, nick, top = [] }) {
    if (!this.#on()) return;
    this.#wake();
    this.#react("ecstatic", "coins", 14);
    let text = this.#fill(this.#pick("bankFull"), { bank: name, nick });
    const best = top[0]?.[0];
    if (best && best !== nick) text += `\n${this.#fill(this.#pick("bankTop"), { top: best })}`;
    this.#queue(text, "ecstatic");
  }

  /** A line an action asked for («слайм скажет»). */
  say(text) {
    if (!this.#on() || !String(text ?? "").trim()) return;
    this.#wake();
    // Asked-for lines are answers to someone (a balance, a refund, the help),
    // so they are kept and read in full rather than trimmed like the chatter.
    this.#queue(String(text).slice(0, 140), "happy", "speech", true);
  }

  /** Replaces the hint list; an empty list ends the hints. */
  hints(lines = []) {
    this.hintLines = lines.map((l) => String(l).slice(0, 140)).filter((l) => l.trim());
    this.hintAt = 0;
    this.hintTurn = false;
  }

  // ── the bubble ─────────────────────────────────────────────────────────────

  #close(key) {
    const s = this.streaks.get(key);
    if (!s) return;
    this.timers.clear(s.timer);
    this.streaks.delete(key);
    if (!this.cfg.thanks) return;
    this.thanks.push({ nick: s.nick, name: s.name, count: s.count, worth: s.diamonds * s.count });
    // Gifts sent together close together: a moment's wait lets them share one bubble.
    if (this.gather) return;
    this.gather = this.timers.set(() => {
      this.gather = null;
      this.#pump();
    }, GATHER_MS);
  }

  /** Puts the next waiting line in the bubble once the current one has been read. */
  #pump() {
    if (!this.running || this.timer) return;
    const wait = this.busyUntil - this.now();
    if (wait > 0) {
      this.timer = this.timers.set(() => {
        this.timer = null;
        this.#pump();
      }, wait);
      return;
    }
    if (this.thanks.length) return this.#sayThanks();
    if (this.lines.length) {
      const [text, mood, style, keep] = this.lines.shift();
      this.#say(text, mood, style, 1, keep);
      this.#pump();
    }
  }

  #sayThanks() {
    const waiting = this.thanks.splice(0);
    const byNick = new Map();
    for (const g of waiting) {
      const list = byNick.get(g.nick) ?? [];
      list.push(g);
      byNick.set(g.nick, list);
    }
    const worth = waiting.reduce((a, g) => a + g.worth, 0);
    const mood = worth >= BIG_DIAMONDS ? "ecstatic" : "happy";
    let text;
    if (byNick.size >= CROWD_AT) {
      // Too many to name one by one: the biggest givers first, the rest counted.
      const order = [...byNick.entries()].sort((a, b) => sum(b[1]) - sum(a[1])).map(([n]) => n);
      text = this.#fill(this.#pick("thanksCrowd"), { list: this.#list(order) });
    } else if (waiting.length >= MERGE_AT || byNick.size > 1) {
      // One line per viewer, all of them in this bubble, one after another.
      const parts = [...byNick.entries()].map(([nick, gifts]) => this.#thanksFor(nick, gifts));
      text = parts.join("\n");
    } else {
      text = this.#thanksFor(waiting[0].nick, waiting);
    }
    this.#say(text, mood, "speech", waiting.length > 1 ? 1.3 : 1);
    this.#pump();
  }

  #thanksFor(nick, gifts) {
    const merged = new Map();
    for (const g of gifts) merged.set(g.name, (merged.get(g.name) ?? 0) + g.count);
    const what = [...merged.entries()].map(([name, n]) => giftText(name, n, this.lang)).join(", ");
    const worth = gifts.reduce((a, g) => a + g.worth, 0);
    const kind = merged.size > 1 ? "thanksMany" : worth >= BIG_DIAMONDS ? "thanksBig" : "thanksSmall";
    return this.#fill(this.#pick(kind), { nick, gift: what });
  }

  #queue(text, mood, style = "speech", keep = false) {
    this.lines.push([text, mood, style, keep]);
    // Old news is not worth reading out: the bubble keeps only the latest few
    // of its own lines. Asked-for lines wait their turn, up to a dozen.
    const own = this.lines.filter((l) => !l[3]);
    const asked = this.lines.filter((l) => l[3]);
    const drop = new Set([...own.slice(0, Math.max(0, own.length - 4)), ...asked.slice(0, Math.max(0, asked.length - 12))]);
    if (drop.size) this.lines = this.lines.filter((l) => !drop.has(l));
    this.#pump();
  }

  #say(text, mood = "happy", style = "speech", stretch = 1, keep = false) {
    const backlog = this.thanks.length + this.lines.length;
    // Long enough to read; shorter when more is waiting, except for answers.
    let ms = Math.min(8000, Math.max(3000, 1800 + text.length * 55)) * stretch;
    if (backlog > 2 && !keep) ms = Math.max(2500, ms * 0.6);
    this.busyUntil = this.now() + ms;
    this.send({ kind: "pet", mood, say: { text, ms: Math.round(ms), style } });
  }

  #react(mood, fx, n) {
    this.send({ kind: "pet", mood, fx: { type: fx, n } });
  }

  // ── on its own ─────────────────────────────────────────────────────────────

  #planThought() {
    this.timers.clear(this.thoughtTimer);
    if (!this.running) return;
    const ms = THOUGHT_MIN_MS + this.random() * (THOUGHT_MAX_MS - THOUGHT_MIN_MS);
    this.thoughtTimer = this.timers.set(() => {
      this.#think();
      this.#planThought();
    }, ms);
  }

  #think() {
    if (!this.cfg.enabled) return;
    const t = this.now();
    if (t < this.busyUntil || this.thanks.length || this.lines.length) return;
    if (!this.asleep && t - this.lastEventAt > SLEEP_AFTER_MS && !this.playing) {
      this.asleep = true;
      this.send({ kind: "pet", mood: "sleep" });
    }
    // Every other idle slot is a hint, asleep or not: a quiet room is when viewers need one.
    if (this.hintLines.length && (this.hintTurn = !this.hintTurn)) {
      const text = this.hintLines[this.hintAt++ % this.hintLines.length];
      return this.#say(text, this.asleep ? "sleep" : this.playing ? "dance" : "idle", "thought");
    }
    if (this.asleep) return this.#say(this.#pick("sleepy"), "sleep", "thought");
    if (!this.cfg.thoughts) return;
    const list = this.playing && this.random() < 0.5 ? "thoughtsMusic" : "thoughts";
    this.#say(this.#fill(this.#pick(list), {}), this.playing ? "dance" : "idle", "thought");
  }

  #wake() {
    this.lastEventAt = this.now();
    if (!this.asleep) return;
    this.asleep = false;
    this.#queue(this.#pick("wake"), "surprised");
  }

  #on() {
    return this.running && this.cfg.enabled;
  }

  #pick(kind) {
    const list = PHRASES[this.lang][kind] ?? PHRASES.ru[kind] ?? [""];
    return list[Math.floor(this.random() * list.length)];
  }

  #fill(text, vars) {
    return text.replace(/\{(\w+)\}/g, (m, k) => (k === "name" ? this.cfg.name : vars[k] ?? ""));
  }

  #list(nicks) {
    const shown = nicks.slice(0, 3);
    const rest = nicks.length - shown.length;
    if (!rest) return shown.join(", ");
    return `${shown.join(", ")} ${this.lang === "ru" ? `и ещё ${rest}` : `and ${rest} more`}`;
  }
}

const sum = (gifts) => gifts.reduce((a, g) => a + g.worth, 0);
const short = (s, n) => (String(s ?? "").length > n ? String(s).slice(0, n - 1) + "…" : String(s ?? ""));
