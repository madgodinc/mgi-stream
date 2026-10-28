import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { rankOf, RANK } from "./filter.js";

/**
 * Music requests from the TikTok chat, the way MGI Stream Control takes them
 * on Twitch. A viewer writes `/music <name or YouTube link>`; our server
 * (madgodinc.net/music/api) finds the video, checks it against its rules,
 * downloads it with yt-dlp and hands the file over once; the app keeps it
 * only until it has played.
 *
 * YouTube is slow or blocked for many streamers, hence the server in the
 * middle. The server deletes a file the moment its last byte went out, this
 * side deletes it after playing. The one exception is the streamer's wishlist:
 * its tracks keep a copy on this PC (core/wishcache.js) and play from it.
 *
 * Playback is not here. The app window plays the sound (OBS captures the
 * program as its own audio line) and reports its position; the overlay shows
 * the picture muted and follows that position. This class owns the queue and
 * the files, and emits:
 *   change {current, queue, pending}   the whole state, for the window
 *   play {track}                       the window should start this file
 *   stop                               nothing is playing any more
 *   note {nick, title, ok, reason}     a request was taken or turned down
 *   song {track}                       a viewer asked what is playing
 */

export const SERVER = "https://madgodinc.net/music/api";

// A saved queue older than this is a previous stream, not this one.
const KEEP_MS = 12 * 60 * 60 * 1000;
const SAVE_POSITION_MS = 3000;
// What a track carries to disk and back; the rest is rebuilt.
const KEPT = ["uid", "id", "title", "channel", "duration", "thumbnail", "hasVideo", "nick", "state", "file", "ext", "video", "resume", "wish", "cached"];
// Wishlist tracks in a row that would not download: the wishlist stops.
const WISH_FAILS = 3;

export const MUSIC_DEFAULTS = {
  enabled: true,
  cmd: "/music",
  skipCmd: "/skip",
  songCmd: "/song",
  audience: "everyone", // everyone | followers | subscribers | moderators
  mode: "video", // video | audio
  maxHeight: 480,
  volume: 70,
  muted: false,
  // Music steps back while a chat message is read out.
  duck: true,
  maxQueue: 10,
  perViewer: 2,
  maxMinutes: 6,
  approve: false,
  skipVotes: 3, // 0: only the streamer and moderators skip
  songReply: true,
  showNotes: true,
  // The picture window for TikTok LIVE Studio, which takes no links: green | dark | clear.
  windowBg: "green",
  // The music window opens by itself with the stream: it is where the music sounds.
  autoWindow: true,
  monitor: 0, // the music in the streamer's headphones, 0-100
  bannedWords: [],
  bannedTracks: [], // YouTube ids
  bannedUsers: [],
};

const JOB_POLL_MS = 1000;
const JOB_TIMEOUT_MS = 6 * 60 * 1000;

const lower = (s) => String(s ?? "").trim().toLowerCase();

/** `/music some song` -> "some song"; null when the line is not this command. */
export function commandArg(text, cmd) {
  const c = lower(cmd);
  if (!c) return null;
  const t = String(text ?? "").trim();
  if (t.toLowerCase() === c) return "";
  if (t.toLowerCase().startsWith(c) && /\s/.test(t[c.length])) return t.slice(c.length).trim();
  return null;
}

const YT_LINK = /(?:youtube\.com|youtu\.be)\S*/i;

export const isStaff = (identity = {}) => Boolean(identity.isModeratorOfAnchor || identity.isAnchor);

/**
 * Whether one viewer may order right now: a reason code the window
 * translates, or null. Pure, so the rules are tested without a server.
 */
export function refuse(cfg, state, { nick, identity }) {
  const who = lower(nick);
  if (cfg.bannedUsers.some((u) => lower(u) === who)) return "bannedUser";
  if (!isStaff(identity) && rankOf(identity) < RANK[cfg.audience]) return "tier";
  const theirs = [...state.queue, ...state.pending, state.current].filter((t) => t && lower(t.nick) === who).length;
  if (!isStaff(identity) && theirs >= cfg.perViewer) return "perViewer";
  if (state.queue.length + state.pending.length >= cfg.maxQueue) return "full";
  return null;
}

