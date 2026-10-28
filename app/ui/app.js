import { setLang, tr, apply } from "./i18n.js";
import { initMusic, relabel as relabelMusic, setUrl as setMusicUrl, duck } from "./music.js";
import { initPet, relabel as relabelPet } from "./pet.js";
import { initBanks, relabel as relabelBanks } from "./banks.js";
import { initUpdates, relabel as relabelUpdates } from "./updates.js";
import { askTheme, initTheme, mountThemeButton, mountThemePicker } from "./themes/theme.js";

// The theme goes on before anything is drawn, so the window never flashes studio.
const themeReady = initTheme({
  load: () => window.mgi.theme.get(),
  save: (id) => window.mgi.theme.set(id),
  subscribe: (fn) => window.mgi.on("theme", fn),
});

const $ = (id) => document.getElementById(id);

const CHECKS = ["sayNickname", "skipEmojiOnly", "skipLinks", "playInApp", "requirePrefix", "trayOnClose"];
const SLIDERS = {
  rate: (v) => `${v >= 0 ? "+" : ""}${v}%`,
  pitch: (v) => `${v >= 0 ? "+" : ""}${v}Hz`,
  maxChars: (v) => String(v),
  maxQueue: (v) => String(v),
  nickRate: (v) => `${v >= 0 ? "+" : ""}${v}%`,
  nickPause: (v) => `${v} ms`,
  voiceVolume: (v) => `${v}%`,
  voiceMonitor: (v) => `${v}%`,
};

let cfg = null;
let onAir = false;
let lastStatus = { state: "off" };

// ── the MGI look: embers, rest in the background, tabs ────────────────────────

(function embers() {
  const box = $("embers");
  // Fixed per index so the sky looks the same on every launch.
  const hash = (i, k) => {
    const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
    return x - Math.floor(x);
  };
  for (let i = 0; i < 26; i++) {
    const s = document.createElement("span");
    const size = 2 + hash(i, 1) * 3;
    s.style.cssText = `left:${hash(i, 2) * 100}%;width:${size}px;height:${size}px;animation-duration:${10 + hash(i, 3) * 12}s;animation-delay:${-hash(i, 4) * 22}s;--dx:${(hash(i, 5) - 0.5) * 160}px`;
    s.dataset.tone = String(i % 3);
    box.appendChild(s);
  }
})();

// Decoration rests while the window is in the background, so it never costs
// the stream encoder a frame.
const away = () => document.documentElement.classList.toggle("is-away", !document.hasFocus() || document.hidden);
addEventListener("focus", away);
addEventListener("blur", away);
document.addEventListener("visibilitychange", away);
away();

const TABS = ["voice", "who", "reading", "music", "sound", "pet", "banks", "obs"];
let tab = "voice";
function setTab(next) {
  const from = TABS.indexOf(tab);
  const to = TABS.indexOf(next);
  tab = next;
  document.documentElement.dataset.tab = next;
  placePill();
  for (const b of document.querySelectorAll(".tab")) b.classList.toggle("is-on", b.dataset.tab === next);
  for (const p of document.querySelectorAll("[data-pane]")) {
    const on = p.dataset.pane === next;
    p.classList.toggle("is-on", on);
    p.classList.toggle("from-left", on && to < from);
  }
  $("settings").scrollTop = 0;
}
for (const b of document.querySelectorAll(".tab")) b.onclick = () => setTab(b.dataset.tab);

// The tabs are as wide as their words, so the pill takes the width of the one it sits under.
function placePill() {
  const b = document.querySelector(`.tab[data-tab="${tab}"]`);
  if (!b) return;
  $("pill").style.setProperty("--pill-w", `${b.offsetWidth}px`);
  $("pill").style.transform = `translateX(${b.offsetLeft}px)`;
}
// A language, a theme's font or the window's width moves the tabs; the pill follows.
const tabWatch = new ResizeObserver(placePill);
for (const b of document.querySelectorAll(".tab")) tabWatch.observe(b);
setTab(new URLSearchParams(location.search).get("tab") ?? "voice");

// The range track paints its filled part from --fill.
function fillRange(el) {
  const fill = ((el.value - el.min) / (el.max - el.min)) * 100;
  el.style.setProperty("--fill", `${fill}%`);
}

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
    fillRange($(key));
    $(key + "Val").textContent = SLIDERS[key](Number(cfg[key]));
  }
  for (const b of $("audience").children) b.classList.toggle("sel", b.dataset.v === cfg.audience);
  for (const b of $("lang").children) b.classList.toggle("sel", b.dataset.l === cfg.lang);
  $("templateField").style.display = cfg.sayNickname ? "" : "none";
}

const lines = (el) => el.value.split("\n").map((s) => s.trim()).filter(Boolean);

// ── where the sound goes ──────────────────────────────────────────────────────
// Devices are kept by name: the helper windows see other ids for the same one.

async function devices() {
  const all = (await navigator.mediaDevices.enumerateDevices().catch(() => [])).filter((d) => d.kind === "audiooutput");
  const names = [...new Set(all.map((d) => d.label).filter((l) => l && !/^(default|communications)/i.test(l)))];
  for (const key of ["streamDevice", "monitorDevice"]) {
    const sel = $(key);
    sel.innerHTML = "";
    const def = new Option(tr("deviceDefault"), "");
    sel.append(def, ...names.map((n) => new Option(n, n)));
    if (cfg[key] && !names.includes(cfg[key])) sel.append(new Option(cfg[key], cfg[key]));
    sel.value = cfg[key] || "";
    sel.onchange = () => {
      cfg[key] = sel.value;
      if (key === "streamDevice") route();
      touched();
    };
  }
  route();
}

