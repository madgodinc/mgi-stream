import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Music, MUSIC_DEFAULTS, commandArg, refuse, refuseTrack } from "../app/core/music.js";
import { StreamServer } from "../app/core/server.js";
import { DEFAULTS } from "../app/core/config.js";

const overlayDir = fileURLToPath(new URL("../app/overlay", import.meta.url));
const okAccount = { token: "tok", status: () => ({ ok: true }) };

/** A stand-in for madgodinc.net/music/api: every call is logged, every track is short. */
function fakeServer({ resolve = {} } = {}) {
  const calls = [];
  const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = async (url, init = {}) => {
    const route = url.replace(/^.*\/music\/api/, "");
    calls.push({ route, headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    if (route === "/resolve") {
      const q = JSON.parse(init.body).query ?? "link";
      return json(200, { id: "id" + q.slice(0, 9).padEnd(9, "x"), title: "Song " + q, channel: "Band", duration: 180, thumbnail: "", has_video: true, ok: true, reason: "", ...resolve });
    }
    if (route === "/fetch") return json(200, { job: "job" + calls.length, video: JSON.parse(init.body).video });
    if (route.startsWith("/job/")) return json(200, { state: "ready", size: 4 });
    if (route.startsWith("/file/")) return new Response("data", { status: 200, headers: { "x-media-ext": "mp4" } });
    return json(404, {});
  };
  return { calls, fetchImpl };
}

const workDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "mgi-music-test-"));
const settle = () => new Promise((r) => setTimeout(r, 30));

test("a command is the word, then a space; anything else is chat", () => {
  assert.equal(commandArg("/music Linkin Park Numb", "/music"), "Linkin Park Numb");
  assert.equal(commandArg("  /MUSIC   numb ", "/music"), "numb");
  assert.equal(commandArg("/music", "/music"), "");
  assert.equal(commandArg("/musical", "/music"), null);
  assert.equal(commandArg("play /music numb", "/music"), null);
  assert.equal(commandArg("anything", ""), null);
});

test("the streamer's rules: bans, audience, per viewer, queue size", () => {
  const cfg = { ...MUSIC_DEFAULTS, perViewer: 1, maxQueue: 2, audience: "followers", bannedUsers: ["Troll"] };
  const empty = { queue: [], pending: [], current: null };
  const fan = { isFollowerOfAnchor: true };
  assert.equal(refuse(cfg, empty, { nick: "troll", identity: fan }), "bannedUser");
  assert.equal(refuse(cfg, empty, { nick: "anon", identity: {} }), "tier");
  assert.equal(refuse(cfg, empty, { nick: "anon", identity: { isModeratorOfAnchor: true } }), null, "moderators always pass");
  assert.equal(refuse(cfg, { ...empty, queue: [{ nick: "Kate" }] }, { nick: "kate", identity: fan }), "perViewer");
  assert.equal(refuse(cfg, { ...empty, queue: [{ nick: "a" }, { nick: "b" }] }, { nick: "c", identity: fan }), "full");

  const t = { id: "abcdefghijk", title: "Some Song", channel: "Band" };
  assert.equal(refuseTrack({ ...cfg, bannedTracks: ["abcdefghijk"] }, empty, t), "bannedTrack");
  assert.equal(refuseTrack({ ...cfg, bannedWords: ["SONG"] }, empty, t), "bannedWord");
  assert.equal(refuseTrack(cfg, { ...empty, current: { id: "abcdefghijk" } }, t), "duplicate");
  assert.equal(refuseTrack(cfg, empty, t), null);
});

test("a request is resolved, downloaded with the tiktok product header, and played", async () => {
  const srv = fakeServer();
  const m = new Music({ account: okAccount, workDir: workDir(), fetchImpl: srv.fetchImpl });
  m.configure({});
  m.setLive(true);
  const played = [];
  m.on("play", ({ track }) => played.push(track));

  assert.equal(m.onChat("kate", "/music numb", {}), "music");
  await settle();
  assert.equal(played.length, 1);
  assert.equal(played[0].title, "Song numb");
  assert.ok(fs.existsSync(m.current.file), "the file is on disk while it plays");
  assert.ok(srv.calls.every((c) => c.headers["x-mgi-product"] === "tiktok" && c.headers.authorization === "Bearer tok"));
  assert.equal(srv.calls.find((c) => c.route === "/resolve").body.max_duration, MUSIC_DEFAULTS.maxMinutes * 60);

  const file = m.current.file;
  m.finished(m.current.uid);
  await settle();
  assert.equal(fs.existsSync(file), false, "played means deleted");
  m.setLive(false);
});

