import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { WebSocketServer } from "ws";
import { TikTokLiveConnection, WebcastEvent, ControlEvent } from "tiktok-live-connector";
import { Speaker } from "./tts.js";
import { decide } from "./filter.js";
import { parseGift, viewer, likes } from "./gifts.js";
import { GAMES_PATH, readGamesMessage, isGameCommand } from "./games-feed.js";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".woff2": "font/woff2",
  ".mp4": "video/mp4",
  ".m4a": "audio/mp4",
  ".webm": "video/webm",
  ".opus": "audio/ogg",
  ".mp3": "audio/mpeg",
};
const RETRY_MS = 15000;
/** How long one connection attempt may take before it counts as failed. */
const CONNECT_MS = 30000;

/**
 * TikTok's timestamps come from TikTok's clock, not this machine's. A few
 * seconds of slack keeps a genuinely new message from being mistaken for
 * history; the backlog it has to reject is minutes old, so the margin is safe.
 */
const CLOCK_SLACK_MS = 5000;

/**
 * A reconnect can overlap the socket it replaces, and the room itself sometimes
 * repeats a line. Either way the same message arrives twice, and a comment read
 * out loud twice is the most audible bug this app has, so the ids that were
 * spoken recently are remembered and a repeat is dropped.
 */
const RECENT_IDS = 400;

export class RecentIds {
  constructor(limit = RECENT_IDS) {
    this.limit = limit;
    this.ids = new Set();
  }

  /** True the first time an id is offered; false for every repeat after that. */
  fresh(id) {
    // A message with no id is let through: going silent is worse than a rare double.
    if (!id) return true;
    if (this.ids.has(id)) return false;
    this.ids.add(id);
    // A Set keeps insertion order, so the first entry is the oldest.
    if (this.ids.size > this.limit) this.ids.delete(this.ids.values().next().value);
    return true;
  }
}

/** The connector throws plain Errors but emits bare objects, so String() alone gives "[object Object]". */
function describe(err) {
  const text = err?.message ?? err?.error?.message ?? err?.exception?.message ?? String(err ?? "");
  if (text !== "[object Object]") return text;
  try {
    return JSON.stringify(err).slice(0, 160);
  } catch {
    return "unknown error";
  }
}

/** "The requested user isn't online :(" — the room simply has not started yet. */
const OFFLINE = /offline|isn'?t\s+online|not\s+online|not\s+live|has\s+ended/i;

/**
 * Owns everything that runs while the app is "on air": the chat connection, the
 * speech queue, and the local HTTP/WebSocket server that feeds the OBS overlay.
 *
 * Emits: status {state, detail}, message {nick, text, spoken}, queue {size, dropped}, gift {..., fresh},
 * speak {nick, text, audio}, unspoken {nick, text, error}.
 * A status carrying `soft: true` is a hiccup the run survived, not a stop.
 * Speech failures are always soft: a phrase that cannot be voiced is skipped
 * and the chat connection and overlay keep running.
 *
 * A WebSocket opened at /games is MGI Games (games-feed.js), not an overlay:
 * it gets the room as data and never the overlay's messages, and the overlay
 * never sees what goes to it.
 */
