import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { WebSocketServer } from "ws";
import { TikTokLiveConnection, WebcastEvent } from "tiktok-live-connector";
import { Speaker } from "./tts.js";
import { decide } from "./filter.js";

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript" };

/**
 * Owns everything that runs while the app is "on air": the chat connection, the
 * speech queue, and the local HTTP/WebSocket server that feeds the OBS overlay.
 *
 * Emits: status {state, detail}, message {nick, text, spoken}, queue {size, dropped}.
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
    this.mockTimer = null;
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
        const detail =
          err.code === "EADDRINUSE"
            ? `port ${port} is taken, pick another one in settings`
            : err.message;
        this.emit("status", { state: "error", detail });
        reject(new Error(detail));
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
    this.conn.on(WebcastEvent.STREAM_END, () =>
      this.emit("status", { state: "off", detail: "the stream ended" }),
    );
    this.conn.on("error", (err) =>
      this.emit("status", { state: "error", detail: err?.message || String(err) }),
    );

    try {
      const state = await this.conn.connect();
      this.emit("status", { state: "live", detail: `room ${state.roomId}` });
    } catch (err) {
      const offline = /offline|not.*live/i.test(err.message);
      this.emit("status", {
        state: "error",
        detail: offline ? `${cfg.username} is not live right now` : err.message,
      });
      throw err;
    }
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
    this.emit("message", { nick, text, spoken: verdict.speak, reason: verdict.reason });
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
      this.emit("status", { state: "error", detail: `speech failed: ${err.message}` });
    }

    this.emit("queue", { size: this.queue.length, dropped: this.dropped });
    this.busy = false;
    this.#drain();
  }
}
