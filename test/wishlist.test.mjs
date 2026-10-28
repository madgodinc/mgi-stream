import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Wishlist } from "../app/core/wishlist.js";

test("the wishlist keeps a track once, newest first, across a restart", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wish-")), "wishlist.json");
  const w = new Wishlist(file);
  w.add({ id: "a", title: "A", duration: 60, uid: 7, state: "queued" });
  w.add({ id: "b", title: "B" });
  w.add({ id: "a", title: "A again" });
  w.add(null);
  assert.deepEqual(w.list().map((t) => t.id), ["b", "a"]);
  assert.equal(w.list()[1].uid, undefined);

  const again = new Wishlist(file);
  assert.deepEqual(again.list().map((t) => t.title), ["B", "A"]);
  again.remove("b");
  assert.deepEqual(new Wishlist(file).list().map((t) => t.id), ["a"]);
});

test("a broken wishlist file starts empty", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wish-")), "wishlist.json");
  fs.writeFileSync(file, "{nope");
  assert.deepEqual(new Wishlist(file).list(), []);
});
