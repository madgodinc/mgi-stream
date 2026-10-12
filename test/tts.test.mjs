import test from "node:test";
import assert from "node:assert/strict";
import { Speaker, ssml, escapeXml, fallbackFor } from "../app/core/tts.js";

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
  assert.equal(fallbackFor("ru-RU-DmitryNeural"), "en-US-AndrewMultilingualNeural");
  for (let i = 0; i < 4; i++) assert.equal(String(await s.synth("p" + i)), "p" + i);
  // Two phrases pay for two tries each on the dead voice, then it is skipped.
  assert.deepEqual(asked.filter((v) => v === "ru-RU-DmitryNeural").length, 4);
  assert.equal(s.stats.fallback, 4);
});
