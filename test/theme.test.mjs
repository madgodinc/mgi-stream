import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ThemeSetting, readTheme, writeTheme } from "../app/core/theme.js";

test("the theme shares settings.json with the language and keeps its other keys", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mgi-theme-"));
  const file = path.join(dir, "settings.json");
  assert.equal(readTheme(file), "studio");
  fs.writeFileSync(file, "﻿" + JSON.stringify({ lang: "uk", asked: true, theme: "neon" }));
  assert.equal(readTheme(file), "studio", "an unknown id reads as the default");
  writeTheme(file, "amber");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual([saved.lang, saved.asked, saved.theme], ["uk", true, "amber"]);
  assert.throws(() => new ThemeSetting(file).set("neon"));
});

test("a theme picked in another MGI program reaches this one", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mgi-theme-"));
  const file = path.join(dir, "settings.json");
  const t = new ThemeSetting(file);
  t.watch();
  const got = new Promise((r) => t.once("change", r));
  writeTheme(file, "night");
  assert.equal(await Promise.race([got, new Promise((r) => setTimeout(() => r("timeout"), 3000))]), "night");
  t.stop();
});

test("picking a theme answers the first-run question for every program", async () => {
  const { readAsked } = await import("../app/core/theme.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mgi-theme-"));
  const file = path.join(dir, "settings.json");
  assert.equal(readAsked(file), false);
  writeTheme(file, "fog");
  assert.equal(readAsked(file), true);
  assert.deepEqual(new ThemeSetting(file).state(), { theme: "fog", asked: true });
});
