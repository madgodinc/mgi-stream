import test from "node:test";
import assert from "node:assert/strict";
import { decide } from "../app/core/filter.js";
import { DEFAULTS } from "../app/core/config.js";

const msg = (nick, text, identity = {}) => ({ nick, text, identity });
const run = (cfg, message) => decide({ ...DEFAULTS, ...cfg }, message);

test("ordinary chat is spoken", () => {
  assert.equal(run({}, msg("viewer", "привет")).speak, true);
});

test("noise is filtered out", () => {
  assert.equal(run({}, msg("viewer", "🔥🔥🔥")).speak, false);
  assert.equal(run({}, msg("viewer", "go to www.spam.com")).speak, false);
  assert.equal(run({}, msg("viewer", "a")).speak, false);
});

test("the ignore list ignores case", () => {
  assert.equal(run({ ignoreUsers: ["Spammer"] }, msg("spammer", "привет")).speak, false);
});

test("audience tiers use the viewer identity", () => {
  const text = msg("viewer", "привет");
  const follower = msg("viewer", "привет", { isFollowerOfAnchor: true });
  const sub = msg("viewer", "привет", { isSubscriberOfAnchor: true });
  const mod = msg("viewer", "привет", { isModeratorOfAnchor: true });

  assert.equal(run({ audience: "followers" }, text).speak, false);
  assert.equal(run({ audience: "followers" }, follower).speak, true);
  assert.equal(run({ audience: "subscribers" }, follower).speak, false);
  assert.equal(run({ audience: "moderators" }, sub).speak, false);
  assert.equal(run({ audience: "moderators" }, mod).speak, true);
});

test("the allow list outranks the audience tier", () => {
  const cfg = { audience: "moderators", allowUsers: ["vip"] };
  assert.equal(run(cfg, msg("vip", "привет")).speak, true);
  assert.equal(run(cfg, msg("someone", "привет")).speak, false);
});

test("whitelist mode reads nobody else", () => {
  const cfg = { audience: "whitelist", allowUsers: ["vip"] };
  assert.equal(run(cfg, msg("vip", "привет")).speak, true);
  assert.equal(run(cfg, msg("mod", "привет", { isModeratorOfAnchor: true })).speak, false);
});

test("the prefix gates the message and stays out of the speech", () => {
  const cfg = { requirePrefix: true, sayNickname: false };
  assert.equal(run(cfg, msg("viewer", "привет")).speak, false);
  assert.equal(run(cfg, msg("viewer", "!привет")).phrase, "привет");
});

test("long messages are cut instead of read forever", () => {
  const cfg = { sayNickname: false, maxChars: 10 };
  assert.equal(run(cfg, msg("viewer", "x".repeat(50))).phrase, "x".repeat(10) + "…");
});

test("the nickname template is applied", () => {
  const cfg = { sayNickname: true, nicknameTemplate: "{nick} says." };
  assert.equal(run(cfg, msg("Катя", "привет")).phrase, "Катя says. привет");
});