/** The streamer's own ban lists, applied to what the server found. */
export function refuseTrack(cfg, state, track) {
  if (cfg.bannedTracks.includes(track.id)) return "bannedTrack";
  const text = lower(`${track.title} ${track.channel}`);
  if (cfg.bannedWords.some((w) => lower(w) && text.includes(lower(w)))) return "bannedWord";
  if ([...state.queue, ...state.pending, state.current].some((t) => t && t.id === track.id)) return "duplicate";
  return null;
}

let nextUid = 1;

export class Music extends EventEmitter {
  /**
   * With `stateFile` the queue outlives the app: a restart or a stop of the
   * stream picks up at the same track and second, files kept. Without it
   * (tests) off air clears everything.
   */
  constructor({ account, workDir, fetchImpl = fetch, server = SERVER, stateFile = null, cache = null }) {
    super();
    this.account = account;
    this.workDir = workDir;
    this.stateFile = stateFile;
    // The wishlist copies: a wishlist track plays from there and goes to the server only without one.
    this.cache = cache;
    this.savedAt = 0;
    this.fetch = fetchImpl;
    this.server = server;
    this.cfg = { ...MUSIC_DEFAULTS };
    this.queue = []; // approved, in play order
    this.pending = []; // waiting for the streamer's yes
    this.current = null;
    this.paused = false;
    this.position = 0;
    this.votes = new Set();
    this.loading = null; // the track being downloaded
    this.live = false;
    // The streamer's wishlist playing between requests: {list, nick, at, fails},
    // `at` the id of the wishlist track to take next.
    this.wish = null;
    this.wishNext = null; // that track, coming down while something else plays
  }

  configure(cfg) {
    const c = { ...MUSIC_DEFAULTS, ...cfg };
    // Own copies: a ban from the window edits these lists in place.
    for (const k of ["bannedWords", "bannedTracks", "bannedUsers"]) c[k] = [...(c[k] ?? [])];
    this.cfg = c;
  }

  /** On air: requests are taken. Off air: everything stops and the files go. */
  setLive(on) {
    this.live = on;
    if (on) {
      this.#restore();
      return this.#pump();
    }
    if (this.stateFile) return this.#hold();
    this.#dropWishNext();
    this.wish = null;
    for (const t of [...this.queue, ...this.pending, this.current]) if (t) this.#drop(t);
    this.queue = [];
    this.pending = [];
    this.current = null;
    this.paused = false;
    this.emit("stop");
    this.#changed();
  }

  snapshot() {
    const view = (t) =>
      t && {
        uid: t.uid,
        id: t.id,
        title: t.title,
        channel: t.channel,
        duration: t.duration,
        thumbnail: t.thumbnail,
        nick: t.nick,
        state: t.state,
        progress: t.progress ?? 0,
        video: Boolean(t.video),
        wish: Boolean(t.wish),
      };
    return {
      current: view(this.current),
      wishlist: Boolean(this.wish),
      // The wishlist track coming down: shown while nothing plays, or the wait looks like a fault.
      wishNext: view(this.wishNext),
      paused: this.paused,
      position: this.position,
      votes: this.votes.size,
      queue: this.queue.map(view),
      pending: this.pending.map(view),
    };
  }

