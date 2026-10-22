import crypto from "node:crypto";
import { WebSocket } from "ws";
import { MsEdgeTTS } from "msedge-tts";

// The Edge Read Aloud endpoint, spoken to directly. msedge-tts 2.0.7 (and 2.0.9)
// has no timeout, no XML escaping of the text and keeps a socket that the
// service drops, so speech goes through this small client and the library is
// only used for the voice list.
const TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
// Since 2026-10-12 speech.platform.bing.com answers the synthesis socket with
// a 403; the same service moved here and takes the token under another name.
const ENDPOINT = "wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1";
const GEC_VERSION = "1-143.0.3650.96";
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0",
  Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
  Pragma: "no-cache",
  "Cache-Control": "no-cache",
};
const FORMAT = "audio-24khz-48kbitrate-mono-mp3";

/*
 * Measured 2026-10-11: ru-RU-DmitryNeural, still in the voice list, answers
 * about 1 request in 8. The service closes the socket with 1006 ~2.5 s in,
 * before turn.end. Headers, cookies, the output format and the msedge-tts
 * version change nothing; Svetlana, Ava, Andrew answer 8/8. So a phrase gets
 * a couple of tries on its own voice, then goes to a fallback voice, and a
 * voice that keeps failing is skipped for a while instead of costing seconds
 * on every line.
 */
const ATTEMPTS = 2;
const FALLBACK_ATTEMPTS = 3;
const ATTEMPT_MS = 9000;
/** After this many phrases in a row the own voice could not say... */
const TRIP_AFTER = 2;
/** ...the next this many go straight to the fallback, then the own voice is tried again. */
const BENCH_FOR = 10;

// Multilingual voices read Russian (and most languages) and stayed reliable.
const FALLBACK = {
  "ru-RU-DmitryNeural": "en-US-AndrewMultilingualNeural",
  "ru-RU-SvetlanaNeural": "en-US-AvaMultilingualNeural",
  "en-US-AvaNeural": "en-US-AvaMultilingualNeural",
};
export const fallbackFor = (voice) =>
  FALLBACK[voice] ?? (voice === "en-US-AndrewMultilingualNeural" ? "en-US-AvaMultilingualNeural" : "en-US-AndrewMultilingualNeural");

const hex = (bytes) => crypto.randomBytes(bytes).toString("hex");

/** Sec-MS-GEC: SHA-256 of the 5-minute Windows tick plus the client token. */
function gec(now = Date.now()) {
  let ticks = Math.floor(now / 1000) + 11644473600;
  ticks -= ticks % 300;
  return crypto.createHash("sha256").update(`${ticks * 10000000}${TOKEN}`).digest("hex").toUpperCase();
}

export const escapeXml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

export function ssml(voice, prosody, text) {
  const lang = /^[a-z]{2,3}-[A-Z]{2}/.exec(voice)?.[0] ?? "en-US";
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${lang}">` +
    `<voice name="${escapeXml(voice)}"><prosody pitch="${prosody.pitch}" rate="${prosody.rate}" volume="+0%">` +
    `${escapeXml(text)}</prosody></voice></speak>`
  );
}

/*
 * The endpoint accepts exactly the SSML Edge itself sends: one prosody, no
 * <break> (checked 2026-10-21, anything more gets no answer at all). So a fast
 * nickname and a pause cannot live in one request. The nickname and the
 * message go as two requests at once, and the pause is silent mp3 frames
 * between them. Every clip is the same CBR format, so the parts join as is.
 *
 * One frame of FORMAT (MPEG-2 Layer III, 24 kHz, 48 kbit/s, mono) is 576
 * samples, 24 ms, 144 bytes; a header with zero side info decodes to silence.
 */
const FRAME_MS = 24;
const SILENT_FRAME = Buffer.concat([Buffer.from([0xff, 0xf3, 0x64, 0xc0]), Buffer.alloc(140)]);
export const silence = (ms) => Buffer.concat(Array(Math.round(Math.max(0, ms) / FRAME_MS)).fill(SILENT_FRAME));

/*
 * Our own voices (mgi:52.., mgi:57 is Mad) come from the MGI gateway as
 * 16-bit mono WAV with a bare 44-byte header, synthesized on our server.
 */
export const isMgi = (voice) => /^mgi:\d+$/.test(String(voice));
export const MGI_VOICES = [
  { id: "mgi:57", locale: "ru-RU", gender: "Male", name: "Мэд" },
  { id: "mgi:53", locale: "ru-RU", gender: "Male", name: "Артём" },
  { id: "mgi:56", locale: "ru-RU", gender: "Male", name: "Глеб" },
  { id: "mgi:52", locale: "ru-RU", gender: "Female", name: "Аня" },
  { id: "mgi:54", locale: "ru-RU", gender: "Female", name: "Лера" },
  { id: "mgi:55", locale: "ru-RU", gender: "Female", name: "Вера" },
];
const MGI_MS = 15000;

