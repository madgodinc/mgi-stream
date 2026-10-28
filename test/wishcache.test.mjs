import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WishCache } from "../app/core/wishcache.js";
import { Music } from "../app/core/music.js";

const okAccount = { token: "tok", status: () => ({ ok: true }) };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mgi-wishcache-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  while (!fn() && Date.now() < end) await sleep(10);
  return fn();
};

/** The music server; `down` makes every call fail the way it does when YouTube is out of reach. */
function fakeServer() {
  const srv = { calls: [], down: false, broken: new Set() };
  const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  srv.fetchImpl = async (url, init = {}) => {
    const route = url.replace(/^.*\/music\/api/, "");
    srv.calls.push(route);
    if (srv.down) return json(502, { error: "youtube unreachable" });
    // A broken track fails after a while, as a stuck YouTube download does.
    if (route === "/fetch" && srv.broken.has(JSON.parse(init.body).id)) {
      await sleep(100);
      return json(502, { error: "youtube unreachable" });
    }
    if (route === "/fetch") return json(200, { job: "job" + srv.calls.length, video: JSON.parse(init.body).video });
    if (route.startsWith("/job/")) return json(200, { state: "ready" });
    if (route.startsWith("/file/")) return new Response("server-bytes", { status: 200, headers: { "x-media-ext": "mp4" } });
    return json(404, {});
  };
  return srv;
}

test("a track already downloaded is copied on add, not fetched again", async () => {
  const dir = tmp();
  const src = path.join(tmp(), "7.mp4");
  fs.writeFileSync(src, "queue-bytes");
  let downloads = 0;
  const ids = ["wishAAAAAAA"];
  const c = new WishCache({ dir, wanted: () => ids, download: async () => downloads++ });
  await c.add("wishAAAAAAA", { file: src, ext: "mp4", video: true });
  assert.equal(downloads, 0);
  assert.deepEqual(c.get("wishAAAAAAA"), { file: path.join(dir, "wishAAAAAAA.video.mp4"), ext: "mp4", video: true });
  assert.equal(fs.readFileSync(c.get("wishAAAAAAA").file, "utf8"), "queue-bytes");
  assert.ok(fs.existsSync(src), "the queue keeps its own file");
});

test("a track not downloaded yet comes down in the background, one at a time, and again after a failure", async () => {
  const dir = tmp();
  const ids = ["wishAAAAAAA", "wishBBBBBBB"];
  let running = 0;
  let most = 0;
  let fail = true;
  const download = async (id, d, name) => {
    most = Math.max(most, ++running);
    await sleep(5);
    running--;
    if (fail && id === "wishAAAAAAA") throw new Error("youtube unreachable");
    const file = path.join(d, name + ".m4a");
    fs.writeFileSync(file, id);
    return { file, ext: "m4a", video: false };
  };
  const c = new WishCache({ dir, wanted: () => ids, download, retryMs: 30 });
  c.add("wishAAAAAAA");
  c.add("wishBBBBBBB");
  assert.ok(await until(() => c.has("wishBBBBBBB")));
  assert.equal(c.has("wishAAAAAAA"), false);
  fail = false;
  assert.ok(await until(() => c.has("wishAAAAAAA")), "tried again after the pause");
  assert.equal(most, 1);
  assert.equal(c.get("wishBBBBBBB").video, false);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["wishAAAAAAA.audio.m4a", "wishBBBBBBB.audio.m4a"], "no .part left behind");
  c.stop();
});

