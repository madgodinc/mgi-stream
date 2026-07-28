import { setLang, tr, apply } from "./i18n.js";

const $ = (id) => document.getElementById(id);

const CHECKS = ["sayNickname", "skipEmojiOnly", "skipLinks", "playInApp", "requirePrefix"];
const SLIDERS = {
  rate: (v) => `${v >= 0 ? "+" : ""}${v}%`,
  pitch: (v) => `${v >= 0 ? "+" : ""}${v}Hz`,
  maxChars: (v) => String(v),
  maxQueue: (v) => String(v),
};

let cfg = null;
let onAir = false;
let lastStatus = { state: "off" };

// ── config <-> controls ───────────────────────────────────────────────────────

function paint() {
  $("channel").value = cfg.username;
  $("prefix").value = cfg.prefix;
  $("port").value = cfg.port;
  $("nicknameTemplate").value = cfg.nicknameTemplate;
  $("signApiKey").value = cfg.signApiKey;
  $("allowUsers").value = cfg.allowUsers.join("\n");
  $("ignoreUsers").value = cfg.ignoreUsers.join("\n");

  for (const key of CHECKS) $(key).classList.toggle("on", Boolean(cfg[key]));
  for (const key of Object.keys(SLIDERS)) {
    $(key).value = cfg[key];
    $(key + "Val").textContent = SLIDERS[key](Number(cfg[key]));
  }
  for (const b of $("audience").children) b.classList.toggle("sel", b.dataset.v === cfg.audience);
  for (const b of $("lang").children) b.classList.toggle("sel", b.dataset.l === cfg.lang);
  $("templateField").style.display = cfg.sayNickname ? "" : "none";
}

const lines = (el) => el.value.split("\n").map((s) => s.trim()).filter(Boolean);

function collect() {
  cfg.username = $("channel").value.trim();
  cfg.voice = $("voice").value || cfg.voice;
  cfg.prefix = $("prefix").value || "!";
  cfg.port = Number($("port").value) || 8099;
  cfg.nicknameTemplate = $("nicknameTemplate").value || "{nick}";
  cfg.signApiKey = $("signApiKey").value.trim();
  cfg.allowUsers = lines($("allowUsers"));
  cfg.ignoreUsers = lines($("ignoreUsers"));
  for (const key of Object.keys(SLIDERS)) cfg[key] = Number($(key).value);
  return cfg;
}

let saveTimer = null;
function touched() {
  collect();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => window.mgi.saveConfig(cfg), 400);
}

// ── language ──────────────────────────────────────────────────────────────────

function relabel() {
  apply();
  $("air").textContent = onAir ? tr("stop") : tr("goOnAir");
  $("test").textContent = tr("testVoice");
  showStatus(lastStatus);
  if (!onAir) $("url").textContent = tr("notRunning");
  $("queue").textContent = `${tr("queue")} 0`;
  if ($("nicknameTemplate").value.trim() === "") $("nicknameTemplate").value = tr("nickTemplate");
  for (const el of flow.querySelectorAll(".line")) label(el);
}

for (const b of $("lang").children) {
  b.onclick = () => {
    cfg.lang = setLang(b.dataset.l);
    for (const s of $("lang").children) s.classList.toggle("sel", s === b);
    relabel();
    touched();
  };
}

// ── chat flow ─────────────────────────────────────────────────────────────────

const flow = $("flow");
const pending = [];
let playing = false;
const audio = new Audio();

function label(el) {
  const { nick, reason, arg } = el.dataset;
  const why = reason ? tr("reason." + reason, arg && tr("tier." + arg, arg)) : "";
  el.querySelector(".who").textContent = why ? `${nick} · ${why}` : nick;
}

function addLine(nick, text, reason, arg) {
  $("empty")?.remove();
  const el = document.createElement("div");
  el.className = reason ? "line mute" : "line";
  el.innerHTML = '<div class="bar"></div><div><div class="who mono"></div><div class="what"></div></div>';
  // Kept on the node so the whole flow can be relabelled when the language changes.
  el.dataset.nick = nick;
  if (reason) el.dataset.reason = reason;
  if (arg) el.dataset.arg = arg;
  label(el);
  el.querySelector(".what").textContent = text;
  flow.prepend(el);
  while (flow.children.length > 40) flow.lastElementChild.remove();
  return el;
}

// Rows are keyed by their text so the audio can find the row it belongs to.
const waiting = new Map();

function playNext() {
  if (playing || !pending.length) return;
  const item = pending.shift();
  const key = item.nick + " " + item.text;
  const el = waiting.get(key) ?? addLine(item.nick, item.text, "");
  waiting.delete(key);


  const finish = () => {
    el.classList.remove("live");
    el.classList.add("done");
    playing = false;
    playNext();
  };

  el.classList.add("live");
  if (!cfg.playInApp) return finish(); // the overlay is doing the talking

  playing = true;
  audio.src = "data:audio/mpeg;base64," + item.audio;
  audio.ontimeupdate = () => {
    if (audio.duration) el.style.setProperty("--fill", (audio.currentTime / audio.duration) * 100 + "%");
  };
  audio.onended = audio.onerror = finish;
  audio.play().catch(finish);
}

