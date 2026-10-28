// Keys as the actions name them: KeyboardEvent.code ("KeyQ", "F4", "Tab")
// plus modifier names. Ported from MGI Stream Control's effects/input.rs.
// No Node imports: the settings window loads this file too.

/** KeyboardEvent.code to a Windows virtual-key code, or null. */
export function vk(code) {
  const s = String(code ?? "");
  let m = s.match(/^Key([A-Z])$/);
  if (m) return m[1].charCodeAt(0);
  m = s.match(/^Digit([0-9])$/);
  if (m) return m[1].charCodeAt(0);
  m = s.match(/^Numpad([0-9])$/);
  if (m) return 0x60 + Number(m[1]);
  m = s.match(/^F([0-9]{1,2})$/);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 24) return 0x70 + Number(m[1]) - 1;
  return NAMED[s] ?? null;
}

const NAMED = {
  Escape: 0x1b, Tab: 0x09, Space: 0x20, Enter: 0x0d, NumpadEnter: 0x0d, Backspace: 0x08, CapsLock: 0x14,
  ShiftLeft: 0xa0, ShiftRight: 0xa1, ControlLeft: 0xa2, ControlRight: 0xa3, AltLeft: 0xa4, AltRight: 0xa5,
  MetaLeft: 0x5b, MetaRight: 0x5c, ContextMenu: 0x5d,
  ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28,
  Insert: 0x2d, Delete: 0x2e, Home: 0x24, End: 0x23, PageUp: 0x21, PageDown: 0x22,
  PrintScreen: 0x2c, ScrollLock: 0x91, Pause: 0x13, NumLock: 0x90,
  NumpadMultiply: 0x6a, NumpadAdd: 0x6b, NumpadSubtract: 0x6d, NumpadDecimal: 0x6e, NumpadDivide: 0x6f,
  Semicolon: 0xba, Equal: 0xbb, Comma: 0xbc, Minus: 0xbd, Period: 0xbe, Slash: 0xbf, Backquote: 0xc0,
  BracketLeft: 0xdb, Backslash: 0xdc, BracketRight: 0xdd, Quote: 0xde,
};

export const MODS = ["ctrl", "shift", "alt", "win"];
const MOD_VK = { ctrl: 0xa2, shift: 0xa0, alt: 0xa4, win: 0x5b };
export const modVk = (name) => MOD_VK[name] ?? null;

/** Keys whose scan code needs the E0 prefix: arrows, the block above them, right Ctrl/Alt, Win. */
export function extended(v, code = "") {
  return (v >= 0x21 && v <= 0x28) || [0x2c, 0x2d, 0x2e, 0x5b, 0x5c, 0x5d, 0x6f, 0xa3, 0xa5].includes(v) || code === "NumpadEnter";
}

const LABELS = {
  Escape: "Esc", Space: "Пробел", Enter: "Enter", Backspace: "Backspace", Tab: "Tab", CapsLock: "Caps",
  ArrowLeft: "←", ArrowUp: "↑", ArrowRight: "→", ArrowDown: "↓", Backquote: "`", Minus: "-", Equal: "=",
  BracketLeft: "[", BracketRight: "]", Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Backslash: "\\",
  PageUp: "PgUp", PageDown: "PgDn", Delete: "Del", Insert: "Ins", PrintScreen: "PrtSc",
};
const MOD_LABEL = { ctrl: "Ctrl", shift: "Shift", alt: "Alt", win: "Win" };

/** What a person reads on the key: "Q", "5", "F4", "Alt+Tab". */
export function keyLabel(code, mods = []) {
  const s = String(code ?? "");
  const pad = s.match(/^Numpad(\d)$/);
  const base = s.match(/^(?:Key|Digit)(.)$/)?.[1] ?? (pad ? `Num ${pad[1]}` : LABELS[s] ?? s);
  return [...mods.map((m) => MOD_LABEL[m] ?? m), base].join("+");
}

const ACCEL = { ctrl: "Control", win: "Super", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", Escape: "Esc" };

/**
 * The global-shortcut accelerator Electron takes, from "Ctrl+Shift+End" as
 * the settings store it.
 */
export function accelerator(combo) {
  return String(combo ?? "")
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => ACCEL[p.toLowerCase()] ?? ACCEL[p] ?? p)
    .join("+");
}

/** A keydown in the settings window to a stored combo, or null while only modifiers are down. */
export function comboFromEvent(e) {
  if (/^(Shift|Control|Alt|Meta)(Left|Right)$/.test(e.code)) return null;
  const mods = [e.ctrlKey && "Ctrl", e.shiftKey && "Shift", e.altKey && "Alt"].filter(Boolean);
  const key = e.code.match(/^(?:Key|Digit)(.)$/)?.[1] ?? e.code;
  return [...mods, key].join("+");
}