test("a YouTube link goes as a link, not as a search", async () => {
  const srv = fakeServer();
  const m = new Music({ account: okAccount, workDir: workDir(), fetchImpl: srv.fetchImpl });
  m.setLive(true);
  m.onChat("kate", "/music youtu.be/dQw4w9WgXcQ please", {});
  await settle();
  assert.equal(srv.calls[0].body.url, "https://youtu.be/dQw4w9WgXcQ");
  m.setLive(false);
});

test("no subscription: the request is turned down before the server is asked", async () => {
  const srv = fakeServer();
  const m = new Music({ account: { token: "", status: () => ({ ok: false }) }, workDir: workDir(), fetchImpl: srv.fetchImpl });
  m.setLive(true);
  const notes = [];
  m.on("request", (n) => notes.push(n));
  m.onChat("kate", "/music numb", {});
  await settle();
  assert.equal(srv.calls.length, 0);
  assert.equal(notes[0].reason, "noSub");
  m.setLive(false);
});

test("the server's rules reason reaches the viewer", async () => {
  const srv = fakeServer({ resolve: { ok: false, reason: "Видео 18+" } });
  const m = new Music({ account: okAccount, workDir: workDir(), fetchImpl: srv.fetchImpl });
  m.setLive(true);
  const notes = [];
  m.on("request", (n) => notes.push(n));
  m.onChat("kate", "/music x", {});
  await settle();
  assert.deepEqual([notes[0].ok, notes[0].reason, notes[0].arg], [false, "rules", "Видео 18+"]);
  assert.equal(m.queue.length, 0);
  m.setLive(false);
});

test("approval holds a request until the streamer says yes; moderators skip the wait", async () => {
  const srv = fakeServer();
  const m = new Music({ account: okAccount, workDir: workDir(), fetchImpl: srv.fetchImpl });
  m.configure({ approve: true });
  m.setLive(true);
  m.onChat("kate", "/music one", {});
  await settle();
  assert.equal(m.pending.length, 1);
  assert.equal(m.current, null);
  m.approve(m.pending[0].uid);
  await settle();
  assert.equal(m.current?.title, "Song one");

  m.onChat("mod", "/music two", { isModeratorOfAnchor: true });
  await settle();
  assert.equal(m.pending.length, 0);
  assert.equal(m.queue.length, 1);
  m.setLive(false);
});

test("viewer votes skip; a moderator skips at once", async () => {
  const srv = fakeServer();
  const m = new Music({ account: okAccount, workDir: workDir(), fetchImpl: srv.fetchImpl });
  m.configure({ skipVotes: 2, perViewer: 5 });
  m.setLive(true);
  m.onChat("a", "/music one", {});
  await settle();
  m.onChat("a", "/music two", {});
  await settle();
  assert.equal(m.current.title, "Song one");
  assert.equal(m.onChat("x", "/skip", {}), "musicSkip");
  m.onChat("X", "/skip", {});
  assert.equal(m.current?.title, "Song one", "the same viewer twice is one vote");
  m.onChat("y", "/skip", {});
  await settle();
  assert.equal(m.current?.title, "Song two");
  m.onChat("mod", "/skip", { isAnchor: true });
  await settle();
  assert.equal(m.current, null);
  m.setLive(false);
});

test("a ban drops the entry and stays in the lists", async () => {
  const srv = fakeServer();
  const m = new Music({ account: okAccount, workDir: workDir(), fetchImpl: srv.fetchImpl });
  m.configure({ perViewer: 5 });
  m.setLive(true);
  m.onChat("kate", "/music one", {});
  m.onChat("bob", "/music two", {});
  await settle();
  const two = m.queue.find((t) => t.nick === "bob");
  const lists = m.ban(two.uid, "user");
  assert.deepEqual(lists.bannedUsers, ["bob"]);
  assert.equal(m.queue.length, 0);
  assert.deepEqual(MUSIC_DEFAULTS.bannedUsers, [], "the defaults are never edited");
  m.setLive(false);
});

test("off air every file goes and requests are ignored", async () => {
  const srv = fakeServer();
  const dir = workDir();
  const m = new Music({ account: okAccount, workDir: dir, fetchImpl: srv.fetchImpl });
  m.setLive(true);
  m.onChat("kate", "/music one", {});
  await settle();
  m.setLive(false);
  await settle();
  assert.deepEqual(fs.readdirSync(dir), []);
  m.onChat("kate", "/music two", {});
  await settle();
  assert.equal(m.queue.length, 0);
});

