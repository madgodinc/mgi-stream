import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Banks } from "../app/core/banks.js";
import { Streaks, parseGift } from "../app/core/gifts.js";
import { normalizeRules, giftRulesFor, stepsText } from "../app/core/rules.js";
import { StreamServer } from "../app/core/server.js";
import { fileURLToPath } from "node:url";

const dark = [{ kind: "dim", level: 90, color: "#000000", seconds: 10 }];
const line = (...goals) => normalizeRules({ banks: goals.map((goal, i) => ({ id: "b" + i, name: "Bank" + i, goal, steps: dark })) }).banks;
const rose = (nick, count, end = false) => ({ nick, giftId: 5655, name: "Rose", diamonds: 1, count, streakable: true, end });
const plain = (nick, name, diamonds, count = 1) => ({ nick, giftId: name, name, diamonds, count, streakable: false, end: true });
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mgi-banks-")), "banks.json");

test("a rose streak counts every tap once, the closing event adds nothing", () => {
  const banks = new Banks();
  banks.configure(line(100));
  for (let n = 1; n <= 15; n++) banks.gift(rose("Аня", n));
  banks.gift(rose("Аня", 15, true));
  assert.equal(banks.snapshot().banks[0].have, 15);
  // The closing event delivered twice by a reconnect is still nothing new.
  banks.gift(rose("Аня", 15, true));
  assert.equal(banks.snapshot().banks[0].have, 15);
});

test("streak counts that skip ahead count the gap; a new streak starts from its own count", () => {
  let now = 0;
  const s = new Streaks({ now: () => now });
  assert.equal(s.take(rose("a", 1)), 1);
  assert.equal(s.take(rose("a", 4)), 3); // taps 2-4 arrived as one event
  assert.equal(s.take(rose("a", 4)), 0); // a repeat
  assert.equal(s.take(rose("a", 5, true)), 1);
  assert.equal(s.take(rose("a", 1)), 1); // the next streak
  assert.equal(s.take(rose("a", 2)), 1);
  assert.equal(s.take(rose("b", 2)), 2); // someone else's streak is their own
  // A streak that ended without saying so, then a fresh one: lower count means new.
  assert.equal(s.take(rose("a", 1)), 1);
  now += 6000;
  assert.equal(s.take(rose("a", 1)), 1, "after the quiet spell the old streak is forgotten");
  assert.equal(s.take(plain("a", "Galaxy", 1000)), 1);
  assert.equal(s.take(plain("a", "Galaxy", 1000)), 1, "plain gifts always count");
});

test("a full bank fires and the overflow carries into the next one", () => {
  const banks = new Banks();
  banks.configure(line(350, 100, 500));
  const fired = [];
  banks.on("fill", (f) => fired.push(f));
  banks.add(300, "Петя");
  assert.equal(banks.active().id, "b0");
  banks.gift(plain("Богач", "Doughnut", 30, 4)); // 120 coins: 50 finish b0, 70 go to b1
  assert.deepEqual(fired.map((f) => [f.bank, f.nick]), [["b0", "Богач"]]);
  assert.deepEqual(fired[0].top, [["Петя", 300], ["Богач", 50]]);
  assert.deepEqual(fired[0].steps, dark);
  const snap = banks.snapshot();
  assert.equal(snap.active, "b1");
  assert.deepEqual(snap.banks.map((b) => b.have), [0, 70, 0]);
});

test("one big gift can fill several banks in order, and the line starts over after the last", () => {
  const banks = new Banks();
  banks.configure(line(100, 200));
  const fired = [];
  banks.on("fill", (f) => fired.push(f.bank));
  banks.gift(plain("Кит", "Galaxy", 1000));
  // 100 + 200 + 100 + 200 + 100 + 200 = 900, then 100 into b0 fills it again
  assert.deepEqual(fired, ["b0", "b1", "b0", "b1", "b0", "b1", "b0"]);
  assert.equal(banks.active().id, "b1");
  assert.deepEqual(banks.snapshot().banks.map((b) => b.have), [0, 0]);
});

test("a paused bank is stepped over; a reorder changes who is next", () => {
  const banks = new Banks();
  const banksCfg = line(100, 100, 100);
  banksCfg[1].paused = true;
  banks.configure(banksCfg);
  const fired = [];
  banks.on("fill", (f) => fired.push(f.bank));
  banks.add(150, "x");
  assert.deepEqual(fired, ["b0"]);
  assert.equal(banks.active().id, "b2");
  assert.equal(banks.snapshot().banks[2].have, 50);
  // The streamer drags b1 to the front and unpauses it; b2 keeps its 50 and stays current.
  banks.configure([{ ...banksCfg[1], paused: false }, banksCfg[0], banksCfg[2]]);
  assert.equal(banks.active().id, "b2");
  banks.add(50, "y");
  assert.deepEqual(fired, ["b0", "b2"]);
  assert.equal(banks.active().id, "b1", "after the last the line starts over from the new first");
});

test("every bank paused: coins are not kept anywhere", () => {
  const banks = new Banks();
  const cfg = line(100);
  cfg[0].paused = true;
  banks.configure(cfg);
  assert.deepEqual(banks.add(50, "x"), []);
  assert.equal(banks.active(), null);
  assert.equal(banks.snapshot().banks[0].have, 0);
  assert.deepEqual(banks.viewerState(), { kind: "bank", on: false });
});

