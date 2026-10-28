import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { load, normalizePet, normalizeUsername, save } from "../app/core/config.js";

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

test("the slime stays on screen unless it was switched off on purpose", () => {
  assert.equal(normalizePet(undefined).showSlime, true);
  assert.equal(normalizePet({ name: "Блоб" }).showSlime, true);
  assert.equal(normalizePet({ showSlime: "no" }).showSlime, true);
  assert.equal(normalizePet({ showSlime: false }).showSlime, false);
  assert.equal(normalizePet({ showSlime: false }).name, "Слаймик");
});

test("an old config gets the slime shown, and switching it off survives a save", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mgi-cfg-"));
  try {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ pet: { color: "pink" } }));
    assert.equal(load(dir).pet.showSlime, true);
    const cfg = load(dir);
    cfg.pet.showSlime = false;
    save(dir, cfg);
    assert.equal(load(dir).pet.showSlime, false);
    assert.equal(load(dir).pet.color, "pink");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
