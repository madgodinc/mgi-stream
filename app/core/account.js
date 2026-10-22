import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";

/**
 * The MGI account: one Telegram sign-in on madgodinc.net for every paid MGI
 * program. Reading the chat out loud stays free; the account pays for music
 * requests, which go through our server.
 *
 * Same contract as the other MGI programs (mgi-account CONTRACT.md): a device
 * flow (the browser confirms a short code, the app polls for its token), then
 * a license, a small JSON payload signed with Ed25519, checked offline here,
 * so a short outage of the server never stops a stream before the license's `exp`.
 */

export const PRODUCT = "tiktok";
export const API = "https://madgodinc.net/account/api";
export const PUBLIC_KEY = "35Xw50pj3Wz+BgR69DYTMolmhJPJVbbODYe4HJSR/iI=";
export const PRICE_RUB = 300;
export const CONTACT = "https://t.me/madgodinc";
// Changing the salt signs every user out.
const DEVICE_SALT = "mgi-stream-tiktok";
const REFRESH_MS = 6 * 3600 * 1000;

// SubjectPublicKeyInfo header of a raw Ed25519 key, so node:crypto can read it.
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");

export function verifyLicense(license, sig, publicKey = PUBLIC_KEY) {
  try {
    const key = crypto.createPublicKey({
      key: Buffer.concat([SPKI_ED25519, Buffer.from(publicKey, "base64")]),
      format: "der",
      type: "spki",
    });
    const raw = Buffer.from(license, "base64");
    if (!crypto.verify(null, raw, key, Buffer.from(sig, "base64"))) return null;
    const lic = JSON.parse(raw.toString("utf8"));
    // A license of another MGI product is worthless here.
    return lic.product === PRODUCT ? lic : null;
  } catch {
    return null;
  }
}

export function versionLt(a, b) {
  const p = (v) => String(v || "0").split(".").map((x) => parseInt(x, 10) || 0);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  }
  return false;
}

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

// ── what identifies this computer ────────────────────────────────────────────

const PLACEHOLDERS = [
  "to be filled by o.e.m.", "default string", "system serial number", "none", "not specified",
  "not applicable", "0123456789", "123456789", "base board serial number", "chassis serial number",
  "unknown", "n/a",
];

function serial(v) {
  const t = String(v ?? "").trim();
  if (!t || /^0+$/.test(t) || PLACEHOLDERS.includes(t.toLowerCase())) return null;
  return t.toUpperCase();
}

function uuid(v) {
  const hex = String(v ?? "").toLowerCase().replace(/[^0-9a-f]/g, "");
  if (hex.length !== 32 || /^0+$/.test(hex) || /^f+$/.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The raw ids, read once with one PowerShell call; empty off Windows or on failure. */
function readHardware() {
  if (process.platform !== "win32") return Promise.resolve({});
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$p=Get-CimInstance Win32_ComputerSystemProduct",
    "$b=Get-CimInstance Win32_BaseBoard",
    "$d=(Get-Partition -DriveLetter $env:SystemDrive[0] | Get-Disk).SerialNumber",
    "$g=(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography').MachineGuid",
    "[pscustomobject]@{g=$g;u=$p.UUID;s=$p.IdentifyingNumber;b=$b.SerialNumber;d=$d} | ConvertTo-Json -Compress",
  ].join(";");
  return new Promise((done) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 15000, windowsHide: true }, (err, out) => {
      try {
        done(err ? {} : JSON.parse(String(out).trim() || "{}"));
      } catch {
        done({});
      }
    });
  });
}

/**
 * Anonymous hashes of the hardware ids, the server's check against a second
 * free trial on one computer. Raw ids never leave this machine.
 */
export function signalsOf(hw, product = PRODUCT) {
  const out = [];
  const add = (kind, v) => v && out.push(sha256(`mgi-${product}-signal-v1:${kind}:${v}`));
  add("machine_guid", uuid(hw.g));
  add("smbios_uuid", uuid(hw.u));
  add("smbios_serial", serial(hw.s));
  add("board_serial", serial(hw.b));
  add("disk_serial", serial(hw.d));
  return out.slice(0, 6);
}

/** A stable id for this Windows install, not the raw machine GUID. */
export function deviceIdOf(guid) {
  return sha256(`${DEVICE_SALT}:${guid}`).slice(0, 32);
}

// ── the account ──────────────────────────────────────────────────────────────

/**
 * Emits `change` with status() whenever something the window shows moved.
 * `seal`/`unseal` keep the token unreadable on disk (Electron's safeStorage,
 * DPAPI on Windows); tests pass plain functions.
 */
export class Account extends EventEmitter {
  constructor({ dir, version, seal = (s) => s, unseal = (s) => s, fetchImpl = fetch, hardware = readHardware }) {
    super();
    this.dir = dir;
    this.version = version;
    this.seal = seal;
    this.unseal = unseal;
    this.fetch = fetchImpl;
    this.file = path.join(dir, "account.json");
    this.saved = this.#read();
    this.login = null; // { code, url, expires } while the browser is open
    this.error = "";
    this.checked = 0;
    this.ready = (async () => {
      const hw = await hardware();
      this.signals = signalsOf(hw);
      this.deviceId = deviceIdOf(uuid(hw.g) ?? this.#fallbackId());
    })();
    this.timer = null;
  }

  #fallbackId() {
    const f = path.join(this.dir, "device.id");
    try {
      return fs.readFileSync(f, "utf8").trim();
    } catch {
      const id = crypto.randomBytes(16).toString("hex");
      try {
        fs.mkdirSync(this.dir, { recursive: true });
        fs.writeFileSync(f, id);
      } catch {}
      return id;
    }
  }

