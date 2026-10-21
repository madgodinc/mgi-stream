import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { WebSocketServer } from "ws";
import { TikTokLiveConnection, WebcastEvent, ControlEvent } from "tiktok-live-connector";
import { Speaker } from "./tts.js";
import { decide } from "./filter.js";

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript" };
const RETRY_MS = 15000;

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
 * Emits: status {state, detail}, message {nick, text, spoken}, queue {size, dropped},
 * speak {nick, text, audio}, unspoken {nick, text, error}.
 * A status carrying `soft: true` is a hiccup the run survived, not a stop.
 * Speech failures are always soft: a phrase that cannot be voiced is skipped
 * and the chat connection and overlay keep running.
 */
export class StreamServer extends EventEmitter {
  constructor(overlayDir) {
    super();
    this.overlayDir = overlayDir;
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

  async start(cfg, { mock = false } = {}) {
    if (this.running) await this.stop();
    this.cfg = cfg;
    this.queue = [];
    this.dropped = 0;
    this.busy = false;
    // A fresh run is a fresh room: nothing said before it counts as already heard.
    this.seen = new RecentIds();
    this.speaker = new Speaker(cfg);
    this.speechFailing = false;

    await this.#serve(cfg.port);
    this.running = true;

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
    this.shown = status;
    this.emit("status", status);
  }

  #live(status) {
    this.liveStatus = status;
    this.#status(status);
  }

  async stop() {
    this.running = false;
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
  }

  // ── local server for the OBS overlay ────────────────────────────────────────

  #serve(port) {
    return new Promise((resolve, reject) => {
      this.http = http.createServer((req, res) => {
        const url = (req.url || "/").split("?")[0];
        const name = url === "/" ? "index.html" : path.basename(url);
        fs.readFile(path.join(this.overlayDir, name), (err, data) => {
          if (err) return res.writeHead(404).end("not found");
          res.writeHead(200, { "content-type": MIME[path.extname(name)] ?? "application/octet-stream" });
          res.end(data);
        });
      });

      this.wss = new WebSocketServer({ server: this.http });
      this.wss.on("connection", (ws) => {
        ws.send(JSON.stringify({ kind: "hello", username: this.cfg.username, voice: this.cfg.voice }));
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

  #broadcast(msg) {
    if (!this.wss) return;
    const payload = JSON.stringify(msg);
    for (const client of this.wss.clients) if (client.readyState === 1) client.send(payload);
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
      const nick = ev?.user?.nickname || ev?.user?.uniqueId || "someone";
      // v3 of the protocol carries the text in `content`; older payloads use `comment`.
      const text = ev?.content ?? ev?.comment ?? "";
      // A message with no timestamp is passed through: losing live chat is the
      // worse failure of the two.
      const said = Number(ev?.common?.createTime ?? ev?.createTime ?? 0);
      if (said && said < liveFrom) return;
      if (!this.seen.fresh(String(ev?.common?.msgId ?? ev?.msgId ?? ""))) return;
      if (text) this.onChat(nick, text, ev?.userIdentity ?? {});
    });
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
      const state = await conn.connect();
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
    const samples = [
      ["mad_god", "привет чат, проверка озвучки", mod],
      ["анон228", "а какой это голос?", {}],
      ["viewer_01", "🔥🔥🔥", fan],
      ["spammer", "заходи на www.spam.com", {}],
      ["Катя", "!сколько ты уже стримишь сегодня", sub],
    ];
    let i = 0;
    this.mockTimer = setInterval(() => this.onChat(...samples[i++ % samples.length]), 5000);
  }

  // ── speech queue ───────────────────────────────────────────────────────────

  /** Every chat line enters here, from TikTok, the demo timer or a test. */
  onChat(nick, text, identity = {}) {
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
