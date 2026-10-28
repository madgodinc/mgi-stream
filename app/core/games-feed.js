// The feed MGI Games reads: a separate desktop app that turns gift coins into
// effects inside a game. It connects to this app's local server at /games and
// gets the room as JSON (gift, chat, like, follow, live); it may send back a
// few kinds of its own. It is on loopback, but what it sends is still treated
// as untrusted input: anything malformed or unknown is dropped.

export const GAMES_PATH = "/games";

const TEXT_MAX = 140; // the slime's bubble takes no more than this anyway
const NICK_MAX = 40;
const HINTS_MAX = 20;
const PREFIXES_MAX = 100;
const PREFIX_MAX = 32;

/** Control characters out, line breaks kept: the bubble shows "\n" as a new line. */
const clean = (s, max) =>
  String(s)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "")
    .trim()
    .slice(0, max);

const strings = (list, max) => (Array.isArray(list) ? list.filter((x) => typeof x === "string").slice(0, max) : null);

/**
 * One message from a games client, raw from the socket. Returns
 * {kind: "say", text, nick}, {kind: "hints", lines} or {kind: "commands", prefixes},
 * or null for anything else.
 */
export function readGamesMessage(raw) {
  if (String(raw).length > 64 * 1024) return null;
  let m;
  try {
    m = JSON.parse(String(raw));
  } catch {
    return null;
  }
  if (!m || typeof m !== "object" || Array.isArray(m)) return null;

  if (m.kind === "say") {
    if (typeof m.text !== "string") return null;
    const text = clean(m.text, TEXT_MAX);
    if (!text) return null;
    const nick = typeof m.nick === "string" ? clean(m.nick, NICK_MAX).replace(/\n/g, " ") : "";
    return { kind: "say", text, nick };
  }
  if (m.kind === "hints") {
    const lines = strings(m.lines, HINTS_MAX);
    if (!lines) return null;
    return { kind: "hints", lines: lines.map((l) => clean(l, TEXT_MAX)).filter(Boolean) };
  }
  if (m.kind === "match") {
    // "What did the viewer mean?": MGI Games has no account of its own, so
    // this app asks the match service with its token and passes the answer back.
    const rid = Number(m.rid);
    const game = typeof m.game === "string" ? m.game : "";
    if (!Number.isInteger(rid) || rid < 0 || !/^[a-z0-9_]{1,32}$/.test(game) || typeof m.text !== "string") return null;
    const text = clean(m.text, 120).replace(/\s+/g, " ");
    return text ? { kind: "match", rid, game, text } : null;
  }
  if (m.kind === "commands") {
    const list = strings(m.prefixes, PREFIXES_MAX);
    if (!list) return null;
    // A prefix is one word: matched against the first word of a chat line.
    const prefixes = list.map((p) => p.trim().toLowerCase()).filter((p) => p && p.length <= PREFIX_MAX && !/\s/.test(p));
    return { kind: "commands", prefixes: [...new Set(prefixes)] };
  }
  return null;
}

/** True when the chat line's first word is one of the game command words. */
export function isGameCommand(prefixes, text) {
  if (!prefixes.length) return false;
  const first = String(text ?? "").trim().split(/\s+/)[0].toLowerCase();
  return Boolean(first) && prefixes.includes(first);
}
