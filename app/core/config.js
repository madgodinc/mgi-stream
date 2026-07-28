import fs from "node:fs";
import path from "node:path";

export const DEFAULTS = {
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

  playInApp: false,
  signApiKey: "",
};

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
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(clean, null, 2));
  return clean;
}
