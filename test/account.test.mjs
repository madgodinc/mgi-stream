import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Account, verifyLicense, signalsOf, deviceIdOf, versionLt, PUBLIC_KEY } from "../app/core/account.js";

const hw = { g: "8D7C2A54-1B1A-4D4B-9C3E-0123456789AB", u: "00000000-0000-0000-0000-000000000000", s: "To be filled by O.E.M.", b: "BSN123", d: " ws-disk " };

function signer() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("base64");
  const sign = (payload) => {
    const raw = Buffer.from(JSON.stringify(payload));
    return { license: raw.toString("base64"), sig: crypto.sign(null, raw, privateKey).toString("base64") };
  };
  return { pub, sign };
}

test("only a license signed for this product verifies", () => {
  const { pub, sign } = signer();
  const good = sign({ product: "tiktok", device_id: "d", until: 1 });
  assert.equal(verifyLicense(good.license, good.sig, pub).device_id, "d");
  const other = sign({ product: "stream" });
  assert.equal(verifyLicense(other.license, other.sig, pub), null, "a Stream Control license is worthless here");
  assert.equal(verifyLicense(good.license, good.sig, PUBLIC_KEY), null, "someone else's key");
  assert.equal(verifyLicense("junk", "junk", pub), null);
});

test("hardware ids become salted hashes; placeholders are left out", () => {
  const sig = signalsOf(hw);
  assert.equal(sig.length, 3, "guid, board serial, disk serial");
  assert.ok(sig.every((s) => /^[0-9a-f]{64}$/.test(s)));
  assert.notDeepEqual(signalsOf(hw, "stream"), sig, "salted per product");
  assert.equal(deviceIdOf("x").length, 32);
});

test("versions compare by number", () => {
  assert.ok(versionLt("0.3.9", "0.4.0"));
  assert.ok(!versionLt("0.10.0", "0.9.0"));
  assert.ok(!versionLt("1.0.0", "1.0.0"));
});

test("sign-in, license, and a sign-out from the server", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mgi-acc-"));
  let licenseStatus = 200;
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, body: init.body && JSON.parse(init.body), auth: init.headers?.authorization });
    const json = (status, data) => new Response(JSON.stringify(data), { status });
    if (url.endsWith("/login/start")) return json(200, { code: "ABC123", url: "https://x/login", expires_in: 60, poll_key: "pk" });
    if (url.includes("/login/poll")) return json(200, { state: "done", token: "device-token" });
    if (url.endsWith("/license")) {
      if (licenseStatus === 401) return json(401, { error: "Войдите снова" });
      // A license must come from the real key to verify, so this one never does:
      // the account keeps the token and reports the license as unsigned.
      return json(200, { license: "e30=", sig: "AAAA" });
    }
    return json(404, {});
  };
  const acc = new Account({ dir, version: "0.4.0", fetchImpl, hardware: async () => hw });
  await acc.ready;
  assert.equal(acc.status().reason, "signed_out");

  const done = new Promise((r) => acc.on("change", (s) => s.signedIn && !s.login && r(s)));
  assert.equal(await acc.signIn(), "https://x/login");
  const s = await done;
  assert.equal(acc.token, "device-token");
  assert.equal(s.reason, "offline", "a token without a valid license is not enough");
  const start = calls.find((c) => c.url.endsWith("/login/start")).body;
  assert.equal(start.product, "tiktok");
  assert.equal(start.device_id, deviceIdOf(hw.g.toLowerCase()));
  assert.equal(start.signals.length, 3);
  assert.ok(calls.some((c) => c.url.includes("key=pk")), "the poll carries the poll key");

  // The token lives on disk only sealed.
  const disk = fs.readFileSync(path.join(dir, "account.json"), "utf8");
  assert.ok(disk.includes("sealed"));

  licenseStatus = 401;
  await acc.refresh();
  assert.equal(acc.token, "");
  assert.equal(acc.status().signedIn, false);
});