async function route() {
  const all = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  const id = all.find((d) => d.kind === "audiooutput" && d.label === cfg.streamDevice)?.deviceId ?? "";
  audio.setSinkId?.(id).catch(() => {});
}
navigator.mediaDevices?.addEventListener?.("devicechange", () => cfg && devices());

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
  document.documentElement.lang = cfg.lang;
  relabelMusic();
  relabelPet();
  relabelBanks();
  relabelUpdates();
  // In the fog rail a tab is only its icon: the label goes to the tooltip.
  for (const b of document.querySelectorAll(".tab")) b.title = b.textContent.trim();
  picker?.redraw();
  themeBtn?.redraw();
}

let picker = null;
let themeBtn = null;

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
// Edge voices send mp3, our gateway voices WAV (base64 of "RIFF" starts "UklGR").
const dataUrl = (b64) => `data:audio/${b64.startsWith("UklGR") ? "wav" : "mpeg"};base64,${b64}`;
const audio = new Audio();
let voiceWindow = false;
window.mgi.on("voice:window", (on) => (voiceWindow = Boolean(on)));

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
    duck(false);
    playNext();
  };

  el.classList.add("live");
  if (!cfg.playInApp) return finish(); // the overlay is doing the talking

  playing = true;
  duck(true);
  audio.volume = Math.min(1, cfg.voiceVolume / 100);
  // The «Озвучка» window plays the same line to the stream; this copy only keeps time.
  audio.muted = voiceWindow;
  audio.src = dataUrl(item.audio);
  audio.ontimeupdate = () => {
    if (audio.duration) el.style.setProperty("--fill", (audio.currentTime / audio.duration) * 100 + "%");
  };
  audio.onended = audio.onerror = finish;
  audio.play().catch(finish);
}

// ── action sounds ─────────────────────────────────────────────────────────────
// A bank's «звук» plays from this window: the «Приложение» output in TikTok
// LIVE Studio, free since the chat voice moved to its own window.

const fxAudio = new Audio();
window.mgi.on("fx:sound", async (m) => {
  fxAudio.pause();
  if (!m) return;
  const all = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  const id = all.find((d) => d.kind === "audiooutput" && d.label === cfg.streamDevice)?.deviceId ?? "";
  await fxAudio.setSinkId?.(id).catch(() => {});
  fxAudio.src = m.url;
  fxAudio.volume = Math.min(1, (m.volume ?? 80) / 100);
  fxAudio.play().catch(() => {});
});

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
  if (!on) setMusicUrl("");
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
  setMusicUrl(res.musicUrl);
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
  new Audio(dataUrl(res.audio)).play();
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
    fillRange($(key));
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

// A phrase the speech service never voiced: its row turns grey with the reason,
// the run goes on.
window.mgi.on("unspoken", ({ nick, text }) => {
  const key = nick + " " + text;
  const el = waiting.get(key);
  waiting.delete(key);
  if (!el) return;
  el.className = "line mute";
  el.dataset.reason = "speechFailed";
  label(el);
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

async function loadVoices() {
  const res = await window.mgi.voices();
  const select = $("voice");
  if (!res.ok) {
    select.innerHTML = `<option>${tr("voiceListFailed")}</option>`;
    return showStatus({ state: "error", detail: res.error });
  }
  select.innerHTML = res.voices
    .map((v) =>
      v.id.startsWith("mgi:")
        ? `<option value="${v.id}">MGI · ${v.name}</option>`
        : `<option value="${v.id}">${v.locale} · ${v.id.replace(/^[a-z]{2}-[A-Z]{2}-/, "")} · ${v.gender}</option>`,
    )
    .join("");
  select.value = cfg.voice;
  // A preset for a voice this install cannot use (ours, without a key) is hidden.
  const have = new Set(res.voices.map((v) => v.id));
  for (const b of $("presets").children) b.style.display = have.has(b.dataset.voice) ? "" : "none";
  markPreset();
}

// ── boot ──────────────────────────────────────────────────────────────────────

(async () => {
  cfg = await window.mgi.getConfig();
  cfg.lang = setLang(cfg.lang);
  paint();
  await themeReady;
  picker = mountThemePicker($("themePick"), { lang: () => cfg.lang });
  themeBtn = mountThemeButton($("theme-btn"), { lang: () => cfg.lang });
  await initMusic({ cfg, touched });
  initPet({ cfg, touched });
  await initBanks({ cfg, touched });
  devices();
  initUpdates();
  relabel();
  setAir(false);

  // The voice list waits on the account (a few seconds); the window does not.
  const voices = loadVoices();
  // First start: the theme question, over the window it re-dresses.
  if (!(await themeReady).asked) await askTheme({ lang: () => cfg.lang });
  await voices;
  // Mad's voice comes with the subscription: the list changes with it.
  let subscribed = null;
  window.mgi.on("account", (a) => {
    if (a.ok !== subscribed) loadVoices();
    subscribed = a.ok;
  });

  if (location.search.includes("demo")) go(true);
})();
