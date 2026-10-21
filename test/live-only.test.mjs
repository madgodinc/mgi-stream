import test from "node:test";
import assert from "node:assert/strict";
import { RecentIds } from "../app/core/server.js";

test("a message id is fresh once and never again", () => {
  const seen = new RecentIds();
  assert.equal(seen.fresh("7668934536985938696"), true);
  assert.equal(seen.fresh("7668934536985938696"), false);
  assert.equal(seen.fresh("7668934536985938696"), false);
});

test("different messages are unaffected by each other", () => {
  const seen = new RecentIds();
  assert.equal(seen.fresh("a"), true);
  assert.equal(seen.fresh("b"), true);
  assert.equal(seen.fresh("a"), false);
  assert.equal(seen.fresh("b"), false);
});

test("a message without an id is always spoken", () => {
  const seen = new RecentIds();
  assert.equal(seen.fresh(""), true);
  assert.equal(seen.fresh(""), true);
  assert.equal(seen.fresh(undefined), true);
});

test("only the recent ids are kept, oldest first out", () => {
  const seen = new RecentIds(3);
  for (const id of ["1", "2", "3"]) seen.fresh(id);

  // Still inside the window: all three are recognised as repeats.
  assert.equal(seen.fresh("2"), false);

  seen.fresh("4"); // pushes "1" out
  assert.equal(seen.ids.size, 3);
  assert.equal(seen.fresh("1"), true, "the oldest id is forgotten, not the newest");
  assert.equal(seen.fresh("4"), false);
});

test("a run that starts again forgets what the previous one heard", () => {
  const seen = new RecentIds();
  seen.fresh("x");
  const restarted = new RecentIds();
  assert.equal(restarted.fresh("x"), true);
});