  #changed() {
    this.emit("change", this.snapshot());
    this.#save();
  }

  // ── keeping the queue across restarts ───────────────────────────────────────

  #save() {
    if (!this.stateFile) return;
    const keep = (t) => t && Object.fromEntries(KEPT.map((k) => [k, t[k]]));
    const state = {
      at: Date.now(),
      current: this.current && { ...keep(this.current), position: this.position },
      paused: this.paused,
      queue: this.queue.map(keep),
      pending: this.pending.map(keep),
    };
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(this.stateFile + ".tmp", JSON.stringify(state));
      fs.renameSync(this.stateFile + ".tmp", this.stateFile);
      this.savedAt = state.at;
    } catch {}
  }

  #load() {
    try {
      const s = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
      return Date.now() - s.at < KEEP_MS ? s : null;
    } catch {
      return null;
    }
  }

  /** Off air with a state file: playback stops, the queue and files stay. */
  #hold() {
    if (this.current) {
      // The track goes back to the head of the line, to start where it stopped.
      this.current.state = this.current.file ? "ready" : "queued";
      this.current.resume = this.position;
      this.queue.unshift(this.current);
      this.current = null;
      this.emit("stop");
    }
    this.#dropWishNext();
    this.loading = null;
    for (const t of this.queue) if (t.state === "loading") t.state = "queued";
    this.#changed();
  }

  /** Back on air, or the first start after a restart: the saved queue returns. */
  #restore() {
    if (!this.stateFile || this.current || this.queue.length || this.pending.length) return;
    const s = this.#load();
    if (!s) return;
    const back = (t) => {
      if (!t) return null;
      const have = t.file && fs.existsSync(t.file);
      nextUid = Math.max(nextUid, t.uid + 1);
      if (have && t.cached) this.cache?.hold(t.id);
      return { ...t, file: have ? t.file : null, state: t.state === "pending" ? "pending" : have ? "ready" : "queued", progress: have ? 1 : 0 };
    };
    this.queue = s.queue.map(back);
    this.pending = s.pending.map(back);
    const cur = back(s.current);
    if (cur) {
      cur.resume = s.current.position || 0;
      this.queue.unshift(cur);
    }
    this.#changed();
  }

  /** Files of the saved queue stay; anything else in the folder is a leftover. */
  #keptFiles() {
    const s = this.stateFile && this.#load();
    if (!s) return new Set();
    return new Set([s.current, ...s.queue, ...s.pending].filter((t) => t?.file).map((t) => path.basename(t.file)));
  }

  // ── chat ───────────────────────────────────────────────────────────────────

  /**
   * Every chat line passes here first. Returns a reason code when the line was
   * a music command (so it is not read out loud), or null for ordinary chat.
   */
  onChat(nick, text, identity = {}) {
    const c = this.cfg;
    if (!c.enabled) return null;

    const query = commandArg(text, c.cmd);
    if (query !== null) {
      this.request(nick, query, identity);
      return "music";
    }
    if (commandArg(text, c.skipCmd) !== null) {
      this.voteSkip(nick, identity);
      return "musicSkip";
    }
    if (commandArg(text, c.songCmd) !== null) {
      if (c.songReply && this.current) this.emit("song", { track: this.snapshot().current });
      return "musicSong";
    }
    return null;
  }

  #note(nick, title, reason, arg) {
    if (this.cfg.showNotes) this.emit("note", { nick, title, ok: !reason, reason, arg });
    this.emit("request", { nick, title, ok: !reason, reason, arg });
  }

  async request(nick, query, identity = {}) {
    if (!this.live) return;
    if (!query) return this.#note(nick, "", "empty");
    if (!this.account.status().ok) return this.#note(nick, query, "noSub");
    const no = refuse(this.cfg, this, { nick, identity });
    if (no) return this.#note(nick, query, no);

    let res;
    try {
      const link = query.match(YT_LINK);
      res = await this.#api("POST", "/resolve", {
        ...(link ? { url: link[0].startsWith("http") ? link[0] : "https://" + link[0] } : { query }),
        max_duration: this.cfg.maxMinutes * 60,
      });
    } catch (err) {
      return this.#note(nick, query, "server", err.message);
    }
    if (res.status !== 200) return this.#note(nick, query, "server", res.data.error || `HTTP ${res.status}`);
    const t = res.data;
    if (!t.ok) return this.#note(nick, t.title || query, "rules", t.reason);

    // The checks again: the lookup took seconds and the queue moved meanwhile.
    const again = refuse(this.cfg, this, { nick, identity }) ?? refuseTrack(this.cfg, this, t);
    if (again) return this.#note(nick, t.title, again);
    if (!this.live) return;

    const track = {
      uid: nextUid++,
      id: t.id,
      title: t.title,
      channel: t.channel,
      duration: t.duration,
      thumbnail: t.thumbnail,
      hasVideo: t.has_video,
      nick,
      state: "queued",
    };
    if (this.cfg.approve && !isStaff(identity)) {
      track.state = "pending";
      this.pending.push(track);
    } else {
      this.queue.push(track);
    }
    this.#note(nick, t.title, null, track.state);
    this.#changed();
    this.#pump();
  }

  voteSkip(nick, identity = {}) {
    if (!this.current) return;
    if (isStaff(identity)) return this.skip();
    if (!this.cfg.skipVotes) return;
    this.votes.add(lower(nick));
    if (this.votes.size >= this.cfg.skipVotes) return this.skip();
    this.#changed();
  }

  // ── the streamer's controls ────────────────────────────────────────────────

  #find(uid) {
    for (const list of [this.queue, this.pending]) {
      const i = list.findIndex((t) => t.uid === uid);
      if (i >= 0) return { list, i, track: list[i] };
    }
    return null;
  }

  approve(uid) {
    const hit = this.#find(uid);
    if (!hit || hit.list !== this.pending) return;
    hit.list.splice(hit.i, 1);
    hit.track.state = "queued";
    this.queue.push(hit.track);
    this.#changed();
    this.#pump();
  }

  remove(uid) {
    const hit = this.#find(uid);
    if (!hit) return;
    hit.list.splice(hit.i, 1);
    this.#drop(hit.track);
    this.#changed();
    this.#pump();
  }

  /** Puts a queued track at `index` of the play order. */
  move(uid, index) {
    const i = this.queue.findIndex((t) => t.uid === uid);
    if (i < 0) return;
    const [t] = this.queue.splice(i, 1);
    this.queue.splice(Math.max(0, Math.min(index, this.queue.length)), 0, t);
    this.#changed();
    this.#pump();
  }

  skip() {
    if (!this.current) return;
    this.finished(this.current.uid);
  }

  /** Bans the track or the viewer behind a queue entry, and drops the entry. */
  ban(uid, what) {
    const t = this.current?.uid === uid ? this.current : this.#find(uid)?.track;
    if (!t) return null;
    const list = what === "user" ? this.cfg.bannedUsers : this.cfg.bannedTracks;
    const value = what === "user" ? t.nick : t.id;
    if (!list.includes(value)) list.push(value);
    if (t === this.current) this.skip();
    else this.remove(uid);
    return { bannedUsers: this.cfg.bannedUsers, bannedTracks: this.cfg.bannedTracks };
  }

  setPaused(paused) {
    this.paused = paused;
    this.#changed();
  }

  /** The window reports where playback is; the overlay follows it. */
  progress(uid, position, paused) {
    if (this.current?.uid !== uid) return;
    this.position = position;
    this.paused = paused;
    if (Date.now() - this.savedAt > SAVE_POSITION_MS) this.#save();
  }

  /** Playback of `uid` ended, failed or was skipped: the file goes, the next comes. */
  finished(uid) {
    if (this.current?.uid !== uid) return;
    this.#drop(this.current);
    this.current = null;
    this.position = 0;
    this.paused = false;
    this.votes.clear();
    this.emit("stop");
    this.#changed();
    this.#pump();
  }

  /** The file of a track the window or the overlay asks for. */
  fileOf(uid) {
    const t = this.current?.uid === uid ? this.current : this.queue.find((q) => q.uid === uid);
    return t?.file && fs.existsSync(t.file) ? t : null;
  }

  // ── the wishlist ───────────────────────────────────────────────────────────

  /**
   * Plays the streamer's wishlist whenever no request waits: a viewer's track
   * still goes next, after the one playing, and the wishlist goes on once the
   * queue is empty again, round and round. `list` returns the wishlist as it
   * is now (it changes while it plays); `from` is the id to start at.
   */
  playWishlist(list, nick, from = null) {
    if (!this.live) return false;
    const items = list();
    if (!items.length) return false;
    const i = Math.max(0, items.findIndex((t) => t.id === from));
    // The same track asked again while it downloads: the download goes on.
    // Starting it over is what made a slow track never come.
    const same = this.wishNext?.id === items[i].id;
    if (!same) this.#dropWishNext();
    this.wish = { list, nick, at: same ? items[(i + 1) % items.length].id : items[i].id, fails: 0 };
    if (same && !this.current?.wish) {
      this.#changed();
      return true;
    }
    // A wishlist track playing now gives way at once; a viewer's plays out.
    if (this.current?.wish) this.finished(this.current.uid);
    else {
      this.#changed();
      this.#pump();
    }
    return true;
  }

  stopWishlist() {
    this.#dropWishNext();
    this.wish = null;
    if (this.current?.wish) return this.finished(this.current.uid);
    this.#changed();
  }

  /** The next wishlist track to bring down, made once; null while not needed. */
  #wishTrack() {
    if (!this.wish) return null;
    if (this.wishNext) return this.wishNext.state === "queued" ? this.wishNext : null;
    const items = this.wish.list();
    if (!items.length) return null;
    // Gone from the list meanwhile: back to the top.
    const i = Math.max(0, items.findIndex((t) => t.id === this.wish.at));
    const w = items[i];
    this.wish.at = items[(i + 1) % items.length].id;
    this.wishNext = {
      uid: nextUid++,
      id: w.id,
      title: w.title,
      channel: w.channel,
      duration: w.duration,
      thumbnail: w.thumbnail,
      // The server looks the video up again and knows better.
      hasVideo: true,
      nick: this.wish.nick,
      state: "queued",
      wish: true,
    };
    return this.wishNext;
  }

  /** Drops the prepared wishlist track; it is the one taken next time. */
  #dropWishNext() {
    const t = this.wishNext;
    if (!t) return;
    this.wishNext = null;
    if (this.wish) this.wish.at = t.id;
    this.#drop(t);
  }

  // ── downloads ──────────────────────────────────────────────────────────────

  #start(track) {
    this.current = track;
    track.state = "playing";
    const start = track.resume || 0;
    delete track.resume;
    this.position = start;
    this.paused = false;
    this.votes.clear();
    if (track.wish && this.wish) this.wish.fails = 0;
    this.emit("play", { track: { ...this.snapshot().current, ext: track.ext, start } });
    this.#changed();
  }

  /**
   * Plays the head of the queue once it is here, and keeps one download going
   * for the next track. The order is the streamer's, so a later track that
   * happens to arrive first still waits its turn. The wishlist fills in only
   * when nobody's request is in the queue.
   */
  #pump() {
    if (!this.live) return;
    const head = this.queue[0];
    if (!this.current && head?.state === "ready") this.#start(this.queue.shift());
    else if (!this.current && !this.queue.length && this.wishNext?.state === "ready") {
      const t = this.wishNext;
      this.wishNext = null;
      this.#start(t);
    }
    if (this.loading) return;
    const next = this.queue.find((t) => t.state === "queued") ?? this.#wishTrack();
    if (!next) return;
    // Only the next two in line come down early; a long queue would otherwise
    // fill the disk with tracks that may be removed before they play.
    if (this.queue.indexOf(next) > 1) return;
    this.loading = next;
    this.#download(next)
      .then(() => {
        next.state = "ready";
      })
      .catch((err) => {
        if (next.wish) {
          if (this.wishNext === next) this.wishNext = null;
          this.#drop(next);
          // Dropped on purpose is not a failure; real failures in a row stop the wishlist.
          if (err.message !== "removed" && this.wish && ++this.wish.fails >= WISH_FAILS) this.wish = null;
          return;
        }
        // Cut off by going off air: it waits in the saved queue for the next start.
        if (!this.live && this.stateFile && this.queue.includes(next)) {
          next.state = "queued";
          return;
        }
        next.state = "failed";
        next.error = err.message;
        const i = this.queue.indexOf(next);
        if (i >= 0) this.queue.splice(i, 1);
        this.#drop(next);
        this.#note(next.nick, next.title, "download", err.message);
      })
      .finally(() => {
        this.loading = null;
        this.#changed();
        this.#pump();
      });
  }

  async #download(track) {
    track.state = "loading";
    track.cached = false;
    const copy = track.wish && this.cache?.get(track.id);
    if (copy) {
      this.cache.hold(track.id);
      Object.assign(track, { file: copy.file, ext: copy.ext, video: copy.video, cached: true, progress: 1 });
      return;
    }
    this.#changed();
    // The streamer's own tracks are not held to the viewers' length limit, only to the server's.
    const max = track.wish ? undefined : this.cfg.maxMinutes * 60;
    const want = { video: this.cfg.mode === "video" && track.hasVideo, maxHeight: this.cfg.maxHeight, max };
    const got = await this.#fetchMedia(track.id, want, this.workDir, String(track.uid), {
      alive: () => this.#alive(track),
      tick: (p) => {
        if (p !== null) track.progress = p;
        this.#changed();
      },
      started: (video) => (track.video = video),
    });
    track.file = got.file;
    track.ext = got.ext;
    track.video = got.video;
    track.progress = 1;
    // Wished before it came down: the wishlist keeps this file instead of fetching it again.
    this.cache?.keep(track.id, got.file, got.ext, got.video);
  }

  /**
   * One track from the server for the wishlist copies, with the streamer's
   * video setting, outside the queue: {file, ext, video}.
   */
  fetchMedia(id, dir, name, cfg = this.cfg) {
    const c = { ...MUSIC_DEFAULTS, ...cfg };
    return this.#fetchMedia(id, { video: c.mode === "video", maxHeight: c.maxHeight }, dir, name);
  }

  /** The server's job: ask, wait, download into `dir/name.ext`. */
  async #fetchMedia(id, { video: asked, maxHeight, max }, dir, name, { alive = () => true, tick = () => {}, started = () => {} } = {}) {
    const start = await this.#api("POST", "/fetch", { id, video: asked, max_height: maxHeight, max_duration: max });
    if (start.status !== 200) throw new Error(start.data.error || `HTTP ${start.status}`);
    const job = start.data.job;
    const video = Boolean(start.data.video);
    started(video);

    const until = Date.now() + JOB_TIMEOUT_MS;
    for (;;) {
      if (!alive()) throw new Error("removed");
      const s = await this.#api("GET", `/job/${job}`);
      if (s.status !== 200) throw new Error(s.data.error || `HTTP ${s.status}`);
      if (s.data.state === "ready") break;
      if (s.data.state === "failed") throw new Error(s.data.error || "failed");
      tick(s.data.total ? Math.min(0.99, s.data.done / s.data.total) : null);
      if (Date.now() > until) throw new Error("timeout");
      await new Promise((r) => setTimeout(r, JOB_POLL_MS));
    }

    const res = await this.fetch(`${this.server}/file/${job}`, { headers: this.#headers(), signal: AbortSignal.timeout(JOB_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ext = (res.headers.get("x-media-ext") || (video ? "mp4" : "m4a")).replace(/[^a-z0-9]/gi, "");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}.${ext}`);
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(file));
    if (!alive()) {
      fs.rmSync(file, { force: true });
      throw new Error("removed");
    }
    return { file, ext, video };
  }

  #alive(track) {
    return this.live && (this.queue.includes(track) || this.current === track || this.wishNext === track);
  }

  #drop(track) {
    // A wishlist copy is not this queue's to delete; it is only let go of.
    if (track?.file && track.cached) this.cache?.release(track.id);
    else if (track?.file) fs.rm(track.file, { force: true }, () => {});
    if (track) {
      track.file = null;
      track.cached = false;
    }
  }

  #headers() {
    return { authorization: `Bearer ${this.account.token}`, "x-mgi-product": "tiktok", "content-type": "application/json" };
  }

  async #api(method, route, body) {
    const res = await this.fetch(this.server + route, {
      method,
      headers: this.#headers(),
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(45000),
    });
    let data = {};
    try {
      data = await res.json();
    } catch {}
    return { status: res.status, data };
  }

  /** Leftovers of a crash: nothing in the work folder outlives a run. */
  sweep() {
    const kept = this.#keptFiles();
    if (!kept.size) return fs.rm(this.workDir, { recursive: true, force: true }, () => {});
    let names = [];
    try {
      names = fs.readdirSync(this.workDir);
    } catch {}
    for (const n of names) if (!kept.has(n)) fs.rm(path.join(this.workDir, n), { force: true }, () => {});
  }
}
