// What the streamer sets up on the «Копилки» tab: piggy banks (a coin goal
// and what happens when it is reached) and gift rules (a named gift does
// something at once). Both run the same steps through core/actions.js.
// Shared by the main process and the settings window: no Node imports.

import { keyLabel, vk } from "./keys.js";

export const FX_DEFAULTS = {
  // Off: the banks still fill and the slime still celebrates, nothing is pressed or shown.
  enabled: true,
  killKey: "Ctrl+Shift+End",
};

/** Hard ceilings, whatever the file says: a typo must not hold a key for an hour. */
export const LIMITS = { holdMs: 10000, repeat: 50, delayMs: 60000, effectS: 120, goal: 1_000_000, steps: 20 };

const num = (v, lo, hi, def) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
};
const str = (v, max = 200) => String(v ?? "").slice(0, max);
const mods = (list) => (Array.isArray(list) ? list.filter((m) => ["ctrl", "shift", "alt", "win"].includes(m)) : []);
const POS = ["tl", "tc", "tr", "ml", "c", "mr", "bl", "bc", "br"];

/** One step with every field in range, or null for a kind this version does not know. */
export function normalizeStep(s) {
  switch (s?.kind) {
    case "key":
      return { kind: "key", code: str(s.code, 24) || "KeyQ", mods: mods(s.mods), hold_ms: num(s.hold_ms, 10, LIMITS.holdMs, 40), repeat: Math.round(num(s.repeat, 1, LIMITS.repeat, 1)), gap_ms: num(s.gap_ms, 0, LIMITS.delayMs, 60) };
    case "hold":
      return { kind: "hold", code: str(s.code, 24) || "KeyQ", mods: mods(s.mods), seconds: num(s.seconds, 0.05, LIMITS.effectS, 2) };
    case "delay":
      return { kind: "delay", ms: num(s.ms, 0, LIMITS.delayMs, 1000) };
    case "dim":
      return { kind: "dim", level: Math.round(num(s.level, 0, 100, 90)), color: /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : "#000000", seconds: num(s.seconds, 0.1, LIMITS.effectS, 10) };
    case "media":
      return { kind: "media", file: str(s.file, 80), name: str(s.name, 120), pos: POS.includes(s.pos) ? s.pos : "c", size: Math.round(num(s.size, 5, 100, 40)), seconds: num(s.seconds, 0, LIMITS.effectS, 5), volume: Math.round(num(s.volume, 0, 100, 80)) };
    case "click":
      return { kind: "click", button: ["left", "right", "middle"].includes(s.button) ? s.button : "left", repeat: Math.round(num(s.repeat, 1, LIMITS.repeat, 1)), gap_ms: num(s.gap_ms, 0, LIMITS.delayMs, 100) };
    case "say":
      return { kind: "say", text: str(s.text, 140) };
    case "sound":
      return { kind: "sound", file: str(s.file, 80), name: str(s.name, 120), volume: Math.round(num(s.volume, 0, 100, 80)) };
    default:
      return null;
  }
}

const steps = (list) => (Array.isArray(list) ? list.map(normalizeStep).filter(Boolean).slice(0, LIMITS.steps) : []);
let seq = 0;
export const newId = (prefix) => `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}`;

export function normalizeBank(b, i = 0) {
  return {
    id: str(b?.id, 40) || newId("b"),
    name: str(b?.name, 40).trim() || `Копилка ${i + 1}`,
    goal: Math.round(num(b?.goal, 1, LIMITS.goal, 350)),
    paused: Boolean(b?.paused),
    game: str(b?.game, 60),
    steps: steps(b?.steps),
  };
}

export function normalizeGiftRule(r) {
  return {
    id: str(r?.id, 40) || newId("g"),
    gift: str(r?.gift, 60).trim(),
    enabled: r?.enabled !== false,
    game: str(r?.game, 60),
    steps: steps(r?.steps),
  };
}