  #read() {
    try {
      const v = JSON.parse(fs.readFileSync(this.file, "utf8"));
      let token = "";
      try {
        token = v.sealed ? this.unseal(v.sealed) : "";
      } catch {}
      return { token, license: v.license || "", sig: v.sig || "" };
    } catch {
      return { token: "", license: "", sig: "" };
    }
  }

  #store() {
    const { token, license, sig } = this.saved;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = this.file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ sealed: token ? this.seal(token) : "", license, sig }));
      fs.renameSync(tmp, this.file);
    } catch {}
  }

  get token() {
    return this.saved.token;
  }

  /** What the window shows and what gates music. */
  status() {
    const signedIn = Boolean(this.saved.token);
    const lic = this.saved.license ? verifyLicense(this.saved.license, this.saved.sig) : null;
    const now = Date.now() / 1000;
    const st = {
      signedIn,
      ok: false,
      reason: "signed_out",
      name: lic?.name ?? "",
      until: lic?.until ?? 0,
      trial: Boolean(lic?.trial),
      price: PRICE_RUB,
      contact: CONTACT,
      login: this.login ? { code: this.login.code, url: this.login.url } : null,
      error: this.error,
    };
    if (!lic) {
      if (signedIn) st.reason = "offline";
      return st;
    }
    if (!signedIn) st.reason = "signed_out";
    else if (this.deviceId && lic.device_id !== this.deviceId) st.reason = "wrong_device";
    else if (now > lic.exp) st.reason = "offline";
    else if (!lic.active || now > lic.until) st.reason = "expired";
    else if (versionLt(this.version, lic.min_version)) st.reason = "outdated";
    else st.reason = "none";
    st.ok = st.reason === "none";
    return st;
  }

  #changed() {
    this.emit("change", this.status());
  }

  async #call(method, route, body, { token, query } = {}) {
    const url = `${API}/${route}${query ? "?" + new URLSearchParams(query) : ""}`;
    const headers = { "content-type": "application/json", "user-agent": `mgi-stream/${this.version}` };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await this.fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(25000),
    });
    let data = {};
    try {
      data = await res.json();
    } catch {}
    return { status: res.status, data };
  }

  async #body(extra = {}) {
    await this.ready;
    return { ...extra, product: PRODUCT, device_id: this.deviceId, version: this.version, signals: this.signals };
  }

  /** Starts the browser sign-in; resolves with the page to open. Polling runs on. */
  async signIn() {
    this.cancelSignIn();
    this.error = "";
    let res;
    try {
      res = await this.#call("POST", "login/start", await this.#body({ device_name: os.hostname(), poll_key: true }));
    } catch (err) {
      this.error = err.message;
      this.#changed();
      throw err;
    }
    if (res.status !== 200) {
      this.error = res.data.error || `HTTP ${res.status}`;
      this.#changed();
      throw new Error(this.error);
    }
    const { code, url, expires_in: ttl = 600, poll_key: key } = res.data;
    const login = { code, url, key, expires: Date.now() + ttl * 1000 };
    this.login = login;
    this.#changed();
    this.#poll(login);
    return url;
  }

  cancelSignIn() {
    if (!this.login) return;
    this.login = null;
    this.#changed();
  }

  async #poll(login) {
    while (this.login === login && Date.now() < login.expires) {
      await new Promise((r) => setTimeout(r, 2000));
      if (this.login !== login) return;
      let res;
      try {
        res = await this.#call("GET", "login/poll", null, { query: { code: login.code, ...(login.key ? { key: login.key } : {}) } });
      } catch {
        continue;
      }
      if (res.data.state === "done" && res.data.token) {
        this.login = null;
        this.saved = { token: res.data.token, license: "", sig: "" };
        this.#store();
        await this.refresh().catch(() => {});
        this.#changed();
        return;
      }
      if (res.data.state === "expired" || res.status === 404) break;
    }
    if (this.login === login) {
      this.login = null;
      this.error = "expired";
      this.#changed();
    }
  }

  /** A fresh license; network errors keep the old one. */
  async refresh() {
    if (!this.saved.token) return;
    let res;
    try {
      res = await this.#call("POST", "license", await this.#body(), { token: this.saved.token });
    } catch (err) {
      this.error = err.message;
      this.#changed();
      return;
    }
    if (res.status === 401) {
      // Signed out on the server: from the cabinet, or another computer took the seat.
      this.signOut();
      this.error = res.data.error || "signed out";
      this.#changed();
      return;
    }
    if (res.status !== 200) {
      // 402 and 403 still answer with a license when there is one to show.
      this.error = res.data.error || `HTTP ${res.status}`;
      this.#changed();
      return;
    }
    if (!verifyLicense(res.data.license, res.data.sig)) {
      this.error = "unsigned license";
      this.#changed();
      return;
    }
    this.saved.license = res.data.license;
    this.saved.sig = res.data.sig;
    this.#store();
    this.checked = Date.now();
    this.error = "";
    this.#changed();
  }

  signOut() {
    this.saved = { token: "", license: "", sig: "" };
    this.login = null;
    this.#store();
    this.#changed();
  }

  /** Refreshes now and every six hours, the way every MGI program does. */
  start() {
    this.refresh().catch(() => {});
    clearInterval(this.timer);
    this.timer = setInterval(() => this.refresh().catch(() => {}), REFRESH_MS);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }
}
