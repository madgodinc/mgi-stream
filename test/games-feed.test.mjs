import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { StreamServer } from "../app/core/server.js";
import { DEFAULTS } from "../app/core/config.js";
import { parseGift, viewer } from "../app/core/gifts.js";
import { readGamesMessage, isGameCommand } from "../app/core/games-feed.js";
import { startGames, gamesExe } from "../app/core/companion.js";

const PORT = 8141;
const overlayDir = new URL("../app/overlay", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/** A pet stand-in that records what the server asks of it. */
function fakePet() {
  const calls = [];
  const pet = { cfg: {}, send: null, calls };
  for (const name of ["configure", "start", "stop", "chat", "gift", "like", "follow", "share", "music", "say", "hints"]) {
    pet[name] = (...args) => calls.push([name, ...args]);
  }
  return pet;
}

/** A socket that keeps every JSON message it gets. */
async function client(path = "") {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}`);
  const got = [];
  ws.on("message", (raw) => got.push(JSON.parse(String(raw))));
  await new Promise((open) => ws.on("open", open));
  return { ws, got };
}

const settle = (ms = 60) => new Promise((done) => setTimeout(done, ms));

// Mock mode: the sample timer is five seconds away, so nothing here is real chat.
async function started(opts = {}) {
  const s = new StreamServer(overlayDir, { version: "9.9.9", ...opts });
  await s.start({ ...DEFAULTS, username: "streamer", port: PORT }, { mock: true });
  // The demo chat would talk over the test; only what the test sends counts.
  clearInterval(s.mockTimer);
  // No speech in tests: a spoken line would go out to the network.
  s.speaker = { synth: async () => Buffer.from("mp3") };
  return s;
}

test("a viewer is known by handle and account id in both connector shapes", () => {
  assert.deepEqual(viewer({ nickname: "Катя", displayId: "katya.plays", id: "7001" }), { nick: "Катя", id: "katya.plays", uid: "7001" });
  assert.deepEqual(viewer({ nickname: "", uniqueId: "kate", userId: "7002" }), { nick: "kate", id: "kate", uid: "7002" });
  assert.deepEqual(viewer(undefined), { nick: "someone", id: "", uid: "" });
  const g = parseGift({ user: { nickname: "Кит", displayId: "kit" }, giftId: 5655, giftDetails: { giftName: "Rose", diamondCount: 1, giftType: 1 }, repeatCount: 3 });
  assert.equal(g.id, "kit");
  assert.equal(g.nick, "Кит");
});

test("games clients get the room with ids; overlays never see it", async () => {
  const pet = fakePet();
  const s = await started({ pet });
  const games = await client("/games");
  const overlay = await client("/");
  await settle();

  assert.deepEqual(games.got[0], { kind: "hello", app: "mgi-stream", version: "9.9.9", username: "streamer", live: true });
  assert.ok(overlay.got.some((m) => m.kind === "hello" && m.voice), "the overlay still gets its own hello");
  games.got.length = 0;
  overlay.got.length = 0;

  s.onChat("Катя", "!маргит", {}, { id: "katya.plays", uid: "7001" });
  // A plain gift, then a streak of three of which only the new taps count.
  s.onGift({ nick: "Кит", id: "kit", uid: "7002", giftId: 7934, name: "Galaxy", diamonds: 1000, count: 1, streakable: false, end: true });
  s.onLike({ nick: "Катя", id: "katya.plays", uid: "7001" }, 15);
  s.onFollow({ nick: "новый", id: "new_one", uid: "7003" });
  s.onShare({ nick: "новый", id: "new_one", uid: "7003" });
  pet.send({ kind: "pet", mood: "happy" }); // the slime's own traffic is overlay traffic
  await settle();

  const strip = ({ at, ...m }) => (assert.equal(typeof at, "number"), m);
  assert.deepEqual(games.got.map(strip), [
    { kind: "chat", id: "katya.plays", uid: "7001", nick: "Катя", text: "!маргит" },
    { kind: "gift", id: "kit", uid: "7002", nick: "Кит", gift: "Galaxy", giftId: 7934, coins: 1000, count: 1 },
    { kind: "like", id: "katya.plays", uid: "7001", nick: "Катя", count: 15 },
    { kind: "follow", id: "new_one", uid: "7003", nick: "новый" },
    { kind: "share", id: "new_one", uid: "7003", nick: "новый" },
  ]);
  assert.ok(overlay.got.length > 0, "the overlay got the slime");
  assert.ok(!overlay.got.some((m) => ["chat", "gift", "like", "follow", "share"].includes(m.kind)), "and nothing of the feed");
  assert.ok(!games.got.some((m) => m.kind === "pet"), "the games client got nothing of the overlay");

  games.ws.close();
  overlay.ws.close();
  await s.stop();
});

test("a combo streak reaches games as new gifts only", async () => {
  const s = await started();
  const games = await client("/games");
  await settle();
  games.got.length = 0;
  // Without banks a streak counts once, at its end, with the full total.
  for (let n = 1; n <= 4; n++) s.onGift({ nick: "Аня", id: "anya", giftId: 5655, name: "Rose", diamonds: 1, count: n, streakable: true, end: n === 4 });
  await settle();
  assert.deepEqual(games.got.map((m) => [m.kind, m.count, m.coins]), [["gift", 4, 1]]);
  games.ws.close();
  await s.stop();
});

test("say, hints and commands from games reach the slime and the filter", async () => {
  const pet = fakePet();
  const s = await started({ pet });
  const games = await client("/games");
  const spoken = [];
  s.on("message", (m) => spoken.push([m.text, m.spoken, m.reason]));

  games.ws.send(JSON.stringify({ kind: "say", text: "Катя призвала Маргита!" }));
  games.ws.send(JSON.stringify({ kind: "say", text: "не хватает монет", nick: "Кит" }));
  games.ws.send(JSON.stringify({ kind: "hints", lines: ["!маргит - 1000 монет", 42, "  "] }));
  // Commands without the "!" the prefix setting knows about: still never read out.
  games.ws.send(JSON.stringify({ kind: "commands", prefixes: ["Маргит", "!руны"] }));
  await settle();

  assert.deepEqual(pet.calls.filter(([n]) => n === "say").map(([, t]) => t), ["Катя призвала Маргита!", "Кит: не хватает монет"]);
  assert.deepEqual(pet.calls.filter(([n]) => n === "hints").map(([, l]) => l), [["!маргит - 1000 монет"]]);

  s.onChat("a", "маргит пожалуйста", {}, { id: "a" });
  s.onChat("b", "!РУНЫ 500", {}, { id: "b" });
  s.onChat("c", "маргитка привет", {}, { id: "c" });
  assert.deepEqual(spoken, [
    ["маргит пожалуйста", false, "game"],
    ["!РУНЫ 500", false, "game"],
    ["маргитка привет", true, undefined],
  ]);

  // The shop closing takes its hints and commands with it.
  games.ws.close();
  await settle();
  assert.deepEqual(pet.calls.filter(([n]) => n === "hints").at(-1), ["hints", []]);
  assert.deepEqual(s.gameCommands, []);
  await s.stop();
});

test("bad input from a games client is ignored", async () => {
  const pet = fakePet();
  const s = await started({ pet });
  const games = await client("/games");
  for (const bad of [
    "not json",
    "[]",
    "null",
    JSON.stringify({ kind: "say" }),
    JSON.stringify({ kind: "say", text: 5 }),
    JSON.stringify({ kind: "say", text: "   " }),
    JSON.stringify({ kind: "hints", lines: "!маргит" }),
    JSON.stringify({ kind: "commands", prefixes: { a: 1 } }),
    JSON.stringify({ kind: "speak", text: "hi" }),
    JSON.stringify({ kind: "music-play", track: {} }),
  ]) {
    games.ws.send(bad);
  }
  await settle();
  assert.deepEqual(pet.calls.filter(([n]) => ["say", "hints"].includes(n)), []);
  assert.deepEqual(s.gameCommands, []);
  assert.equal(games.ws.readyState, WebSocket.OPEN, "a bad message does not cost the connection");
  games.ws.close();
  await s.stop();
});

test("the games reader trims, caps and cleans what it takes", () => {
  const say = readGamesMessage(JSON.stringify({ kind: "say", text: "a\u0007b".padEnd(500, "x"), nick: "n\nm" }));
  assert.equal(say.text.length, 140);
  assert.ok(say.text.startsWith("ab"));
  assert.equal(say.nick, "n m");
  const hints = readGamesMessage(JSON.stringify({ kind: "hints", lines: Array.from({ length: 50 }, (_, i) => `h${i}`) }));
  assert.equal(hints.lines.length, 20);
  assert.deepEqual(readGamesMessage(JSON.stringify({ kind: "hints", lines: [] })), { kind: "hints", lines: [] });
  const cmds = readGamesMessage(JSON.stringify({ kind: "commands", prefixes: ["!A", "!a", "two words", "", 7] }));
  assert.deepEqual(cmds.prefixes, ["!a"]);
  assert.equal(isGameCommand(["!a"], "  !A now"), true);
  assert.equal(isGameCommand(["!a"], "!ab"), false);
  assert.equal(isGameCommand([], "!a"), false);
});

test("MGI Games starts once, only when installed", async () => {
  const runs = [];
  const run = (exe, args) => (runs.push([exe, args]), { on() {}, unref() {} });
  assert.equal(await startGames(8099, { exe: null, run }), "missing");
  assert.equal(await startGames(8099, { exe: "C:/x/mgi-games.exe", running: async () => true, run }), "running");
  assert.equal(await startGames(8099, { exe: "C:/x/mgi-games.exe", running: async () => false, run }), "started");
  assert.deepEqual(runs, [["C:/x/mgi-games.exe", ["--stream-port", "8099"]]]);

  const env = { LOCALAPPDATA: "L" };
  const only = (want) => (p) => p.replace(/\\/g, "/") === want;
  assert.equal(gamesExe(env, only("L/MGI Games/mgi-games.exe")).replace(/\\/g, "/"), "L/MGI Games/mgi-games.exe");
  assert.equal(gamesExe(env, only("L/Programs/MGI Games/mgi-games.exe")).replace(/\\/g, "/"), "L/Programs/MGI Games/mgi-games.exe");
  assert.equal(gamesExe(env, () => false), null);
  assert.equal(gamesExe({}, () => true), null);
});

test("a like event counts every tap in it, in both protocol shapes", async () => {
  const { likes } = await import("../app/core/gifts.js");
  assert.equal(likes({ count: 15, user: {} }), 15);
  assert.equal(likes({ likeCount: 7 }), 7);
  assert.equal(likes({}), 1);
});