test("removing a track deletes its file, unless it is playing; startup drops strays and fetches what is missing", async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "wishAAAAAAA.video.mp4"), "a");
  fs.writeFileSync(path.join(dir, "goneGONEGON.video.mp4"), "old");
  fs.writeFileSync(path.join(dir, "wishAAAAAAA.part.mp4"), "half");
  let ids = ["wishAAAAAAA", "wishBBBBBBB"];
  const asked = [];
  const download = async (id, d, name) => {
    asked.push(id);
    const file = path.join(d, name + ".mp4");
    fs.writeFileSync(file, id);
    return { file, ext: "mp4", video: true };
  };
  const c = new WishCache({ dir, wanted: () => ids, download });
  c.sync();
  assert.ok(await until(() => c.has("wishBBBBBBB")));
  assert.deepEqual(asked, ["wishBBBBBBB"]);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["wishAAAAAAA.video.mp4", "wishBBBBBBB.video.mp4"]);

  c.hold("wishAAAAAAA");
  ids = ["wishBBBBBBB"];
  c.remove("wishAAAAAAA");
  assert.ok(fs.existsSync(path.join(dir, "wishAAAAAAA.video.mp4")), "the playing file stays");
  c.release("wishAAAAAAA");
  assert.ok(await until(() => !fs.existsSync(path.join(dir, "wishAAAAAAA.video.mp4"))), "and goes once it has played");

  ids = [];
  c.remove("wishBBBBBBB");
  assert.ok(await until(() => fs.readdirSync(dir).length === 0));
  assert.equal(c.has("wishBBBBBBB"), false);
});

test("a saved wishlist track plays from its copy without the server, and the copy outlives the play", async () => {
  const srv = fakeServer();
  srv.down = true;
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "wishAAAAAAA.video.mp4"), "kept");
  const wishes = [{ id: "wishAAAAAAA", title: "A" }];
  const cache = new WishCache({ dir, wanted: () => wishes.map((w) => w.id), download: () => Promise.reject(new Error("no")) });
  const m = new Music({ account: okAccount, workDir: tmp(), fetchImpl: srv.fetchImpl, cache });
  m.configure({});
  m.setLive(true);
  const played = [];
  m.on("play", ({ track }) => played.push(track));
  m.playWishlist(() => wishes, "вишлист");
  assert.ok(await until(() => played.length === 1));
  assert.deepEqual(srv.calls, [], "the server was never asked");
  assert.equal(played[0].ext, "mp4");
  assert.equal(m.fileOf(played[0].uid).file, path.join(dir, "wishAAAAAAA.video.mp4"));
  m.stopWishlist();
  await sleep(30);
  assert.ok(fs.existsSync(path.join(dir, "wishAAAAAAA.video.mp4")), "playing it did not delete it");
  m.setLive(false);
});

test("without a copy the wishlist goes to the server and skips a failure; a track that comes down is kept", async () => {
  const srv = fakeServer();
  srv.broken.add("wishBBBBBBB");
  const dir = tmp();
  const wishes = [
    { id: "wishAAAAAAA", title: "A" },
    { id: "wishBBBBBBB", title: "B" },
  ];
  const cache = new WishCache({ dir, wanted: () => wishes.map((w) => w.id), download: () => Promise.reject(new Error("later")) });
  const m = new Music({ account: okAccount, workDir: tmp(), fetchImpl: srv.fetchImpl, cache });
  m.configure({});
  m.setLive(true);
  const played = [];
  m.on("play", ({ track }) => played.push(track.title));
  m.playWishlist(() => wishes, "вишлист");
  assert.ok(await until(() => played.length === 1));
  assert.ok(await until(() => cache.has("wishAAAAAAA")), "the downloaded track was copied in");
  assert.equal(fs.readFileSync(cache.get("wishAAAAAAA").file, "utf8"), "server-bytes");

  // B fails while A plays; A is next again and needs no download now.
  assert.ok(await until(() => m.wishNext?.id === "wishAAAAAAA" && m.wishNext.state === "ready"));
  m.finished(m.current.uid);
  assert.ok(await until(() => played.length === 2));
  assert.deepEqual(played, ["A", "A"]);
  assert.equal(m.fileOf(m.current.uid).file, cache.get("wishAAAAAAA").file, "the second A came from the copy");
  assert.equal(m.wish.fails, 0, "the play from the copy reset the failures");
  m.setLive(false);
});
