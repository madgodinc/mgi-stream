import fs from "node:fs";
import path from "node:path";

export const DEFAULTS = {
  lang: "ru",
  username: "",
  voice: "ru-RU-DmitryNeural",
  rate: 8, // percent, -50…+100
  pitch: 0, // semitone-ish Hz offset, -50…+50
  port: 8099,

  sayNickname: true,
  nicknameTemplate: "{nick} пишет.",
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
  signApiKey: "",
};

/**
 * The connector wants a bare uniqueId, but people paste what they have: `@ник`,
 * a profile link, the /live URL, a trailing space from the phone keyboard.
 */
export function normalizeUsername(raw) {
  const input = String(raw ?? "").trim();
  const fromLink = input.match(/tiktok\.com\/@([^/?#\s]+)/i);
  return (fromLink ? fromLink[1] : input.replace(/^@+/, "")).split(/[/?#\s]/)[0];
}

export function load(dir) {
  const file = path.join(dir, "config.json");
  if (!fs.existsSync(file)) return { ...DEFAULTS };
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch {
    // A hand-edited file with a stray comma should not stop the app from starting.
    return { ...DEFAULTS };
  }
}

export function save(dir, cfg) {
  fs.mkdirSync(dir, { recursive: true });
  const clean = {};
  for (const key of Object.keys(DEFAULTS)) clean[key] = cfg?.[key] ?? DEFAULTS[key];
  clean.username = normalizeUsername(clean.username);
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(clean, null, 2));
  return clean;
}