export function normalizeRules(cfg = {}) {
  const banks = Array.isArray(cfg.banks) ? cfg.banks.map(normalizeBank) : [];
  // Two banks with one id would share one jar.
  const seen = new Set();
  for (const b of banks) {
    if (seen.has(b.id)) b.id = newId("b");
    seen.add(b.id);
  }
  return {
    banks,
    gifts: Array.isArray(cfg.gifts) ? cfg.gifts.map(normalizeGiftRule) : [],
    fx: { ...FX_DEFAULTS, ...(cfg.fx ?? {}), enabled: cfg.fx?.enabled !== false },
  };
}

/** Gift rules a gift fires, by its name as TikTok sends it. */
export function giftRulesFor(rules, name) {
  const n = String(name ?? "").trim().toLowerCase();
  if (!n) return [];
  return rules.filter((r) => r.enabled && r.steps.length && r.gift.trim().toLowerCase() === n);
}

// ── plain language ────────────────────────────────────────────────────────────

const plural = (n, one, few, many) => {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  return a > 10 && a < 20 ? many : b > 1 && b < 5 ? few : b === 1 ? one : many;
};
const sec = (s, lang) => {
  const v = Number(s);
  const t = Number.isInteger(v) ? String(v) : v.toFixed(1).replace(".", lang === "ru" ? "," : ".");
  return lang === "ru" ? `${t} с` : `${t} s`;
};
const times = (n, lang) => (n > 1 ? (lang === "ru" ? ` ${n} ${plural(n, "раз", "раза", "раз")}` : ` ${n} times`) : "");

/** One step as words: "затемнить экран на 10 с". */
export function stepText(s, lang = "ru") {
  const ru = lang === "ru";
  const key = () => keyLabel(s.code, s.mods);
  switch (s.kind) {
    case "key":
      return (ru ? `нажать ${key()}` : `press ${key()}`) + times(s.repeat, lang);
    case "hold":
      return ru ? `зажать ${key()} на ${sec(s.seconds, lang)}` : `hold ${key()} for ${sec(s.seconds, lang)}`;
    case "delay":
      return ru ? `подождать ${sec(s.ms / 1000, lang)}` : `wait ${sec(s.ms / 1000, lang)}`;
    case "dim": {
      const white = s.color.toLowerCase() === "#ffffff";
      const black = s.color.toLowerCase() === "#000000";
      if (ru) return `${black ? "затемнить экран" : white ? "залить экран белым" : "залить экран цветом"} на ${sec(s.seconds, lang)}`;
      return `${black ? "darken the screen" : white ? "flash the screen white" : "tint the screen"} for ${sec(s.seconds, lang)}`;
    }
    case "media": {
      const what = s.name ? `«${s.name}»` : ru ? "картинку" : "a picture";
      const long = s.seconds > 0 ? (ru ? ` на ${sec(s.seconds, lang)}` : ` for ${sec(s.seconds, lang)}`) : ru ? " до конца" : " to the end";
      return (ru ? `показать ${what}` : `show ${what}`) + long;
    }
    case "click":
      return (ru ? `кликнуть ${{ left: "левой", right: "правой", middle: "средней" }[s.button]} кнопкой мыши` : `click the ${s.button} mouse button`) + times(s.repeat, lang);
    case "say":
      return ru ? `слайм скажет «${s.text || "…"}»` : `the slime says “${s.text || "…"}”`;
    case "sound":
      return ru ? `включить звук ${s.name ? `«${s.name}»` : ""}`.trim() : `play ${s.name ? `“${s.name}”` : "a sound"}`;
    default:
      return "";
  }
}

export function stepsText(list, lang = "ru") {
  if (!list?.length) return lang === "ru" ? "ничего не делать (добавьте действие)" : "do nothing (add an action)";
  return list.map((s) => stepText(s, lang)).join(lang === "ru" ? ", потом " : ", then ");
}

/** True when a step presses something in the game: worth a "only with the game in front" guard. */
export const pressesKeys = (list) => list.some((s) => ["key", "hold", "click"].includes(s.kind) && (s.kind === "click" || vk(s.code) !== null));
