import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { StreamServer } from "../app/core/server.js";
import { DEFAULTS } from "../app/core/config.js";
import { Speaker } from "../app/core/tts.js";

const PORT = 8139;
const overlayDir = new URL("../app/overlay", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

// Mock mode keeps the sample chat on a five second timer, so a test that
// finishes in milliseconds never reaches the network.
const started = async (cfg = {}) => {
  const s = new StreamServer(overlayDir);
  await s.start({ ...DEFAULTS, port: PORT, ...cfg }, { mock: true });
  return s;
};

test("stopping releases the port while an overlay is still connected", async () => {
  const s = await started();
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  await new Promise((open) => ws.on("open", open));

  // The bug this guards: closing the ws server leaves its sockets open, so
  // http.close() waits forever and both "stop" and window close hang.
  await Promise.race([
    s.stop(),
    new Promise((_, fail) => setTimeout(() => fail(new Error("stop() hung")), 5000)),
  ]);

  const again = await started();
  await again.stop();
});

test("the overlay is not served to the rest of the network", async () => {
  const s = await started();
  assert.equal(s.http.address().address, "127.0.0.1");
  await s.stop();
});

test("edited settings reach a running session, except the two that cannot move", async () => {
  const s = await started({ username: "someone", voice: "ru-RU-DmitryNeural" });
  const before = s.speaker;

  s.update({ ...DEFAULTS, username: "somebody-else", port: 9999, audience: "moderators", skipLinks: false });
  assert.equal(s.cfg.audience, "moderators", "filter settings apply live");
  assert.equal(s.cfg.skipLinks, false);
  assert.equal(s.cfg.username, "someone", "the channel needs a restart");
  assert.equal(s.cfg.port, PORT, "so does the port");
  assert.equal(s.speaker, before, "an unchanged voice keeps its open socket");

  s.update({ ...DEFAULTS, voice: "ru-RU-SvetlanaNeural" });
  assert.notEqual(s.speaker, before, "a changed voice gets a new speaker");
  await s.stop();
});

test("settings edited while off air change nothing", async () => {
  const s = new StreamServer(overlayDir);
  s.update({ ...DEFAULTS, audience: "moderators" });
  assert.equal(s.cfg, null);
});

test("a speech failure skips the phrase and never stops the session", async () => {
  const s = await started();
  const events = [];
  for (const name of ["status", "speak", "unspoken"]) s.on(name, (e) => events.push([name, e]));

  // The first phrase fails every try, the second one works.
  let calls = 0;
  s.speaker = new Speaker(DEFAULTS, {
    attempts: 2,
    fallback: null,
    request: async () => {
      calls++;
      if (calls <= 2) throw new Error("speech service closed the socket (1006) before the end");
      return Buffer.from("mp3");
    },
  });

  s.onChat("one", "first phrase");
  s.onChat("two", "second phrase");
  await new Promise((done) => setTimeout(done, 50));

  const unspoken = events.filter(([n]) => n === "unspoken").map(([, e]) => e.text);
  const spoken = events.filter(([n]) => n === "speak").map(([, e]) => e.text);
  assert.deepEqual(unspoken, ["first phrase"]);
  assert.deepEqual(spoken, ["second phrase"], "the next phrase is still voiced");
  assert.equal(s.running, true, "the session keeps running");

  const statuses = events.filter(([n]) => n === "status").map(([, e]) => e);
  assert.ok(statuses.every((e) => e.state !== "off" && (e.state !== "error" || e.soft)), "no hard stop");
  assert.equal(statuses.at(-1).state, "live", "recovery puts the live status back");
  await s.stop();
});
