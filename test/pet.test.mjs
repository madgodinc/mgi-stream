import test from "node:test";
import assert from "node:assert/strict";
import { Pet } from "../app/core/pet.js";
import { giftText } from "../app/core/pet-phrases.js";

/** A pet on a hand-driven clock: `tick(ms)` moves time and fires what is due. */
function rig(cfg = {}) {
  let now = 1_000_000;
  let id = 0;
  const due = new Map();
  const sent = [];
  const timers = {
    set: (fn, ms) => {
      due.set(++id, { at: now + ms, fn });
      return id;
    },
    clear: (t) => due.delete(t),
  };
  const pet = new Pet({ send: (m) => sent.push(m), now: () => now, timers, random: () => 0 });
  pet.configure({ thoughts: false, ...cfg });
  pet.start();
  const tick = (ms) => {
    const end = now + ms;
    for (;;) {
      const next = [...due.entries()].filter(([, d]) => d.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at;
      due.delete(next[0]);
      next[1].fn();
    }
    now = end;
  };
  const said = () => sent.filter((m) => m.say && m.say.style === "speech").map((m) => m.say.text);
  sent.length = 0;
  return { pet, tick, said, sent };
}

test("a streak of roses gets one thanks with the final count", () => {
  const { pet, tick, said } = rig();
  tick(10000); // let the hello bubble pass
  for (let n = 1; n <= 15; n++) pet.gift({ nick: "Аня", giftId: 5655, name: "Rose", count: n, streakable: true, end: false });
  pet.gift({ nick: "Аня", giftId: 5655, name: "Rose", count: 15, streakable: true, end: true });
  tick(1000);
  assert.equal(said().length, 1);
  assert.match(said()[0], /15 роз/);
  assert.match(said()[0], /Аня/);
});

test("a streak that never says it ended is closed after a pause", () => {
  const { pet, tick, said } = rig();
  tick(10000);
  pet.gift({ nick: "Петя", giftId: 1, name: "Rose", count: 3, streakable: true, end: false });
  tick(4000);
  assert.equal(said().length, 0);
  tick(2000);
  assert.match(said()[0], /3 розы/);
});

test("plain gifts in a row from one viewer merge into one line", () => {
  const { pet, tick, said } = rig();
  tick(10000);
  for (let i = 0; i < 4; i++) pet.gift({ nick: "Оля", giftId: 9, name: "Perfume", diamonds: 20, count: 1 });
  tick(4000);
  assert.equal(said().length, 1);
  assert.match(said()[0], /4 духов/);
});

test("a shower from many viewers becomes one crowd line, not a minute of bubbles", () => {
  const { pet, tick, said } = rig();
  tick(10000);
  for (const nick of ["a", "b", "c", "d", "e", "f"]) pet.gift({ nick, giftId: 1, name: "Rose", count: 1 });
  tick(4000);
  assert.equal(said().length, 1);
  assert.match(said()[0], /и ещё 3/);
});

test("gifts that arrive while a bubble is up wait for it, then come merged", () => {
  const { pet, tick, said } = rig();
  tick(10000);
  pet.gift({ nick: "x", giftId: 1, name: "Rose", count: 1 });
  tick(3500);
  assert.equal(said().length, 1);
  pet.gift({ nick: "y", giftId: 1, name: "Rose", count: 1 });
  pet.gift({ nick: "z", giftId: 2, name: "TikTok", count: 1 });
  tick(1000);
  assert.equal(said().length, 1, "still showing the first thanks");
  tick(10000);
  assert.equal(said().length, 2);
  assert.match(said()[1], /y/);
  assert.match(said()[1], /z/);
});

test("thanks can be turned off; the slime still reacts", () => {
  const { pet, tick, said, sent } = rig({ thanks: false });
  tick(10000);
  pet.gift({ nick: "x", giftId: 1, name: "Rose", count: 1 });
  tick(5000);
  assert.equal(said().length, 0);
  assert.ok(sent.some((m) => m.fx));
});

test("gift names decline in Russian", () => {
  assert.equal(giftText("Rose", 1, "ru"), "розу");
  assert.equal(giftText("Rose", 2, "ru"), "2 розы");
  assert.equal(giftText("Rose", 11, "ru"), "11 роз");
  assert.equal(giftText("Rose", 21, "ru"), "21 роза");
  assert.equal(giftText("Something New", 3, "ru"), "«Something New» ×3");
});

test("hints from MGI Games take every other idle thought, in order", () => {
  const { pet, tick, sent } = rig({ thoughts: true });
  pet.hints(["!маргит - 1000", "!руны - 50"]);
  tick(4 * 50000);
  const thoughts = sent.filter((m) => m.say?.style === "thought").map((m) => m.say.text);
  assert.equal(thoughts.length, 4);
  assert.equal(thoughts[0], "!маргит - 1000");
  assert.notEqual(thoughts[1], "!руны - 50");
  assert.equal(thoughts[2], "!руны - 50");

  pet.hints([]);
  sent.length = 0;
  tick(2 * 50000);
  assert.ok(!sent.some((m) => m.say?.text?.startsWith("!")), "an empty list ends the hints");
});
