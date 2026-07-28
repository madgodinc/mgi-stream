import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { TikTokLiveConnection, WebcastEvent } from "tiktok-live-connector";
import { Speaker } from "./tts.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const MOCK = process.argv.includes("--mock");

const configPath = path.join(here, "config.json");
if (!fs.existsSync(configPath)) {
  console.error("config.json is missing. Copy config.example.json to config.json and set your username.");
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));

// ── filter ────────────────────────────────────────────────────────────────────

const EMOJI_ONLY = /^[\p{Extended_Pictographic}\p{Emoji_Component}\s]+$/u;
const LINK = /(https?:\/\/|www\.|\.(com|ru|net|org|io|me)\b)/i;

/** Returns the phrase to speak, or null when the message should stay silent. */
function toPhrase(nick, text) {
  const t = text.trim();
  if (t.length < cfg.minChars) return null;
  if (cfg.ignoreUsers.some((u) => u.toLowerCase() === nick.toLowerCase())) return null;
  if (cfg.skipEmojiOnly && EMOJI_ONLY.test(t)) return null;
  if (cfg.skipLinks && LINK.test(t)) return null;

  const body = t.length > cfg.maxChars ? t.slice(0, cfg.maxChars) + "…" : t;
  return cfg.sayNickname ? cfg.nicknameTemplate.replace("{nick}", nick) + " " + body : body;
}

// ── speech queue ──────────────────────────────────────────────────────────────

const speaker = new Speaker(cfg);
const queue = [];
let busy = false;
let dropped = 0;

function enqueue(item) {
  // A busy chat produces messages faster than they can be read out loud. Without
  // a cap the voice drifts minutes behind the stream, so drop the oldest instead.
  if (queue.length >= cfg.maxQueue) {
    queue.shift();
    dropped++;
    broadcast({ kind: "dropped", total: dropped });
  }
  queue.push(item);
  broadcast({ kind: "queued", nick: item.nick, text: item.text, size: queue.length });
  drain();
}

async function drain() {
  if (busy || !queue.length) return;
  busy = true;
  const item = queue.shift();
  try {
    const mp3 = await speaker.synth(item.phrase);
    broadcast({
      kind: "speak",
      nick: item.nick,
      text: item.text,
      audio: mp3.toString("base64"),
      size: queue.length,
    });
  } catch (err) {
    console.error("Synthesis failed:", err.message);
    broadcast({ kind: "error", text: `synthesis failed: ${err.message}` });
  }
  busy = false;
  drain();
}

// ── browser source ────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const requested = req.url === "/" || req.url.startsWith("/?") ? "index.html" : req.url.slice(1);
  const full = path.join(here, "public", path.basename(requested));
  fs.readFile(full, (err, data) => {
    if (err) return res.writeHead(404).end("not found");
    const type = full.endsWith(".html") ? "text/html; charset=utf-8" : "text/plain";
    res.writeHead(200, { "content-type": type });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

function broadcast(msg) {
  const payload = JSON.stringify(msg);
  for (const client of wss.clients) if (client.readyState === 1) client.send(payload);
}

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ kind: "hello", username: cfg.username, voice: cfg.voice, mock: MOCK }));
});

server.listen(cfg.port, () => {
  console.log(`Browser source: http://localhost:${cfg.port}`);
  console.log(`Voice: ${cfg.voice}, nickname spoken: ${cfg.sayNickname ? "yes" : "no"}`);
});

// ── message source ────────────────────────────────────────────────────────────

function onChat(nick, text) {
  const phrase = toPhrase(nick, text);
  if (!phrase) return;
  enqueue({ nick, text, phrase });
}

if (MOCK) {
  const samples = [
    ["mad_god", "привет чат, проверка озвучки"],
    ["анон228", "а какой это голос?"],
    ["viewer_01", "🔥🔥🔥"],
    ["spammer", "заходи на www.spam.com"],
    ["Катя", "сколько ты уже стримишь сегодня"],
  ];
  let i = 0;
  console.log("Mock mode: no live chat, replaying sample messages every 6 seconds.");
  setInterval(() => onChat(...samples[i++ % samples.length]), 6000);
} else {
  // The second argument is required: the constructor reads fields off it unguarded.
  const conn = new TikTokLiveConnection(cfg.username, {
    signApiKey: cfg.signApiKey || undefined,
  });

  conn.on(WebcastEvent.CHAT, (ev) => {
    const nick = ev?.user?.nickname || ev?.user?.uniqueId || "someone";
    const text = ev?.comment ?? "";
    if (text) onChat(nick, text);
  });

  conn.on(WebcastEvent.STREAM_END, () => console.log("Stream ended."));
  conn.on("error", (err) => console.error("Connection error:", err?.message || err));

  conn
    .connect()
    .then((state) => console.log(`Connected to ${cfg.username}, room ${state.roomId}`))
    .catch((err) => {
      console.error(`Could not connect to ${cfg.username}: ${err.message}`);
      console.error("The stream has to be live. To try the pipeline without one: npm run mock");
    });
}
