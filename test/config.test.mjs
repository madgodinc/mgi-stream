import test from "node:test";
import assert from "node:assert/strict";
import { normalizeUsername } from "../app/core/config.js";

test("the channel name survives whatever was pasted into the field", () => {
  assert.equal(normalizeUsername("madgod"), "madgod");
  assert.equal(normalizeUsername("  @madgod "), "madgod");
  assert.equal(normalizeUsername("https://www.tiktok.com/@madgod"), "madgod");
  assert.equal(normalizeUsername("https://www.tiktok.com/@madgod/live?lang=ru"), "madgod");
  assert.equal(normalizeUsername("tiktok.com/@mad.god_1"), "mad.god_1");
});

test("an empty field stays empty rather than becoming a stray character", () => {
  assert.equal(normalizeUsername(""), "");
  assert.equal(normalizeUsername("   "), "");
  assert.equal(normalizeUsername(undefined), "");
});
