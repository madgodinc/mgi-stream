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
 * Emits: status {state, detail}, message {nick, text, spoken}, queue {size, dropped}.
 * A status carrying `soft: true` is a hiccup the run survived, not a stop.
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
    this.queue = [];
    this.busy = false;
    this.dropped = 0;
    this.running = false;
    this.retryTimer = null;
    this.connecting = false;
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
    this.speaker = new Speaker(cfg);

    await this.#serve(cfg.port);
    this.running = true;

    if (mock) {
      this.#startMock();
      this.emit("status", { state: "live", detail: "mock chat" });
      return;
    }
    await this.#connect(cfg);
  }

  async stop() {
    this.running = false;
    clearInterval(this.mockTimer);
    clearTimeout(this.retryTimer);
    this.mockTimer = null;
    this.retryTimer = null;
    this.queue = [];

    try {
      await this.conn?.disconnect();
    } catch {
      // Disconnecting a socket that already died is not worth reporting.
    }
    this.conn = null;

    await new Promise((done) => (this.wss ? this.wss.close(done) : done()));
    await new Promise((done) => (this.http ? this.http.close(done) : done()));
    this.wss = null;
    this.http = null;
    this.emit("status", { state: "off", detail: "" });
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
        this.emit("status", {
          state: "error",
          code: taken ? "portTaken" : undefined,
          arg: taken ? port : undefined,
          detail: err.message,
        });
        reject(err);
      });
      this.http.listen(port, () => resolve());
    });
  }

  #broadcast(msg) {
    if (!this.wss) return;
    const payload = JSON.stringify(msg);
    for (const client of this.wss.clients) if (client.readyState === 1) client.send(payload);
  }

  // ── chat source ────────────────────────────────────────────────────────────

  async #connect(cfg) {
    this.emit("status", { state: "connecting", detail: cfg.username });

    // The second argument is required: the constructor reads fields off it unguarded.
    this.conn = new TikTokLiveConnection(cfg.username, { signApiKey: cfg.signApiKey || undefined });

    this.conn.on(WebcastEvent.CHAT, (ev) => {
      const nick = ev?.user?.nickname || ev?.user?.uniqueId || "someone";
      // v3 of the protocol carries the text in `content`; older payloads use `comment`.
      const text = ev?.content ?? ev?.comment ?? "";
      if (text) this.#onChat(nick, text, ev?.userIdentity ?? {});
    });
    this.conn.on(WebcastEvent.STREAM_END, () => this.#retry(cfg, { code: "ended" }));
    this.conn.on(ControlEvent.DISCONNECTED, () => this.#retry(cfg, { code: "dropped" }));
    // A failed handshake reports itself twice, as an event and as a rejection.
    // The rejection carries the better message, so the event stays quiet until
    // the connection is up and its errors are news.
    this.conn.on("error", (err) => {
      if (!this.connecting && !this.retryTimer) {
        this.emit("status", { state: "error", soft: true, detail: describe(err) });
      }
    });

    try {
      this.connecting = true;
      const state = await this.conn.connect();
      this.emit("status", { state: "live", detail: `room ${state.roomId}` });
    } catch (err) {
      // A wrong channel name never starts working on its own; everything else
      // does, so it goes back in the queue instead of stopping the run.
      if (err?.name === "InvalidUniqueIdError") {
        this.emit("status", { state: "error", code: "badChannel", arg: cfg.username, detail: describe(err) });
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

    // Detach before closing: disconnect() fires DISCONNECTED and would land here again.
    const dead = this.conn;
    this.conn = null;
    dead?.removeAllListeners();
    Promise.resolve(dead?.disconnect()).catch(() => {});

    this.emit("status", { state: "waiting", code, arg: arg ?? cfg.username });

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.running) this.#connect(cfg).catch(() => {});
    }, RETRY_MS);
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
    this.mockTimer = setInterval(() => this.#onChat(...samples[i++ % samples.length]), 5000);
  }

  // ── speech queue ───────────────────────────────────────────────────────────

  #onChat(nick, text, identity = {}) {
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
    this.queue.push({ nick, text, phrase });
    this.emit("queue", { size: this.queue.length, dropped: this.dropped });
    this.#drain();
  }

  async #drain() {
    if (this.busy || !this.queue.length || !this.running) return;
    this.busy = true;
    const item = this.queue.shift();

    try {
      const mp3 = await this.speaker.synth(item.phrase);
      if (this.running) {
        const payload = { kind: "speak", nick: item.nick, text: item.text, audio: mp3.toString("base64") };
        this.#broadcast(payload);
        this.emit("speak", payload);
      }
    } catch (err) {
      this.emit("status", { state: "error", code: "speech", arg: err.message, detail: err.message });
    }

    this.emit("queue", { size: this.queue.length, dropped: this.dropped });
    this.busy = false;
    this.#drain();
  }
}
