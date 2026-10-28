import fs from "node:fs";
import path from "node:path";
import { MUSIC_DEFAULTS } from "./music.js";
import { PET_DEFAULTS } from "./pet.js";
import { FX_DEFAULTS, normalizeRules } from "./rules.js";

export const DEFAULTS = {
  lang: "ru",
  username: "",
  voice: "ru-RU-DmitryNeural",
  rate: 8, // percent, -50…+100
  pitch: 0, // semitone-ish Hz offset, -50…+50
  port: 8099,

  sayNickname: true,
  nicknameTemplate: "{nick}",
  nickRate: 40, // percent on top of `rate`, so the name goes by quickly
  nickPause: 300, // ms of silence between the name and the message
  maxChars: 180,
  minChars: 2,
  maxQueue: 12,
  skipEmojiOnly: true,
  skipLinks: true,

  audience: "everyone", // everyone | followers | subscribers | moderators | whitelist
  allowUsers: [],
  ignoreUsers: [],

  requirePrefix: false,
  prefix: "!",

  // On by default: a first run with no OBS set up should still make a sound,
  // otherwise the app looks broken.
  playInApp: true,
  // Closing the window hides it to the tray; the run goes on.
  trayOnClose: true,
  // The app goes on air by itself when it starts; it waits for the room if
  // the stream has not begun yet.
  autoConnect: true,
  // MGI Games (game effects for gifts) starts with this app when it is installed.
  startGames: true,
  signApiKey: "",

  // Our own voices (mgi:52.., mgi:57 is Mad) are synthesized by the MGI gateway.
  mgiUrl: "https://madgodinc.net/ai/v1",
  mgiKey: "",

  // Every sound goes out twice: to the stream (captured by TikTok LIVE Studio)
  // and to the streamer's headphones, each with its own level. Devices are
  // output device names, "" for the system default.
  voiceVolume: 100,
  voiceMonitor: 0,
  streamDevice: "",
  monitorDevice: "",

  // Music requests from the chat (core/music.js), kept as one group.
  music: MUSIC_DEFAULTS,

  // The slime in the music window (core/pet.js), one group like music.
  pet: PET_DEFAULTS,

  // Piggy banks, gift rules and the action switches (core/rules.js). The
  // banks' progress is not here: it changes with every coin (banks.js keeps it).
  banks: [],
  gifts: [],
  fx: FX_DEFAULTS,
};

/** Only an explicit false hides the slime: a missing or mangled value keeps it on screen. */
export function normalizePet(pet) {
  const merged = { ...PET_DEFAULTS, ...(pet ?? {}) };
  return { ...merged, showSlime: merged.showSlime !== false };
}

/** The groups merge key by key, so a newer version's new setting gets its default. */
const withMusic = (cfg) => ({
  ...cfg,
  music: { ...MUSIC_DEFAULTS, ...(cfg.music ?? {}) },
  pet: normalizePet(cfg.pet),
  ...normalizeRules(cfg),
});

/**
 * The connector wants a bare uniqueId, but people paste what they have: `@ник`,
 * a profile link, the /live URL, a trailing space from the phone keyboard.
 *
 * Lowercase matters more than it looks. A uniqueId is lowercase on TikTok's
 * side, but the profile page shows it capitalised the way its owner typed it,
 * so that is what gets retyped here. Room lookup then misses on every source
 * and reports "Failed to retrieve Room ID from all sources", which reads as a
 * broken app rather than as one wrong letter.
 */
export function normalizeUsername(raw) {
  const input = String(raw ?? "").trim();
  const fromLink = input.match(/tiktok\.com\/@([^/?#\s]+)/i);
  return (fromLink ? fromLink[1] : input.replace(/^@+/, "")).split(/[/?#\s]/)[0].toLowerCase();
}

export function load(dir) {
  const file = path.join(dir, "config.json");
  if (!fs.existsSync(file)) return withMusic({ ...DEFAULTS });
  try {
    return withMusic({ ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, "utf8")) });
  } catch {
    // A hand-edited file with a stray comma should not stop the app from starting.
    return withMusic({ ...DEFAULTS });
  }
}

export function save(dir, cfg) {
  fs.mkdirSync(dir, { recursive: true });
  const clean = {};
  for (const key of Object.keys(DEFAULTS)) clean[key] = cfg?.[key] ?? DEFAULTS[key];
  clean.username = normalizeUsername(clean.username);
  const groups = withMusic(clean);
  clean.music = groups.music;
  clean.pet = groups.pet;
  clean.banks = groups.banks;
  clean.gifts = groups.gifts;
  clean.fx = groups.fx;
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(clean, null, 2));
  return clean;
}