const isWav = (b) => b.length >= 44 && b.toString("latin1", 0, 4) === "RIFF";

function wav(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "latin1");
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVEfmt ", 8, "latin1");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "latin1");
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** Nickname clip, a pause, message clip: as samples for WAV, as frames for the Edge mp3. */
export function join(lead, body, pauseMs) {
  if (!isWav(lead)) return Buffer.concat([lead, silence(pauseMs), body]);
  const rate = lead.readUInt32LE(24);
  const gap = Buffer.alloc(Math.round((rate * Math.max(0, pauseMs)) / 1000) * 2);
  return wav(Buffer.concat([lead.subarray(44), gap, body.subarray(44)]), rate);
}

/*
 * Mad's voice (mgi:57) is also part of the MGI subscription: with no gateway
 * key, a signed-in account gets it from the MGI voice server, which asks the
 * gateway for it. Same WAV comes back, at the gateway's own sample rate.
 */
export const SUB_VOICES = { "mgi:57": "mad" };
export const VOICE_SERVER = "https://madgodinc.net/stream/api/tts";
let subscription = () => null;

/** `token()` gives the device token while the subscription is live, else null. */
export function useSubscription(token) {
  subscription = token;
}

export const hasSubscriptionVoice = () => Boolean(subscription());

/** The Edge rate string as one of the voice server's five speeds. */
export function rateStep(rate) {
  const speed = 1 + parseFloat(rate) / 100;
  return speed < 0.82 ? "x-slow" : speed < 0.94 ? "slow" : speed < 1.08 ? "medium" : speed < 1.22 ? "fast" : "x-fast";
}

function subscriptionRequest(token) {
  return async (voice, prosody, text, { timeoutMs = MGI_MS } = {}) => {
    const res = await fetch(VOICE_SERVER, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-MGI-Product": "tiktok" },
      body: JSON.stringify({ text, speaker: SUB_VOICES[voice], rate: rateStep(prosody.rate), format: "wav" }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`MGI voice ${res.status}: ${(await res.text()).slice(0, 120)}`);
    return Buffer.from(await res.arrayBuffer());
  };
}

/** Same contract as edgeRequest, against the MGI gateway's /v1/audio/speech. */
export function mgiRequest({ url, key }) {
  return async (voice, prosody, text, opts = {}) => {
    const token = !key && SUB_VOICES[voice] ? subscription() : null;
    if (token) return subscriptionRequest(token)(voice, prosody, text, opts);
    const { timeoutMs = MGI_MS } = opts;
    if (!key) throw new Error("no MGI key for our voices");
    const res = await fetch(`${url.replace(/\/+$/, "")}/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      // The Edge rate string the Speaker builds ("+48%") is the speed here too.
      body: JSON.stringify({ voice, input: text, response_format: "wav", speed: 1 + parseFloat(prosody.rate) / 100 }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`MGI voice ${res.status}: ${(await res.text()).slice(0, 120)}`);
    return Buffer.from(await res.arrayBuffer());
  };
}

/** One request on its own socket. Resolves with the mp3, rejects on any early close. */
export function edgeRequest(voice, prosody, text, { timeoutMs = ATTEMPT_MS, Socket = WebSocket } = {}) {
  return new Promise((resolve, reject) => {
    const url = `${ENDPOINT}?Ocp-Apim-Subscription-Key=${TOKEN}&Sec-MS-GEC=${gec()}&Sec-MS-GEC-Version=${GEC_VERSION}&ConnectionId=${hex(16)}`;
    const ws = new Socket(url, { headers: HEADERS });
    const chunks = [];
    let settled = false;
    const finish = (err, mp3) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.terminate?.() ?? ws.close();
      } catch {
        // already gone
      }
      err ? reject(err) : resolve(mp3);
    };
    const timer = setTimeout(() => finish(new Error(`no answer in ${timeoutMs} ms`)), timeoutMs);
    const stamp = () => new Date().toString();

    ws.on("open", () => {
      ws.send(
        `X-Timestamp:${stamp()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
          `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"${FORMAT}"}}}}\r\n`,
      );
      ws.send(
        `X-RequestId:${hex(16)}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${stamp()}Z\r\nPath:ssml\r\n\r\n` +
          ssml(voice, prosody, text),
      );
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        // Binary frames: 2-byte header length, the header, then audio.
        const headerLength = data.readUInt16BE(0);
        if (data.includes("Path:audio")) chunks.push(data.subarray(2 + headerLength));
        return;
      }
      if (String(data).includes("Path:turn.end")) {
        const mp3 = Buffer.concat(chunks);
        finish(mp3.length ? null : new Error("empty audio response"), mp3);
      }
    });
    ws.on("close", (code) => finish(new Error(`speech service closed the socket (${code}) before the end`)));
    ws.on("error", (err) => finish(err));
  });
}