// ── air switch ────────────────────────────────────────────────────────────────

function showStatus(s) {
  lastStatus = s;
  $("status").className = "mono " + s.state;
  $("statusText").textContent = tr("air." + s.state);
  const explains = s.state === "error" || s.state === "waiting";
  $("note").textContent = explains ? (s.code ? tr("err." + s.code, s.arg) : s.detail ?? "") : "";
}

function setAir(on) {
  onAir = on;
  $("air").classList.toggle("on", on);
  $("air").textContent = on ? tr("stop") : tr("goOnAir");
  $("channel").disabled = on;
  $("port").disabled = on;
  if (!on) $("url").textContent = tr("notRunning");
}

async function go(mock) {
  if (onAir) {
    await window.mgi.stop();
    setAir(false);
    return;
  }
  $("note").textContent = "";
  const res = await window.mgi.start(collect(), mock);
  if (!res.ok) {
    $("note").textContent = res.code ? tr("err." + res.code) : res.error;
    return;
  }
  setAir(true);
  // The channel is cleaned up on save, so show back what actually got connected.
  if (res.username) $("channel").value = cfg.username = res.username;
  $("url").textContent = res.url;
}

$("air").onclick = () => go(false);
$("demo").onclick = () => go(true);
$("copy").onclick = () => window.mgi.copyUrl();
$("open").onclick = () => window.mgi.openUrl();

$("test").onclick = async () => {
  $("test").disabled = true;
  $("test").textContent = tr("synthesizing");
  const res = await window.mgi.preview(collect());
  $("test").disabled = false;
  $("test").textContent = tr("testVoice");
  if (!res.ok) return showStatus({ state: "error", code: "speech", arg: res.error });
  new Audio("data:audio/mpeg;base64," + res.audio).play();
};

// ── wiring ────────────────────────────────────────────────────────────────────

for (const key of CHECKS) {
  $(key).onclick = () => {
    cfg[key] = !cfg[key];
    $(key).classList.toggle("on", cfg[key]);
    if (key === "sayNickname") $("templateField").style.display = cfg[key] ? "" : "none";
    touched();
  };
}

for (const key of Object.keys(SLIDERS)) {
  $(key).oninput = () => {
    $(key + "Val").textContent = SLIDERS[key](Number($(key).value));
    touched();
  };
}

for (const b of $("audience").children) {
  b.onclick = () => {
    cfg.audience = b.dataset.v;
    for (const s of $("audience").children) s.classList.toggle("sel", s === b);
    touched();
  };
}

function markPreset() {
  for (const b of $("presets").children) b.classList.toggle("sel", b.dataset.voice === cfg.voice);
}

for (const b of $("presets").children) {
  b.onclick = () => {
    $("voice").value = b.dataset.voice;
    cfg.voice = b.dataset.voice;
    markPreset();
    touched();
  };
}

const TEXT_FIELDS = ["channel", "prefix", "port", "nicknameTemplate", "allowUsers", "ignoreUsers", "signApiKey"];
for (const id of TEXT_FIELDS) $(id).oninput = touched;
$("voice").onchange = () => {
  touched();
  markPreset();
};

window.mgi.on("status", (s) => {
  showStatus(s);
  // A soft error is a phrase that failed, not a run that ended.
  if (s.state === "off" || (s.state === "error" && !s.soft)) setAir(false);
});

window.mgi.on("message", ({ nick, text, spoken, reason, arg }) => {
  const el = addLine(nick, text, spoken ? "" : reason, arg);
  if (!spoken) return;
  waiting.set(nick + " " + text, el);
  // A row is claimed when its audio arrives. A phrase that never synthesizes
  // leaves its row unclaimed, so the oldest go overboard instead of piling up
  // for the length of the stream.
  if (waiting.size > 60) waiting.delete(waiting.keys().next().value);
});

window.mgi.on("queue", ({ size, dropped }) => {
  $("queue").textContent = dropped
    ? `${tr("queue")} ${size} · ${tr("dropped")} ${dropped}`
    : `${tr("queue")} ${size}`;
});

window.mgi.on("speak", (item) => {
  pending.push(item);
  playNext();
});

// ── boot ──────────────────────────────────────────────────────────────────────

(async () => {
  cfg = await window.mgi.getConfig();
  cfg.lang = setLang(cfg.lang);
  paint();
  relabel();
  setAir(false);

  const res = await window.mgi.voices();
  const select = $("voice");
  if (!res.ok) {
    select.innerHTML = `<option>${tr("voiceListFailed")}</option>`;
    return showStatus({ state: "error", detail: res.error });
  }
  select.innerHTML = res.voices
    .map((v) => `<option value="${v.id}">${v.locale} · ${v.id.replace(/^[a-z]{2}-[A-Z]{2}-/, "")} · ${v.gender}</option>`)
    .join("");
  select.value = cfg.voice;
  markPreset();

  if (location.search.includes("demo")) go(true);
})();
