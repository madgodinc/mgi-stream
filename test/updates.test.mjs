import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { Updates, newer } from "../app/core/updates.js";

function fakeUpdater() {
  const u = new EventEmitter();
  u.downloads = 0;
  u.installs = 0;
  u.checkForUpdates = async () => u.emit("update-available", { version: "0.5.0" });
  u.downloadUpdate = async () => {
    u.downloads++;
    u.emit("download-progress", { percent: 50 });
    u.emit("update-downloaded");
  };
  u.quitAndInstall = () => u.installs++;
  return u;
}

test("versions compare by number", () => {
  assert.ok(newer("0.3.10", "0.3.9"));
  assert.ok(!newer("0.4.0", "0.4.0"));
});

test("an update is offered, downloaded only on request, then installed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upd-"));
  const u = fakeUpdater();
  const up = new Updates({ updater: u, version: "0.4.0", dir });
  assert.equal(u.autoDownload, false, "never downloads by itself");
  await up.check();
  assert.equal(up.info.state, "available");
  assert.equal(u.downloads, 0);
  up.install();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(u.downloads, 1);
  assert.equal(u.installs, 1);
});

test("a skipped version is not offered again", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upd-"));
  const up = new Updates({ updater: fakeUpdater(), version: "0.4.0", dir });
  await up.check();
  up.skip("0.5.0");
  await up.check();
  assert.equal(up.info.state, "idle");
});

test("seen remembers the last version that ran", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upd-"));
  assert.equal(new Updates({ updater: null, version: "0.4.0", dir }).seen(), "");
  assert.equal(new Updates({ updater: null, version: "0.4.1", dir }).seen(), "0.4.0");
});