/**
 * Turns phrases into audio with one voice (mp3 from Edge, WAV from our
 * gateway). Each attempt gets a fresh request. A
 * phrase its own voice cannot say goes to the fallback voice; one that fails
 * there too throws, and the caller skips it.
 */
export class Speaker {
  constructor(
    { voice, rate, pitch, nickRate = 0, nickPause = 0, mgiUrl = "", mgiKey = "" },
    { request, attempts = ATTEMPTS, fallback = fallbackFor(voice), fallbackAttempts = FALLBACK_ATTEMPTS } = {},
  ) {
    // Our voices go to the gateway, Edge ones (and the Edge fallback) to Edge.
    // A test passes one request for everything.
    const mgi = mgiRequest({ url: mgiUrl, key: mgiKey });
    request ??= (v, ...rest) => (isMgi(v) ? mgi : edgeRequest)(v, ...rest);
    this.voice = voice;
    // The API wants signed SSML units, the UI stores plain numbers.
    const signed = (n, unit) => `${n >= 0 ? "+" : ""}${n}${unit}`;
    this.prosody = {
      rate: signed(rate, "%"),
      pitch: signed(pitch, "Hz"),
      // The nickname speed is on top of the voice speed, not instead of it.
      leadRate: signed(rate + nickRate, "%"),
      pause: Math.max(0, nickPause),
    };
    this.request = request;
    this.attempts = attempts;
    this.fallback = fallback;
    this.fallbackAttempts = fallbackAttempts;
    this.misses = 0; // phrases in a row the own voice failed
    this.benched = 0; // phrases left to send straight to the fallback
    this.stats = { ok: 0, failed: 0, retries: 0, fallback: 0 };
  }

  /**
   * A phrase is plain text or { lead, body }: the nickname part and the
   * message. The nickname is said faster with a beat after it, which replaces
   * a spoken "{nick} пишет." that took longer than many messages it introduced.
   */
  async #say(voice, text) {
    if (typeof text === "string" || !text.lead) return this.request(voice, this.prosody, text?.body ?? text);
    const fast = { ...this.prosody, rate: this.prosody.leadRate };
    const [lead, body] = await Promise.all([
      this.request(voice, fast, text.lead),
      this.request(voice, this.prosody, text.body),
    ]);
    return join(lead, body, this.prosody.pause);
  }

  async #try(voice, text, attempts) {
    let last = null;
    for (let i = 0; i < attempts; i++) {
      try {
        return await this.#say(voice, text);
      } catch (err) {
        last = err;
        this.stats.retries++;
      }
    }
    throw last ?? new Error("speech failed");
  }

  async synth(text) {
    let last = null;
    if (this.benched > 0) {
      this.benched--;
    } else {
      try {
        const mp3 = await this.#try(this.voice, text, this.attempts);
        this.misses = 0;
        this.stats.ok++;
        return mp3;
      } catch (err) {
        last = err;
        if (++this.misses >= TRIP_AFTER) this.benched = BENCH_FOR;
      }
    }
    if (this.fallback) {
      try {
        const mp3 = await this.#try(this.fallback, text, this.fallbackAttempts);
        this.stats.ok++;
        this.stats.fallback++;
        return mp3;
      } catch (err) {
        last = err;
      }
    }
    this.stats.failed++;
    throw new Error(`${last?.message ?? "speech failed"} (no voice could say it)`);
  }

  /** Gets a cold voice through its first slow request before chat needs it. */
  warm() {
    return this.#try(this.voice, "ok", 1).then(
      () => true,
      () => false,
    );
  }
}

let voiceCache = null;

export async function listVoices() {
  if (voiceCache) return voiceCache;
  const voices = await new MsEdgeTTS().getVoices();
  voiceCache = voices
    .map((v) => ({ id: v.ShortName, locale: v.Locale, gender: v.Gender, name: v.FriendlyName }))
    .sort((a, b) => a.locale.localeCompare(b.locale) || a.id.localeCompare(b.id));
  // Ours first: they are the reason to open the list.
  voiceCache = [...MGI_VOICES, ...voiceCache];
  return voiceCache;
}