test("the local server: commands are not read out, files come with Range, the overlay page is served", async () => {
  const srv = fakeServer();
  const m = new Music({ account: okAccount, workDir: workDir(), fetchImpl: srv.fetchImpl });
  const s = new StreamServer(overlayDir, { music: m });
  const port = 8141;
  await s.start({ ...DEFAULTS, port }, { mock: true });
  const said = [];
  s.on("message", (x) => said.push(x));

  s.onChat("kate", "/music numb", {});
  await settle();
  assert.equal(said[0].spoken, false);
  assert.equal(said[0].reason, "music");
  assert.equal(s.queue.length, 0, "the speech queue never saw it");

  const uid = m.current.uid;
  const part = await fetch(`http://127.0.0.1:${port}/media/${uid}`, { headers: { range: "bytes=1-2" } });
  assert.equal(part.status, 206);
  assert.equal(await part.text(), "at");
  assert.equal((await fetch(`http://127.0.0.1:${port}/media/999`)).status, 404);
  const page = await fetch(`http://127.0.0.1:${port}/music`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /mgi-stream music/);

  await s.stop();
  assert.equal(m.current, null, "stopping the air stops the music");
});

test("with a state file the queue outlives off air and a restart, at the same second", async () => {
  const srv = fakeServer();
  const dir = workDir();
  const stateFile = path.join(dir, "..", `queue-${Date.now()}.json`);
  const m = new Music({ account: okAccount, workDir: dir, fetchImpl: srv.fetchImpl, stateFile });
  m.setLive(true);
  m.onChat("kate", "/music one", {});
  m.onChat("bob", "/music two", {});
  await settle();
  assert.ok(m.current);
  m.progress(m.current.uid, 42, false);
  const first = m.current.id;
  m.setLive(false);
  await settle();
  assert.equal(m.current, null);
  assert.ok(fs.readdirSync(dir).length >= 1);

  // A new process: the folder is swept, the saved files stay.
  const again = new Music({ account: okAccount, workDir: dir, fetchImpl: srv.fetchImpl, stateFile });
  again.sweep();
  await settle();
  let played = null;
  again.on("play", ({ track }) => (played = track));
  again.setLive(true);
  await settle();
  assert.equal(played.id, first);
  assert.equal(played.start, 42);
  assert.equal(again.queue.length + (again.current ? 1 : 0), 2);
  fs.rmSync(stateFile, { force: true });
});

test("the wishlist plays while nobody orders; a request goes after the track playing, then the wishlist goes on", async () => {
  const srv = fakeServer();
  const m = new Music({ account: okAccount, workDir: workDir(), fetchImpl: srv.fetchImpl });
  m.configure({});
  m.setLive(true);
  const played = [];
  m.on("play", ({ track }) => played.push(track.title));
  const wishes = [
    { id: "wishAAAAAAA", title: "A", channel: "", duration: 900 },
    { id: "wishBBBBBBB", title: "B", channel: "", duration: 200 },
  ];

  assert.equal(m.playWishlist(() => wishes, "вишлист"), true);
  await settle();
  assert.deepEqual(played, ["A"]);
  assert.equal(m.snapshot().wishlist, true);
  assert.equal(m.snapshot().current.wish, true);
  const fetchA = srv.calls.find((c) => c.route === "/fetch");
  assert.equal(fetchA.body.max_duration, undefined, "own tracks are not held to the viewers' limit");

  m.onChat("kate", "/music numb", {});
  await settle();
  assert.deepEqual(played, ["A"], "a request waits for the track playing");
  m.finished(m.current.uid);
  await settle();
  assert.deepEqual(played, ["A", "Song numb"]);
  m.finished(m.current.uid);
  await settle();
  assert.deepEqual(played, ["A", "Song numb", "B"], "the wishlist goes on where it was");
  m.finished(m.current.uid);
  await settle();
  assert.deepEqual(played, ["A", "Song numb", "B", "A"], "round and round");
  m.setLive(false);
});

test("a wishlist track starts at once over another wishlist track, and stop ends the wishlist", async () => {
  const srv = fakeServer();
  const m = new Music({ account: okAccount, workDir: workDir(), fetchImpl: srv.fetchImpl });
  m.configure({});
  m.setLive(true);
  const played = [];
  m.on("play", ({ track }) => played.push(track.title));
  const wishes = ["A", "B", "C"].map((t) => ({ id: "wish" + t.repeat(7), title: t }));

  m.playWishlist(() => wishes, "вишлист");
  await settle();
  m.playWishlist(() => wishes, "вишлист", "wishCCCCCCC");
  await settle();
  assert.deepEqual(played, ["A", "C"]);

  m.stopWishlist();
  await settle();
  assert.equal(m.current, null);
  assert.equal(m.snapshot().wishlist, false);
  assert.equal(m.wishNext, null);
  m.setLive(false);
});

test("off air the wishlist cannot start", () => {
  const m = new Music({ account: okAccount, workDir: workDir(), fetchImpl: fakeServer().fetchImpl });
  assert.equal(m.playWishlist(() => [{ id: "wishAAAAAAA", title: "A" }], "вишлист"), false);
});