test("reset empties a jar, keeps its log; a lowered goal fills on the next coin", () => {
  const banks = new Banks();
  banks.configure(line(100));
  banks.add(130, "a");
  banks.reset("b0");
  assert.equal(banks.snapshot().banks[0].have, 0);
  assert.equal(banks.snapshot().log.length, 1);
  banks.add(80, "b");
  const fired = [];
  banks.on("fill", (f) => fired.push(f));
  banks.configure(line(50));
  banks.add(1, "c");
  assert.equal(fired.length, 1);
  assert.equal(fired[0].nick, "c");
  assert.equal(banks.snapshot().banks[0].have, 1, "the coin that tipped it over starts the next round");
});

test("a gift into a tiny goal fires at most 20 times and keeps the rest one short of full", () => {
  const banks = new Banks();
  banks.configure(line(10));
  const fills = banks.add(44999, "Вселенная");
  assert.equal(fills.length, 20);
  assert.equal(banks.snapshot().banks[0].have, 9);
});

test("progress, position and the log survive a restart", () => {
  const file = tmp();
  const a = new Banks({ stateFile: file });
  a.configure(line(100, 100));
  a.add(130, "Петя");
  a.add(5, "Аня");
  a.flush();
  const b = new Banks({ stateFile: file });
  b.configure(line(100, 100));
  const snap = b.snapshot();
  assert.equal(snap.active, "b1");
  assert.deepEqual(snap.banks.map((x) => x.have), [0, 35]);
  assert.deepEqual(snap.banks[1].round, [["Петя", 30], ["Аня", 5]]);
  assert.equal(snap.log[0].nick, "Петя");
  // A bank removed from the settings takes its jar with it.
  b.configure(line(100));
  b.flush();
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, "utf8")).jars), ["b0"]);
});

test("a broken state file starts empty", () => {
  const file = tmp();
  fs.writeFileSync(file, "{not json");
  const b = new Banks({ stateFile: file });
  b.configure(line(100));
  assert.equal(b.snapshot().banks[0].have, 0);
});

test("the viewer sees the bank being filled now", () => {
  const banks = new Banks();
  banks.configure(line(350));
  banks.add(210, "x");
  assert.deepEqual(banks.viewerState(), { kind: "bank", on: true, id: "b0", name: "Bank0", have: 210, goal: 350 });
});

test("parseGift reads the connector's combo fields", () => {
  const g = parseGift({ user: { nickname: "Аня", displayId: "anya", id: "7001" }, giftId: 5655, repeatCount: 3, repeatEnd: false, giftDetails: { giftName: "Rose", diamondCount: 1, giftType: 1 }, common: { msgId: "77" } });
  assert.deepEqual(g, { nick: "Аня", id: "anya", uid: "7001", giftId: 5655, name: "Rose", diamonds: 1, count: 3, streakable: true, end: false, key: "77|3|0" });
  assert.equal(parseGift({ giftDetails: { giftName: "Galaxy", diamondCount: 1000, giftType: 2 } }).end, true);
});

test("the server feeds a streak to the banks once and tells which gifts were new", async () => {
  const overlayDir = fileURLToPath(new URL("../app/overlay", import.meta.url));
  const banks = new Banks();
  banks.configure(line(1000));
  const server = new StreamServer(overlayDir, { banks });
  const gifts = [];
  server.on("gift", (g) => gifts.push([g.name, g.fresh]));
  for (let n = 1; n <= 5; n++) server.onGift(rose("Аня", n, n === 5));
  server.onGift(plain("Кит", "Galaxy", 1000));
  assert.deepEqual(gifts, [["Rose", 1], ["Rose", 1], ["Rose", 1], ["Rose", 1], ["Rose", 1], ["Galaxy", 1]]);
  assert.equal(banks.snapshot().log[0].nick, "Кит");
});

test("rules: bad values are clamped, unknown steps dropped, gift names matched loosely", () => {
  const r = normalizeRules({
    banks: [{ id: "x", name: "", goal: -5, steps: [{ kind: "key", code: "KeyR", repeat: 900, hold_ms: 1e9 }, { kind: "warp" }, { kind: "dim", level: 300, color: "red" }] }],
    gifts: [{ gift: " Galaxy ", steps: dark }, { gift: "Lion", enabled: false, steps: dark }],
  });
  const b = r.banks[0];
  assert.equal(b.name, "Копилка 1");
  assert.equal(b.goal, 1);
  assert.deepEqual(b.steps.map((s) => s.kind), ["key", "dim"]);
  assert.equal(b.steps[0].repeat, 50);
  assert.equal(b.steps[0].hold_ms, 10000);
  assert.equal(b.steps[1].level, 100);
  assert.equal(b.steps[1].color, "#000000");
  assert.equal(giftRulesFor(r.gifts, "galaxy").length, 1);
  assert.equal(giftRulesFor(r.gifts, "Lion").length, 0, "a switched-off rule never fires");
  assert.equal(r.fx.killKey, "Ctrl+Shift+End");
});

test("rules read as a sentence", () => {
  const steps = normalizeRules({ banks: [{ steps: [
    { kind: "dim", seconds: 10 },
    { kind: "key", code: "Tab", mods: ["alt"] },
    { kind: "delay", ms: 3000 },
    { kind: "key", code: "KeyT", repeat: 2 },
    { kind: "say", text: "Темнота!" },
  ] }] }).banks[0].steps;
  assert.equal(stepsText(steps, "ru"), "затемнить экран на 10 с, потом нажать Alt+Tab, потом подождать 3 с, потом нажать T 2 раза, потом слайм скажет «Темнота!»");
  assert.equal(stepsText([], "ru"), "ничего не делать (добавьте действие)");
});