export class StreamServer extends EventEmitter {
  /** `fontDir` lets the overlays use the window's fonts; `music`, `pet` and `banks` are optional. */
  constructor(overlayDir, { fontDir = null, music = null, pet = null, banks = null, version = "", matcher = null } = {}) {
    super();
    this.version = version;
    this.matcher = matcher;
    this.gamesClients = new Set();
    // Chat words MGI Games treats as commands: never read out, whatever the prefix setting.
    this.gameCommands = [];
    this.onAir = false;
    this.overlayDir = overlayDir;
    this.fontDir = fontDir;
    this.music = music;
    this.pet = pet;
    this.banks = banks;
    if (pet) pet.send = (m) => this.#broadcast(m);
    if (music) this.#wireMusic(music);
    if (banks) {
      // The jar by the slime follows every coin; a fill gets its own moment.
      banks.on("change", () => this.#broadcast(banks.viewerState()));
      banks.on("fill", (f) => this.#broadcast({ kind: "bank-fill", id: f.bank, name: f.name, nick: f.nick, goal: f.goal }));
    }
    this.giftSeen = new RecentIds();
    this.cfg = null;
    this.http = null;
    this.wss = null;
    this.conn = null;
    this.speaker = null;
    this.seen = new RecentIds();
    this.queue = [];
    this.busy = false;
    this.dropped = 0;
    this.running = false;
    this.retryTimer = null;
    this.connecting = false;
    // The last "live" status, put back once speech recovers from a failure.
    this.liveStatus = null;
    this.speechFailing = false;
  }

  get overlayUrl() {
    return this.cfg ? `http://localhost:${this.cfg.port}` : "";
  }

  /** The music overlay is a page of its own, so it can sit anywhere in the scene. */
  get musicUrl() {
    return this.cfg ? `http://localhost:${this.cfg.port}/music` : "";
  }

  /** What the app window plays: the same loopback server, so OBS and the window share one file. */
  mediaUrl(uid) {
    return this.cfg ? `http://127.0.0.1:${this.cfg.port}/media/${uid}` : "";
  }

  #wireMusic(music) {
    music.on("play", ({ track }) => {
      this.#broadcast({ kind: "music-play", track, src: `/media/${track.uid}` });
      this.pet?.music(track);
    });
    music.on("stop", () => {
      this.#broadcast({ kind: "music-stop" });
      this.pet?.music(null);
    });
    music.on("note", (n) => this.#broadcast({ kind: "music-note", ...n }));
    music.on("song", ({ track }) => this.#broadcast({ kind: "music-song", track }));
    music.on("change", (state) => this.#broadcast({ kind: "music-queue", next: state.queue.slice(0, 3), votes: state.votes }));
  }

  /** The window's playback position, passed on so the overlay's picture keeps up. */
  musicSync(uid, position, paused) {
    this.music?.progress(uid, position, paused);
    this.#broadcast({ kind: "music-sync", uid, position, paused, at: Date.now() });
  }

  async start(cfg, { mock = false } = {}) {
    if (this.running) await this.stop();
    this.cfg = cfg;
    this.queue = [];
    this.dropped = 0;
    this.busy = false;
    // A fresh run is a fresh room: nothing said before it counts as already heard.
    this.seen = new RecentIds();
    this.giftSeen = new RecentIds();
    this.speaker = new Speaker(cfg);
    this.speechFailing = false;
    this.onAir = false;

    await this.#serve(cfg.port);
    this.running = true;
    this.music?.configure(cfg.music);
    this.music?.setLive(true);
    this.pet?.configure(cfg.pet, cfg.lang);
    this.pet?.start();

    if (mock) {
      this.#startMock();
      this.#live({ state: "live", detail: "mock chat" });
      return;
    }
    // A cold voice takes its slow first request now, not on the first chat line.
    this.speaker.warm();
    await this.#connect(cfg);
  }

  #status(status) {
    // A soft hiccup is not the room going away.
    const on = status.state === "live";
    if (!status.soft && on !== this.onAir) {
      this.onAir = on;
      this.#games({ kind: "live", on });
    }
    this.shown = status;
    this.emit("status", status);
  }

  #live(status) {
    this.liveStatus = status;
    this.#status(status);
  }

  async stop() {
    this.running = false;
    this.music?.setLive(false);
    this.pet?.stop();
    clearInterval(this.mockTimer);
    clearTimeout(this.retryTimer);
    this.mockTimer = null;
    this.retryTimer = null;
    this.queue = [];

    await this.#drop(this.conn);

    // An OBS browser source holds its WebSocket open, and closing the ws server
    // does not close the sockets it accepted. Without this, http.close() waits
    // for a connection that never ends and "stop" hangs, taking window close
    // with it.
    for (const client of this.wss?.clients ?? []) client.terminate();
    await new Promise((done) => (this.wss ? this.wss.close(done) : done()));
    this.http?.closeAllConnections?.();
    await new Promise((done) => (this.http ? this.http.close(done) : done()));
    this.wss = null;
    this.http = null;
    this.#status({ state: "off", detail: "" });
  }

  /**
   * Applies edited settings to a session that is already running: who gets read,
   * what counts as noise, which voice says it. Channel and port are the two that
   * still need a restart, so they keep their current values.
   */
  update(cfg) {
    if (!this.running || !this.cfg) return;
    const revoiced =
      ["voice", "rate", "pitch", "nickRate", "nickPause", "mgiUrl", "mgiKey"].some((k) => cfg[k] !== this.cfg[k]);
    this.cfg = { ...cfg, username: this.cfg.username, port: this.cfg.port };
    if (revoiced) this.speaker = new Speaker(this.cfg);
    this.music?.configure(cfg.music);
    this.pet?.configure(cfg.pet, cfg.lang);
    this.#broadcast(this.#audio());
  }

  /** Levels and devices for the sound helpers: the stream copy and the headphone copy. */
  #audio() {
    const c = this.cfg ?? {};
    const m = c.music ?? {};
    return {
      kind: "audio",
      voice: c.voiceVolume ?? 100,
      voiceMonitor: c.voiceMonitor ?? 0,
      music: m.muted ? 0 : (m.volume ?? 70),
      musicMonitor: m.muted ? 0 : (m.monitor ?? 0),
      duck: m.duck !== false,
      playInApp: c.playInApp !== false,
      streamDevice: c.streamDevice ?? "",
      monitorDevice: c.monitorDevice ?? "",
    };
  }

  /** The app is reading a message out: the music steps back everywhere it plays. */
  duck(on) {
    this.#broadcast({ kind: "duck", on: Boolean(on) });
  }

  // ── local server for the OBS overlay ────────────────────────────────────────

  #serve(port) {
    return new Promise((resolve, reject) => {
      this.http = http.createServer((req, res) => {
        const url = (req.url || "/").split("?")[0];
        const media = url.match(/^\/media\/(\d+)$/);
        if (media) return this.#sendMedia(req, res, Number(media[1]));
        const font = /^\/fonts\/[\w.-]+\.woff2$/.test(url);
        const dir = font && this.fontDir ? this.fontDir : this.overlayDir;
        let name = url === "/" ? "index.html" : path.basename(url);
        if (!path.extname(name)) name += ".html";
        fs.readFile(path.join(dir, name), (err, data) => {
          if (err) return res.writeHead(404).end("not found");
          res.writeHead(200, { "content-type": MIME[path.extname(name)] ?? "application/octet-stream" });
          res.end(data);
        });
      });

      // Overlays send nothing and MGI Games sends small JSON; nobody needs ws's 100 MB default.
      this.wss = new WebSocketServer({ server: this.http, maxPayload: 64 * 1024 });
      this.wss.on("connection", (ws, req) => {
        if ((req?.url || "/").split("?")[0] === GAMES_PATH) return this.#gamesClient(ws);
        ws.send(JSON.stringify({ kind: "hello", username: this.cfg.username, voice: this.cfg.voice, lang: this.cfg.lang }));
        ws.send(JSON.stringify(this.#audio()));
        if (this.pet) ws.send(JSON.stringify({ kind: "pet-cfg", ...this.pet.cfg }));
        if (this.banks) ws.send(JSON.stringify(this.banks.viewerState()));
        // An overlay that joins mid-track (OBS scene switch, source refresh) picks the track up.
        const now = this.music?.snapshot();
        // What comes next, for a window that opens mid-track.
        if (now) ws.send(JSON.stringify({ kind: "music-queue", next: now.queue.slice(0, 3), votes: now.votes }));
        if (now?.current) {
          ws.send(JSON.stringify({ kind: "music-play", track: now.current, src: `/media/${now.current.uid}` }));
          ws.send(JSON.stringify({ kind: "music-sync", uid: now.current.uid, position: now.position, paused: now.paused, at: Date.now() }));
        }
      });

      this.http.once("error", (err) => {
        const taken = err.code === "EADDRINUSE";
        this.#status({
          state: "error",
          code: taken ? "portTaken" : undefined,
          arg: taken ? port : undefined,
          detail: err.message,
        });
        reject(err);
      });
      // Loopback only. The overlay is for OBS on this machine, and the readme
      // promises the page is not reachable from the rest of the network.
      this.http.listen(port, "127.0.0.1", () => resolve());
    });
  }

