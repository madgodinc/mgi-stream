import { createRequire } from "node:module";
import { vk, modVk, extended } from "./keys.js";

/**
 * Synthetic keyboard and mouse input through user32 SendInput, called over
 * koffi FFI from the main process. Ported from MGI Stream Control's
 * effects/input.rs.
 *
 * Keys go out as scan codes (KEYEVENTF_SCANCODE): Dota 2 and most games read
 * raw input or DirectInput, which ignores events that carry only a
 * virtual-key code. Every key pushed down is remembered, so the kill switch
 * can let go of whatever an interrupted action left held.
 *
 * Windows only; elsewhere createInput() returns null and the actions that
 * press keys report that they cannot.
 */

const INPUT_MOUSE = 0;
const INPUT_KEYBOARD = 1;
const KEYEVENTF_EXTENDEDKEY = 0x1;
const KEYEVENTF_KEYUP = 0x2;
const KEYEVENTF_SCANCODE = 0x8;
const MOUSE = {
  left: [0x2, 0x4],
  right: [0x8, 0x10],
  middle: [0x20, 0x40],
};
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

export function createInput() {
  if (process.platform !== "win32") return null;
  const koffi = createRequire(import.meta.url)("koffi");
  const user32 = koffi.load("user32.dll");
  const kernel32 = koffi.load("kernel32.dll");

  const KEYBDINPUT = koffi.struct("KEYBDINPUT", { wVk: "uint16", wScan: "uint16", dwFlags: "uint32", time: "uint32", dwExtraInfo: "uintptr_t" });
  const MOUSEINPUT = koffi.struct("MOUSEINPUT", { dx: "int32", dy: "int32", mouseData: "uint32", dwFlags: "uint32", time: "uint32", dwExtraInfo: "uintptr_t" });
  const HARDWAREINPUT = koffi.struct("HARDWAREINPUT", { uMsg: "uint32", wParamL: "uint16", wParamH: "uint16" });
  const INPUT = koffi.struct("INPUT", { type: "uint32", u: koffi.union("INPUT_U", { mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT }) });
  const RECT = koffi.struct("RECT", { left: "int32", top: "int32", right: "int32", bottom: "int32" });

  const SendInput = user32.func("uint32 __stdcall SendInput(uint32 cInputs, INPUT *pInputs, int cbSize)");
  const MapVirtualKeyW = user32.func("uint32 __stdcall MapVirtualKeyW(uint32 uCode, uint32 uMapType)");
  const GetForegroundWindow = user32.func("void* __stdcall GetForegroundWindow()");
  const GetWindowThreadProcessId = user32.func("uint32 __stdcall GetWindowThreadProcessId(void *hWnd, _Out_ uint32 *lpdwProcessId)");
  const GetWindowRect = user32.func("bool __stdcall GetWindowRect(void *hWnd, _Out_ RECT *lpRect)");
  const OpenProcess = kernel32.func("void* __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)");
  const CloseHandle = kernel32.func("bool __stdcall CloseHandle(void *h)");
  const QueryFullProcessImageNameW = kernel32.func("bool __stdcall QueryFullProcessImageNameW(void *h, uint32 flags, _Out_ uint16 *name, _Inout_ uint32 *size)");
  const size = koffi.sizeof(INPUT);

  const held = new Map(); // vk -> extended, in press order
  const buttons = new Set();

  const sendKey = (v, ext, release) => {
    const scan = MapVirtualKeyW(v, 0); // MAPVK_VK_TO_VSC
    let flags = KEYEVENTF_SCANCODE;
    if (ext) flags |= KEYEVENTF_EXTENDEDKEY;
    if (release) flags |= KEYEVENTF_KEYUP;
    return SendInput(1, [{ type: INPUT_KEYBOARD, u: { ki: { wVk: v, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } } }], size);
  };
  const sendMouse = (flags) => SendInput(1, [{ type: INPUT_MOUSE, u: { mi: { dx: 0, dy: 0, mouseData: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } } }], size);

  /** A KeyboardEvent.code or a modifier name ("ctrl") to [vk, extended]. */
  const resolve = (code) => {
    const m = modVk(code);
    if (m !== null) return [m, extended(m)];
    const v = vk(code);
    return v === null ? null : [v, extended(v, code)];
  };

  return {
    down(code) {
      const k = resolve(code);
      if (!k) throw new Error(`unknown key ${code}`);
      held.delete(k[0]);
      held.set(k[0], k[1]);
      sendKey(k[0], k[1], false);
    },
    up(code) {
      const k = resolve(code);
      if (!k) return;
      held.delete(k[0]);
      sendKey(k[0], k[1], true);
    },
    click(button, down) {
      const pair = MOUSE[button] ?? MOUSE.left;
      if (down) buttons.add(button);
      else buttons.delete(button);
      sendMouse(pair[down ? 0 : 1]);
    },
    /** Lets go of everything still held, last pressed first. */
    releaseAll() {
      for (const [v, ext] of [...held.entries()].reverse()) sendKey(v, ext, true);
      held.clear();
      for (const b of buttons) sendMouse((MOUSE[b] ?? MOUSE.left)[1]);
      buttons.clear();
    },
    held: () => [...held.keys()],
    /** The exe name of the program in front ("dota2.exe"), or "". */
    foreground() {
      const hwnd = GetForegroundWindow();
      if (!hwnd) return "";
      const pid = [0];
      GetWindowThreadProcessId(hwnd, pid);
      const h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid[0]);
      if (!h) return "";
      try {
        const buf = new Uint16Array(1024);
        const len = [buf.length];
        if (!QueryFullProcessImageNameW(h, 0, buf, len)) return "";
        return String.fromCharCode(...buf.subarray(0, len[0])).split(/[\\/]/).pop();
      } finally {
        CloseHandle(h);
      }
    },
    /** The rectangle of the window in front, in physical screen pixels, or null. */
    foregroundRect() {
      const hwnd = GetForegroundWindow();
      if (!hwnd) return null;
      const r = {};
      if (!GetWindowRect(hwnd, r)) return null;
      return { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top };
    },
    sizeofInput: size,
  };
}
