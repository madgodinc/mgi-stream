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
 * middle. Nothing is cached on either side: the server deletes a file the
 * moment its last byte went out, this side deletes it after playing.
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
  constructor({ account, workDir, fetchImpl = fetch, server = SERVER }) {
    super();
    this.account = account;
    this.workDir = workDir;
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
    if (on) return;
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
      };
    return {
      current: view(this.current),
      paused: this.paused,
      position: this.position,
      votes: this.votes.size,
      queue: this.queue.map(view),
      pending: this.pending.map(view),
    };
  }

  #changed() {
    this.emit("change", this.snapshot());
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

  // ── downloads ──────────────────────────────────────────────────────────────

  /**
   * Plays the head of the queue once it is here, and keeps one download going
   * for the next track. The order is the streamer's, so a later track that
   * happens to arrive first still waits its turn.
   */
  #pump() {
    if (!this.live) return;
    const head = this.queue[0];
    if (!this.current && head?.state === "ready") {
      this.queue.shift();
      this.current = head;
      head.state = "playing";
      this.position = 0;
      this.paused = false;
      this.votes.clear();
      this.emit("play", { track: { ...this.snapshot().current, ext: head.ext } });
      this.#changed();
    }
    if (this.loading) return;
    const next = this.queue.find((t) => t.state === "queued");
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
    this.#changed();
    const video = this.cfg.mode === "video" && track.hasVideo;
    const start = await this.#api("POST", "/fetch", { id: track.id, video, max_height: this.cfg.maxHeight, max_duration: this.cfg.maxMinutes * 60 });
    if (start.status !== 200) throw new Error(start.data.error || `HTTP ${start.status}`);
    const job = start.data.job;
    track.video = Boolean(start.data.video);

    const until = Date.now() + JOB_TIMEOUT_MS;
    for (;;) {
      if (!this.#alive(track)) throw new Error("removed");
      const s = await this.#api("GET", `/job/${job}`);
      if (s.status !== 200) throw new Error(s.data.error || `HTTP ${s.status}`);
      if (s.data.state === "ready") break;
      if (s.data.state === "failed") throw new Error(s.data.error || "failed");
      if (s.data.total) track.progress = Math.min(0.99, s.data.done / s.data.total);
      this.#changed();
      if (Date.now() > until) throw new Error("timeout");
      await new Promise((r) => setTimeout(r, JOB_POLL_MS));
    }

    const res = await this.fetch(`${this.server}/file/${job}`, { headers: this.#headers(), signal: AbortSignal.timeout(JOB_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ext = (res.headers.get("x-media-ext") || (track.video ? "mp4" : "m4a")).replace(/[^a-z0-9]/gi, "");
    fs.mkdirSync(this.workDir, { recursive: true });
    const file = path.join(this.workDir, `${track.uid}.${ext}`);
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(file));
    if (!this.#alive(track)) {
      fs.rmSync(file, { force: true });
      throw new Error("removed");
    }
    track.file = file;
    track.ext = ext;
    track.progress = 1;
  }

  #alive(track) {
    return this.live && (this.queue.includes(track) || this.current === track);
  }

  #drop(track) {
    if (track?.file) fs.rm(track.file, { force: true }, () => {});
    if (track) track.file = null;
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
    fs.rm(this.workDir, { recursive: true, force: true }, () => {});
  }
}