  /** A music file, with Range: a video element seeks by asking for byte ranges. */
  #sendMedia(req, res, uid) {
    const track = this.music?.fileOf(uid);
    if (!track) return res.writeHead(404).end("not found");
    let size;
    try {
      size = fs.statSync(track.file).size;
    } catch {
      return res.writeHead(404).end("not found");
    }
    const type = MIME["." + track.ext] ?? "application/octet-stream";
    const m = String(req.headers.range ?? "").match(/^bytes=(\d*)-(\d*)$/);
    if (!m || (!m[1] && !m[2])) {
      res.writeHead(200, { "content-type": type, "content-length": size, "accept-ranges": "bytes", "cache-control": "no-store" });
      return fs.createReadStream(track.file).pipe(res);
    }
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      return res.writeHead(416, { "content-range": `bytes */${size}` }).end();
    }
    res.writeHead(206, {
      "content-type": type,
      "content-length": end - start + 1,
      "content-range": `bytes ${start}-${end}/${size}`,
      "accept-ranges": "bytes",
      "cache-control": "no-store",
    });
    fs.createReadStream(track.file, { start, end }).pipe(res);
  }

  #broadcast(msg) {
    if (!this.wss) return;
    const payload = JSON.stringify(msg);
    for (const client of this.wss.clients) {
      if (client.readyState === 1 && !this.gamesClients.has(client)) client.send(payload);
    }
  }

  // ── MGI Games ──────────────────────────────────────────────────────────────

  #gamesClient(ws) {
    this.gamesClients.add(ws);
    ws.on("close", () => {
      this.gamesClients.delete(ws);
      // Prices of a shop that is gone are not worth showing.
      if (!this.gamesClients.size) {
        this.pet?.hints([]);
        this.gameCommands = [];
      }
    });
    ws.on("error", () => {});
    ws.on("message", (raw) => this.gamesMessage(raw, ws));
    ws.send(JSON.stringify({ kind: "hello", app: "mgi-stream", version: this.version, username: this.cfg.username, live: this.onAir }));
  }

  /** One message from MGI Games, raw from the socket; what does not parse is ignored. */
  gamesMessage(raw, ws = null) {
    const m = readGamesMessage(raw);
    if (m?.kind === "match") return this.#match(m, ws);
    if (m?.kind === "say") this.pet?.say(m.nick ? `${m.nick}: ${m.text}` : m.text);
    else if (m?.kind === "hints") this.pet?.hints(m.lines);
    else if (m?.kind === "commands") this.gameCommands = m.prefixes;
  }

  /** Asks the match service (opts.matcher, it holds the account) and answers the asking client only. */
  async #match({ rid, game, text }, ws) {
    let answer;
    try {
      if (!this.matcher) throw new Error("noMatcher");
      answer = { ok: true, ...(await this.matcher(game, text)) };
    } catch (err) {
      answer = { ok: false, error: String(err?.message ?? err) };
    }
    if (ws?.readyState === 1) ws.send(JSON.stringify({ kind: "matched", rid, ...answer }));
  }

  #games(msg) {
    if (!this.gamesClients.size) return;
    const payload = JSON.stringify(msg);
    for (const client of this.gamesClients) if (client.readyState === 1) client.send(payload);
  }

  // ── chat source ────────────────────────────────────────────────────────────

  async #connect(cfg) {
    this.#status({ state: "connecting", detail: cfg.username });

    // The second argument is required: the constructor reads fields off it unguarded.
    // `processInitialData` replays the batch of messages TikTok hands over on
    // connect, which is chat that already scrolled past. Reading it out loud
    // means the voice starts minutes behind the room, and after a dropped
    // socket it repeats what the viewers just heard, so only live chat counts.
    const conn = new TikTokLiveConnection(cfg.username, {
      signApiKey: cfg.signApiKey || undefined,
      processInitialData: false,
    });
    this.conn = conn;

    /**
     * Joining a room hands over the chat that already scrolled past, and the
     * socket does it again on every reconnect. Read out loud that is a voice
     * starting minutes behind the picture, then repeating what the viewers
     * already heard the moment the connection blinks. Only what was said after
     * this attempt began counts as live.
     *
     * `processInitialData: false` above drops one of the two copies TikTok
     * sends; the timestamp drops the history itself.
     */
    const liveFrom = Date.now() - CLOCK_SLACK_MS;

    // Every handler checks that its own socket is still the one in use. An
    // attempt that was replaced or stopped is not allowed to speak, report, or
    // schedule anything on behalf of the run that moved on without it.
    const current = () => conn === this.conn;

    conn.on(WebcastEvent.CHAT, (ev) => {
      if (!current()) return;
      const { nick, ...who } = viewer(ev?.user);
      // v3 of the protocol carries the text in `content`; older payloads use `comment`.
      const text = ev?.content ?? ev?.comment ?? "";
      // A message with no timestamp is passed through: losing live chat is the
      // worse failure of the two.
      const said = Number(ev?.common?.createTime ?? ev?.createTime ?? 0);
      if (said && said < liveFrom) return;
      if (!this.seen.fresh(String(ev?.common?.msgId ?? ev?.msgId ?? ""))) return;
      if (text) this.onChat(nick, text, ev?.userIdentity ?? {}, who);
    });
    // What the room does besides talking feeds the slime in the music window.
    const fresh = (ev) => {
      const at = Number(ev?.common?.createTime ?? ev?.createTime ?? 0);
      return !at || at >= liveFrom;
    };
    conn.on(WebcastEvent.GIFT, (ev) => {
      if (!current() || !fresh(ev)) return;
      const g = parseGift(ev);
      // A tap the overlapping reconnect delivered twice would count its coins twice.
      if (!this.giftSeen.fresh(g.key)) return;
      this.onGift(g);
    });
    conn.on(WebcastEvent.LIKE, (ev) => current() && fresh(ev) && this.onLike(viewer(ev?.user), likes(ev)));
    conn.on(WebcastEvent.FOLLOW, (ev) => current() && fresh(ev) && this.onFollow(viewer(ev?.user)));
    conn.on(WebcastEvent.SHARE, (ev) => current() && fresh(ev) && this.onShare(viewer(ev?.user)));
    conn.on(WebcastEvent.STREAM_END, () => current() && this.#retry(cfg, { code: "ended" }));
    conn.on(ControlEvent.DISCONNECTED, () => current() && this.#retry(cfg, { code: "dropped" }));
    // A failed handshake reports itself twice, as an event and as a rejection.
    // The rejection carries the better message, so the event stays quiet until
    // the connection is up and its errors are news.
    conn.on("error", (err) => {
      if (current() && !this.connecting && !this.retryTimer) {
        this.#status({ state: "error", soft: true, detail: describe(err) });
      }
    });

    try {
      this.connecting = true;
      // A handshake TikTok never answers would hold the app in "connecting"
      // for the whole stream, deaf to chat; past the limit it is a failed try.
      let timer;
      const state = await Promise.race([
        conn.connect(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("TikTok did not answer the connection")), CONNECT_MS);
        }),
      ]).finally(() => clearTimeout(timer));
      // The run may have been stopped or restarted while the handshake was in
      // flight; the socket it produced belongs to nobody, so it goes.
      if (!current()) return void this.#drop(conn);
      this.#live({ state: "live", detail: `room ${state.roomId}` });
    } catch (err) {
      // The attempt is finished either way. Detaching it here is what keeps a
      // dead socket from delivering chat into the next attempt: every message
      // it still had would be read out a second time.
      this.#drop(conn);

      // A wrong channel name never starts working on its own; everything else
      // does, so it goes back in the queue instead of stopping the run.
      if (err?.name === "InvalidUniqueIdError") {
        this.#status({ state: "error", code: "badChannel", arg: cfg.username, detail: describe(err) });
        throw err;
      }
      const reason = describe(err);
      const offline = err?.name === "UserOfflineError" || OFFLINE.test(reason);
      this.#retry(cfg, offline ? { code: "waitLive" } : { code: "retrying", arg: reason });
    } finally {
      this.connecting = false;
    }
  }

  /**
   * A live room is a moving target: it may not have started yet, and TikTok
   * drops the socket often enough on mobile that one attempt is not a connection.
   * So the app sits in `waiting` and keeps knocking until stopped by hand.
   */
  #retry(cfg, { code, arg }) {
    if (!this.running || this.retryTimer) return;

    this.#drop(this.conn);

    this.#status({ state: "waiting", code, arg: arg ?? cfg.username });

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.running) this.#connect(cfg).catch(() => {});
    }, RETRY_MS);
  }

  /**
   * Retires one connection: listeners first, so the disconnect it triggers has
   * nothing left to talk to, and so a socket that outlives the call can no
   * longer feed chat into the run that replaced it.
   */
  #drop(conn) {
    if (!conn) return Promise.resolve();
    if (conn === this.conn) this.conn = null;
    conn.removeAllListeners();
    // Disconnecting a socket that already died is not worth reporting.
    return Promise.resolve(conn.disconnect()).catch(() => {});
  }

  #startMock() {
    const mod = { isModeratorOfAnchor: true };
    const sub = { isSubscriberOfAnchor: true };
    const fan = { isFollowerOfAnchor: true };
    // Fake handles and account ids, so MGI Games can keep wallets in the demo too.
    const as = (nick, id, uid) => ({ nick, id, uid });
    const mad = as("mad_god", "mad_god", "7000000000000000001");
    const anon = as("анон228", "anon228", "7000000000000000002");
    const viewer01 = as("viewer_01", "viewer_01", "7000000000000000003");
    const spammer = as("spammer", "spam_bot_1", "7000000000000000004");
    const kate = as("Катя", "katya.plays", "7000000000000000005");
    const newcomer = as("новенький", "new_one_42", "7000000000000000006");
    const samples = [
      [mad, "привет чат, проверка озвучки", mod],
      [anon, "а какой это голос?", {}],
      [viewer01, "🔥🔥🔥", fan],
      [spammer, "заходи на www.spam.com", {}],
      [kate, "!сколько ты уже стримишь сегодня", sub],
    ];
    const chat = ([{ nick, ...who }, text, identity]) => this.onChat(nick, text, identity, who);
    let i = 0;
    this.mockTimer = setInterval(() => {
      chat(samples[i % samples.length]);
      // Every other tick the room does something else: a rose combo, likes, a follow, a big gift.
      const extra = i++ % 8;
      if (extra === 1) for (let n = 1; n <= 7; n++) this.onGift({ ...kate, giftId: 5655, name: "Rose", diamonds: 1, count: n, streakable: true, end: n === 7 });
      if (extra === 3) this.onLike(viewer01, 80);
      if (extra === 5) {
        this.onFollow(newcomer);
        this.onShare(newcomer);
      }
      if (extra === 7) this.onGift({ ...mad, giftId: 7934, name: "Galaxy", diamonds: 1000, count: 1, streakable: false, end: true });
    }, 5000);
  }

  /**
   * Every gift event enters here (gifts.js parseGift shape), from TikTok, the
   * demo timer or a test. The slime thanks per streak; the banks count every
   * new gift at once; `gift` tells the app how many were new, for gift rules.
   */
  onGift(g) {
    this.pet?.gift(g);
    const fresh = this.banks ? this.banks.gift(g) : g.streakable && !g.end ? 0 : g.count;
    if (fresh <= 0) return;
    this.emit("gift", { ...g, fresh });
    this.#games({
      kind: "gift",
      id: g.id ?? "",
      uid: g.uid ?? "",
      nick: g.nick,
      gift: g.name,
      giftId: g.giftId ?? null,
      coins: g.diamonds,
      count: fresh,
      at: Date.now(),
    });
  }

  /** Likes and follows enter here, from TikTok or the demo timer; `who` is gifts.js viewer(). */
  onLike(who, n = 1) {
    this.#games({ kind: "like", id: who.id ?? "", uid: who.uid ?? "", nick: who.nick, count: n, at: Date.now() });
    this.pet?.like(who.nick, n);
  }

  onFollow(who) {
    this.#games({ kind: "follow", id: who.id ?? "", uid: who.uid ?? "", nick: who.nick, at: Date.now() });
    this.pet?.follow(who.nick);
  }

  onShare(who) {
    this.#games({ kind: "share", id: who.id ?? "", uid: who.uid ?? "", nick: who.nick, at: Date.now() });
    this.pet?.share(who.nick);
  }

  // ── speech queue ───────────────────────────────────────────────────────────

  /**
   * Every chat line enters here, from TikTok, the demo timer or a test.
   * `who` is the viewer's {id, uid} (gifts.js viewer), for MGI Games.
   */
  onChat(nick, text, identity = {}, who = {}) {
    this.#games({ kind: "chat", id: who.id ?? "", uid: who.uid ?? "", nick, text, at: Date.now() });
    this.pet?.chat();
    // A music command is an order, not a message to read out.
    const order = this.music?.onChat(nick, text, identity);
    if (order) {
      this.emit("message", { nick, text, spoken: false, reason: order });
      return;
    }
    if (isGameCommand(this.gameCommands, text)) {
      this.emit("message", { nick, text, spoken: false, reason: "game" });
      return;
    }
    const verdict = decide(this.cfg, { nick, text, identity });
    this.emit("message", {
      nick,
      text,
      spoken: verdict.speak,
      reason: verdict.reason,
      arg: verdict.arg,
    });
    if (!verdict.speak) return;
    const phrase = verdict.phrase;

    // Chat outruns speech. Without a cap the voice drifts minutes behind the
    // stream and never recovers, so the oldest pending message goes overboard.
    if (this.queue.length >= this.cfg.maxQueue) {
      this.queue.shift();
      this.dropped++;
    }
    this.queue.push({ nick, text, phrase, lead: verdict.lead, body: verdict.body });
    this.emit("queue", { size: this.queue.length, dropped: this.dropped });
    this.#drain();
  }

  async #drain() {
    if (this.busy || !this.queue.length || !this.running) return;
    this.busy = true;
    const item = this.queue.shift();

    try {
      const mp3 = await this.speaker.synth(item.lead ? { lead: item.lead, body: item.body } : item.phrase);
      if (this.speechFailing && this.running) {
        this.speechFailing = false;
        // Only undo our own complaint; a reconnect in progress keeps its status.
        if (this.shown?.code === "speech" && this.liveStatus) this.#status(this.liveStatus);
      }
      if (this.running) {
        const payload = { kind: "speak", nick: item.nick, text: item.text, audio: mp3.toString("base64") };
        this.#broadcast(payload);
        // The app window needs the event to mark the row, but the audio with it
        // only when it is the one doing the talking.
        this.emit("speak", this.cfg.playInApp ? payload : { ...payload, audio: "" });
      }
    } catch (err) {
      // Skip the phrase, never the session.
      if (this.running) {
        this.speechFailing = true;
        this.emit("unspoken", { nick: item.nick, text: item.text, error: err.message });
        this.#status({ state: "error", soft: true, code: "speech", arg: err.message, detail: err.message });
      }
    }

    this.emit("queue", { size: this.queue.length, dropped: this.dropped });
    this.busy = false;
    this.#drain();
  }
}
