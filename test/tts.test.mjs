import test from "node:test";
import assert from "node:assert/strict";
import { Speaker, ssml, escapeXml, fallbackFor, silence, join } from "../app/core/tts.js";

test("chat text cannot break the SSML", () => {
  assert.equal(escapeXml(`a & b <c> "d" 'e'`), "a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;");
  const doc = ssml("ru-RU-DmitryNeural", { rate: "+0%", pitch: "+0Hz" }, "</prosody><x>");
  assert.ok(doc.includes("&lt;/prosody&gt;&lt;x&gt;"));
  assert.ok(doc.includes('xml:lang="ru-RU"'));
});

test("a failed attempt is retried on a new request until one works", async () => {
  let calls = 0;
  const s = new Speaker({ voice: "v", rate: 0, pitch: 0 }, {
    attempts: 5,
    fallback: null,
    request: async () => {
      if (++calls < 3) throw new Error("closed 1006");
      return Buffer.from("ok");
    },
  });
  assert.equal(String(await s.synth("hi")), "ok");
  assert.equal(calls, 3);
  assert.deepEqual(s.stats, { ok: 1, failed: 0, retries: 2, fallback: 0 });
});

test("a phrase no voice can say throws once", async () => {
  let calls = 0;
  const s = new Speaker({ voice: "v", rate: 0, pitch: 0 }, {
    attempts: 2,
    fallback: "w",
    fallbackAttempts: 3,
    request: async () => {
      calls++;
      throw new Error("closed 1006");
    },
  });
  await assert.rejects(s.synth("hi"), /closed 1006 \(no voice could say it\)/);
  assert.equal(calls, 5);
  assert.equal(s.stats.failed, 1);
});

test("a dead voice hands its phrases to the fallback and is benched", async () => {
  const asked = [];
  const s = new Speaker({ voice: "ru-RU-DmitryNeural", rate: 0, pitch: 0 }, {
    request: async (voice, _p, text) => {
      asked.push(voice);
      if (voice === "ru-RU-DmitryNeural") throw new Error("closed 1006");
      return Buffer.from(text);
    },
  });
  assert.equal(fallbackFor("ru-RU-DmitryNeural"), "sub:aidar");
  for (let i = 0; i < 4; i++) assert.equal(String(await s.synth("p" + i)), "p" + i);
  // Two phrases pay for two tries each on the dead voice, then it is skipped.
  assert.deepEqual(asked.filter((v) => v === "ru-RU-DmitryNeural").length, 4);
  assert.equal(s.stats.fallback, 4);
});

test("a nickname is said faster, on its own request, with silence before the message", async () => {
  const asked = [];
  const s = new Speaker({ voice: "v", rate: 8, pitch: 0, nickRate: 40, nickPause: 240 }, {
    fallback: null,
    request: async (_v, prosody, text) => {
      asked.push([text, prosody.rate]);
      return Buffer.from(text);
    },
  });
  const mp3 = await s.synth({ lead: "Катя", body: "привет" });
  assert.deepEqual(asked.sort(), [["Катя", "+48%"], ["привет", "+8%"]]);
  assert.deepEqual(mp3, Buffer.concat([Buffer.from("Катя"), silence(240), Buffer.from("привет")]));
  // 240 ms is ten 24 ms frames of 144 bytes.
  assert.equal(silence(240).length, 1440);
});

test("a phrase without a nickname stays one request at the voice speed", async () => {
  const asked = [];
  const s = new Speaker({ voice: "v", rate: 8, pitch: 0, nickRate: 40, nickPause: 300 }, {
    fallback: null,
    request: async (_v, prosody, text) => {
      asked.push([text, prosody.rate]);
      return Buffer.from(text);
    },
  });
  assert.equal(String(await s.synth({ lead: "", body: "привет" })), "привет");
  assert.equal(String(await s.synth("ok")), "ok");
  assert.deepEqual(asked, [["привет", "+8%"], ["ok", "+8%"]]);
});

test("our voices go to the gateway and Edge ones to Edge, fallback included", async () => {
  const seen = [];
  const s = new Speaker({ voice: "mgi:57", rate: 0, pitch: 0, mgiUrl: "u", mgiKey: "" }, { attempts: 1, fallbackAttempts: 1 });
  // No key: the gateway refuses before any network, so the fallback is asked.
  s.fallback = "edge-voice";
  const orig = s.request;
  s.request = (v, ...rest) => (seen.push(v), v === "edge-voice" ? Promise.resolve(Buffer.from("mp3")) : orig(v, ...rest));
  assert.equal(String(await s.synth("hi")), "mp3");
  assert.deepEqual(seen, ["mgi:57", "edge-voice"]);
});

test("WAV parts join as samples with a silent gap", () => {
  const clip = (samples) => {
    const pcm = Buffer.alloc(samples * 2, 1);
    const h = Buffer.alloc(44);
    h.write("RIFF", 0, "latin1");
    h.writeUInt32LE(22050, 24);
    return Buffer.concat([h, pcm]);
  };
  const out = join(clip(10), clip(20), 100);
  assert.equal(out.toString("latin1", 0, 4), "RIFF");
  assert.equal(out.readUInt32LE(24), 22050);
  // 10 + 2205 silent + 20 samples, two bytes each.
  assert.equal(out.readUInt32LE(40), (10 + 2205 + 20) * 2);
  assert.equal(out.length, 44 + (10 + 2205 + 20) * 2);
});

test("Mad's voice goes through the subscription when there is no gateway key", async () => {
  const { mgiRequest, useSubscription, rateStep } = await import("../app/core/tts.js");
  assert.equal(rateStep("+0%"), "medium");
  assert.equal(rateStep("+40%"), "x-fast");
  assert.equal(rateStep("-20%"), "x-slow");
  const seen = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url, init });
    return new Response(Buffer.from("RIFF"), { status: 200 });
  };
  try {
    useSubscription(() => "device-token");
    await mgiRequest({ url: "https://gw/ai/v1", key: "" })("mgi:57", { rate: "+10%" }, "привет");
    assert.match(seen[0].url, /stream\/api\/tts$/);
    assert.equal(seen[0].init.headers["X-MGI-Product"], "tiktok");
    assert.deepEqual(JSON.parse(seen[0].init.body), { text: "привет", speaker: "mad", rate: "fast", format: "wav" });
    await assert.rejects(mgiRequest({ url: "https://gw/ai/v1", key: "" })("mgi:52", { rate: "+0%" }, "x"), /no MGI key/);
    useSubscription(() => null);
    await assert.rejects(mgiRequest({ url: "https://gw/ai/v1", key: "" })("mgi:57", { rate: "+0%" }, "x"), /no MGI key/);
  } finally {
    globalThis.fetch = real;
    useSubscription(() => null);
  }
});
