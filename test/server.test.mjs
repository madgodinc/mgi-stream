import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { StreamServer } from "../app/core/server.js";
import { DEFAULTS } from "../app/core/config.js";

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
