import test from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../app/core/actions.js";
import { normalizeStep } from "../app/core/rules.js";

/** An engine on a hand-driven clock, with every outside effect written to `trace`. */
function rig({ front = "dota2.exe" } = {}) {
  let now = 0;
  let id = 0;
  const due = new Map();
  const trace = [];
  const at = (s) => trace.push(`${now} ${s}`);
  const timers = {
    set: (fn, ms) => {
      due.set(++id, { at: now + ms, fn });
      return id;
    },
    clear: (t) => due.delete(t),
  };
  const held = new Set();
  const input = {
    down: (k) => (held.add(k), at(`down ${k}`)),
    up: (k) => (held.delete(k), at(`up ${k}`)),
    click: (b, d) => at(`click ${b} ${d ? "down" : "up"}`),
    releaseAll: () => {
      for (const k of held) at(`release ${k}`);
      held.clear();
    },
    foreground: () => front,
  };
  const media = [];
  const fx = {
    dim: (level, color) => at(`dim ${level} ${color}`),
    media: (s) => new Promise((done) => (at(`media ${s.file}`), media.push(done))),
    clear: () => at("clear"),
  };
  const pet = { say: (t) => at(`say ${t}`) };
  const sound = { play: (s) => at(`sound ${s.file}`), stop: () => at("sound stop") };
  const engine = new Engine({ input, fx, pet, sound, timers });
  const logs = [];
  engine.on("log", (l) => logs.push(`${l.type} ${l.name}`));
  const flush = () => new Promise((r) => setImmediate(r));
  const tick = async (ms) => {
    const end = now + ms;
    for (;;) {
      await flush();
      const next = [...due.entries()].filter(([, d]) => d.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at;
      due.delete(next[0]);
      next[1].fn();
    }
    now = end;
    await flush();
  };
  return { engine, trace, tick, logs, held, media, setFront: (f) => (front = f) };
}

const step = (s) => normalizeStep(s);
const job = (name, steps, extra = {}) => ({ name, who: "Петя", steps: steps.map(step), ...extra });

test("a key combo goes down in order and comes up in reverse", async () => {
  const { engine, trace, tick } = rig();
  engine.push(job("alttab", [{ kind: "key", code: "Tab", mods: ["alt"], hold_ms: 50 }]));
  await tick(1000);
  assert.deepEqual(trace, ["0 down alt", "0 down Tab", "50 up Tab", "50 up alt"]);
});

test("jobs run one at a time: the second waits for the first one's darkness to lift", async () => {
  const { engine, trace, tick, logs } = rig();
  engine.push(job("dark", [{ kind: "dim", level: 90, seconds: 10 }]));
  engine.push(job("press", [{ kind: "key", code: "KeyQ" }]));
  await tick(5000);
  assert.deepEqual(trace, ["0 dim 90 #000000"]);
  assert.equal(engine.queued, 1);
  await tick(20000);
  // Darkness 10 s, fade 0.6 s, the gap between jobs 0.4 s: the key at 11 s.
  assert.deepEqual(trace, ["0 dim 90 #000000", "10000 dim 0 #000000", "11000 down KeyQ", "11040 up KeyQ"]);
  assert.deepEqual(logs, ["fire dark", "done dark", "fire press", "done press"]);
});

test("a sequence with delays and repeats keeps its timing", async () => {
  const { engine, trace, tick } = rig();
  engine.push(job("tp", [
    { kind: "key", code: "KeyT", repeat: 2, hold_ms: 40, gap_ms: 60 },
    { kind: "delay", ms: 3000 },
    { kind: "say", text: "домой!" },
  ]));
  await tick(10000);
  assert.deepEqual(trace, ["0 down KeyT", "40 up KeyT", "100 down KeyT", "140 up KeyT", "3140 say домой!"]);
});

test("the kill switch stops the running job, releases held keys, clears the screen and the queue", async () => {
  const { engine, trace, tick, held, logs } = rig();
  engine.push(job("hold", [{ kind: "hold", code: "KeyW", seconds: 30 }, { kind: "key", code: "KeyQ" }]));
  engine.push(job("dark", [{ kind: "dim", level: 90, seconds: 10 }]));
  engine.push(job("later", [{ kind: "key", code: "KeyE" }]));
  await tick(2000);
  assert.ok(held.has("KeyW"));
  engine.kill();
  await tick(60000);
  assert.equal(held.size, 0);
  assert.equal(engine.queued, 0);
  assert.deepEqual(trace, ["0 down KeyW", "2000 release KeyW", "2000 dim 0 #000000", "2000 clear", "2000 sound stop", "2000 up KeyW"]);
  assert.ok(!trace.some((t) => t.includes("KeyQ") || t.includes("KeyE") || t.includes("dim 90")), "nothing after the kill runs");
  assert.ok(logs.includes("stop "));
  // The engine takes new work after a kill.
  engine.push(job("again", [{ kind: "key", code: "KeyR" }]));
  await tick(1000);
  assert.ok(trace.includes("2000 down KeyR") || trace.some((t) => t.endsWith("down KeyR")));
});

test("the kill switch during darkness brings the screen back at once and ends the job", async () => {
  const { engine, trace, tick } = rig();
  engine.push(job("dark", [{ kind: "dim", level: 100, color: "#ffffff", seconds: 60 }]));
  await tick(3000);
  engine.kill();
  await tick(70000);
  assert.deepEqual(trace, ["0 dim 100 #ffffff", "3000 dim 0 #000000", "3000 clear", "3000 sound stop"]);
  assert.equal(engine.running, false);
});

test("a job waits for its picture to leave the screen", async () => {
  const { engine, trace, tick, media } = rig();
  engine.push(job("pic", [{ kind: "media", file: "a.png", seconds: 5 }]));
  engine.push(job("next", [{ kind: "key", code: "KeyQ" }]));
  await tick(4000);
  assert.deepEqual(trace, ["0 media a.png"]);
  media[0]();
  await tick(1000);
  assert.ok(trace.some((t) => t.endsWith("down KeyQ")));
});

test("a rule for the game waits for it to be in front, and gives up after 30 s", async () => {
  const { engine, trace, tick, logs, setFront } = rig({ front: "obs64.exe" });
  engine.push(job("ult", [{ kind: "key", code: "KeyR" }], { game: "dota2.exe" }));
  await tick(5000);
  assert.deepEqual(trace, []);
  setFront("dota2.exe");
  await tick(1000);
  assert.ok(trace.some((t) => t.endsWith("down KeyR")));
  setFront("obs64.exe");
  engine.push(job("ult2", [{ kind: "key", code: "KeyR" }], { game: "dota2.exe" }));
  await tick(40000);
  assert.equal(trace.filter((t) => t.endsWith("down KeyR")).length, 1);
  assert.ok(logs.includes("skip ult2"));
});

test("an empty job is refused and a full queue drops the newcomer", async () => {
  const { engine } = rig();
  assert.equal(engine.push(job("nothing", [])), false);
  // One runs at once, thirty wait.
  for (let i = 0; i < 31; i++) assert.equal(engine.push(job("d" + i, [{ kind: "delay", ms: 1000 }])), true);
  assert.equal(engine.push(job("one too many", [{ kind: "delay", ms: 1000 }])), false);
});

test("a step that throws releases the keys and the queue goes on", async () => {
  const { engine, trace, tick, logs } = rig();
  engine.input.down = (k) => {
    if (k === "KeyZ") throw new Error("unknown key KeyZ");
    trace.push(`down ${k}`);
  };
  engine.push(job("bad", [{ kind: "key", code: "KeyZ" }]));
  engine.push(job("good", [{ kind: "key", code: "KeyQ" }]));
  await tick(2000);
  assert.ok(logs.includes("error bad"));
  assert.ok(trace.includes("down KeyQ"));
});
