import crypto from "node:crypto";
import { WebSocket } from "ws";
import { MsEdgeTTS } from "msedge-tts";

// The Edge Read Aloud endpoint, spoken to directly. msedge-tts 2.0.7 (and 2.0.9)
// has no timeout, no XML escaping of the text and keeps a socket that the
// service drops, so speech goes through this small client and the library is
// only used for the voice list.
const TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const ENDPOINT = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
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

/** One request on its own socket. Resolves with the mp3, rejects on any early close. */
export function edgeRequest(voice, prosody, text, { timeoutMs = ATTEMPT_MS, Socket = WebSocket } = {}) {
  return new Promise((resolve, reject) => {
    const url = `${ENDPOINT}?TrustedClientToken=${TOKEN}&Sec-MS-GEC=${gec()}&Sec-MS-GEC-Version=${GEC_VERSION}&ConnectionId=${hex(16)}`;
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
 * Turns phrases into mp3 with one voice. Each attempt gets a fresh socket. A
 * phrase its own voice cannot say goes to the fallback voice; one that fails
 * there too throws, and the caller skips it.
 */
export class Speaker {
  constructor(
    { voice, rate, pitch },
    { request = edgeRequest, attempts = ATTEMPTS, fallback = fallbackFor(voice), fallbackAttempts = FALLBACK_ATTEMPTS } = {},
  ) {
    this.voice = voice;
    // The API wants signed SSML units, the UI stores plain numbers.
    this.prosody = {
      rate: `${rate >= 0 ? "+" : ""}${rate}%`,
      pitch: `${pitch >= 0 ? "+" : ""}${pitch}Hz`,
    };
    this.request = request;
    this.attempts = attempts;
    this.fallback = fallback;
    this.fallbackAttempts = fallbackAttempts;
    this.misses = 0; // phrases in a row the own voice failed
    this.benched = 0; // phrases left to send straight to the fallback
    this.stats = { ok: 0, failed: 0, retries: 0, fallback: 0 };
  }

  async #try(voice, text, attempts) {
    let last = null;
    for (let i = 0; i < attempts; i++) {
      try {
        return await this.request(voice, this.prosody, text);
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
  return voiceCache;
}
