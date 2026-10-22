// The Музыка tab: the MGI subscription that pays for requests, the request
// rules, and the deck where the streamer sees and steers the queue.
//
// This window is the player. Its <video> makes the sound (OBS captures the
// program as its own audio line) and reports the position; the overlay in OBS
// shows the same file muted and follows that position.

import { tr } from "./i18n.js";

const $ = (id) => document.getElementById(id);

let cfg = null;
let touched = () => {};
let account = { signedIn: false, ok: false, reason: "signed_out", price: 300 };
let state = { current: null, queue: [], pending: [] };
let playing = null; // the track this window is playing
let ducked = false;

const player = $("mplayer");
const CHECKS = ["enabled", "approve", "songReply", "showNotes", "duck"];
const SLIDERS = {
  skipVotes: (v) => (v ? String(v) : tr("m.off")),
  maxMinutes: (v) => `${v} ${tr("m.min")}`,
  perViewer: (v) => String(v),
  maxQueue: (v) => String(v),
};
const TEXTS = ["cmd", "skipCmd", "songCmd"];
const LISTS = ["bannedUsers", "bannedWords", "bannedTracks"];

const clock = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const fill = (el) => el.style.setProperty("--fill", `${((el.value - el.min) / (el.max - el.min)) * 100}%`);
const lines = (el) => el.value.split("\n").map((s) => s.trim()).filter(Boolean);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// ── settings ─────────────────────────────────────────────────────────────────

function paint() {
  const m = cfg.music;
  for (const k of CHECKS) $("m-" + k).classList.toggle("on", Boolean(m[k]));
  for (const k of TEXTS) $("m-" + k).value = m[k];
  for (const k of LISTS) $("m-" + k).value = m[k].join("\n");
  for (const k of Object.keys(SLIDERS)) {
    $("m-" + k).value = m[k];
    fill($("m-" + k));
    $(`m-${k}Val`).textContent = SLIDERS[k](Number(m[k]));
  }
  for (const id of ["audience", "mode", "maxHeight"]) {
    for (const b of $("m-" + id).children) b.classList.toggle("sel", b.dataset.v === String(m[id]));
  }
  $("m-maxHeight").style.display = m.mode === "video" ? "" : "none";
  $("m-volume").value = m.volume;
  fill($("m-volume"));
  $("m-mute").classList.toggle("on", m.muted);
  volume();
}

function wire() {
  const m = () => cfg.music;
  for (const k of CHECKS) {
    $("m-" + k).onclick = () => {
      m()[k] = !m()[k];
      $("m-" + k).classList.toggle("on", m()[k]);
      volume();
      touched();
    };
  }
  for (const k of TEXTS) {
    $("m-" + k).oninput = () => {
      m()[k] = $("m-" + k).value.trim();
      touched();
    };
  }
  for (const k of LISTS) {
    $("m-" + k).oninput = () => {
      m()[k] = lines($("m-" + k));
      touched();
    };
  }
  for (const k of Object.keys(SLIDERS)) {
    $("m-" + k).oninput = () => {
      m()[k] = Number($("m-" + k).value);
      fill($("m-" + k));
      $(`m-${k}Val`).textContent = SLIDERS[k](m()[k]);
      touched();
    };
  }
  for (const id of ["audience", "mode", "maxHeight"]) {
    for (const b of $("m-" + id).children) {
      b.onclick = () => {
        m()[id] = id === "maxHeight" ? Number(b.dataset.v) : b.dataset.v;
        for (const s of $("m-" + id).children) s.classList.toggle("sel", s === b);
        $("m-maxHeight").style.display = m().mode === "video" ? "" : "none";
        touched();
      };
    }
  }
  $("m-volume").oninput = () => {
    m().volume = Number($("m-volume").value);
    fill($("m-volume"));
    volume();
    touched();
  };
  $("m-mute").onclick = () => {
    m().muted = !m().muted;
    $("m-mute").classList.toggle("on", m().muted);
    volume();
    touched();
  };
  $("m-copy").onclick = () => window.mgi.music.copyUrl();

  $("m-play").onclick = () => {
    if (!playing) return;
    if (player.paused) player.play().catch(() => {});
    else player.pause();
  };
  $("m-skip").onclick = () => window.mgi.music.control({ action: "skip" });
  $("m-banTrack").onclick = () => ban(state.current?.uid, "track");
  $("m-banUser").onclick = () => ban(state.current?.uid, "user");
  $("seek").onclick = (e) => {
    if (!playing || !player.duration) return;
    const r = $("seek").getBoundingClientRect();
    player.currentTime = ((e.clientX - r.left) / r.width) * player.duration;
  };
}

async function ban(uid, what) {
  if (!uid) return;
  const saved = await window.mgi.music.control({ action: "ban", uid, what });
  // The ban was saved by the main process; this window's copy follows, or the
  // next autosave would write the old lists back.
  if (saved?.music) {
    for (const k of LISTS) cfg.music[k] = saved.music[k];
    for (const k of LISTS) $("m-" + k).value = cfg.music[k].join("\n");
  }
}

// ── playback ─────────────────────────────────────────────────────────────────

function volume() {
  const m = cfg.music;
  const v = m.muted ? 0 : m.volume / 100;
  player.volume = ducked && m.duck ? v * 0.3 : v;
  $("m-mute").textContent = m.muted ? tr("m.unmute") : tr("m.mute");
}

/** Chat speech in this window lowers the music while it talks. */
export function duck(on) {
  ducked = on;
  volume();
}

function play({ track, url }) {
  playing = track;
  player.src = url;
  player.currentTime = 0;
  volume();
  player.play().catch(() => window.mgi.music.ended(track.uid));
}

function stopped() {
  playing = null;
  player.pause();
  player.removeAttribute("src");
  player.load();
}

let lastReport = 0;
function report(force) {
  if (!playing) return;
  const now = Date.now();
  if (!force && now - lastReport < 500) return;
  lastReport = now;
  window.mgi.music.progress({ uid: playing.uid, position: player.currentTime, paused: player.paused });
  const d = player.duration || playing.duration;
  $("seekFill").style.width = d ? `${Math.min(100, (player.currentTime / d) * 100)}%` : "0";
  $("nowTime").textContent = `${clock(player.currentTime)} / ${clock(d)}`;
}
player.ontimeupdate = () => report(false);
player.onplay = player.onpause = player.onseeked = () => {
  report(true);
  $("m-play").textContent = player.paused ? tr("m.play") : tr("m.pause");
  window.mgi.music.control({ action: "pause", paused: player.paused });
};
player.onended = () => playing && window.mgi.music.ended(playing.uid);
// A file the window cannot play is skipped, not left hanging.
player.onerror = () => playing && player.getAttribute("src") && window.mgi.music.ended(playing.uid);

// ── the deck ─────────────────────────────────────────────────────────────────

function row(t, i, kind) {
  const li = document.createElement("li");
  li.className = "track";
  li.dataset.uid = t.uid;
  const status =
    t.state === "loading" ? `${tr("m.loading")} ${Math.round((t.progress || 0) * 100)}%` : t.state === "ready" ? tr("m.ready") : "";
  li.innerHTML = `<span class="n">${i + 1}</span><img alt="" src="${esc(t.thumbnail)}">
    <div class="t"><b>${esc(t.title)}</b><span>${esc(t.nick)} · ${clock(t.duration)}${status ? " · " + status : ""}</span>
    ${t.state === "loading" ? `<div class="load"><i></i></div>` : ""}</div>
    <div class="acts"></div>`;
  // Through CSSOM: the page's CSP refuses style attributes in markup.
  li.querySelector(".load i")?.style.setProperty("--p", `${Math.round((t.progress || 0) * 100)}%`);
  const acts = li.querySelector(".acts");
  const btn = (label, fn, cls = "") => {
    const b = document.createElement("button");
    b.textContent = label;
    if (cls) b.className = cls;
    b.onclick = fn;
    acts.append(b);
  };
  if (kind === "pending") {
    btn(tr("m.yes"), () => window.mgi.music.control({ action: "approve", uid: t.uid }), "yes");
    btn(tr("m.no"), () => window.mgi.music.control({ action: "remove", uid: t.uid }));
  } else {
    btn(tr("m.remove"), () => window.mgi.music.control({ action: "remove", uid: t.uid }));
  }
  btn(tr("m.banTrackShort"), () => ban(t.uid, "track"));
  btn(tr("m.banUserShort"), () => ban(t.uid, "user"));

  if (kind === "queue") {
    li.draggable = true;
    li.ondragstart = (e) => {
      e.dataTransfer.setData("text/plain", String(t.uid));
      li.classList.add("drag");
    };
    li.ondragend = () => li.classList.remove("drag");
    li.ondragover = (e) => {
      e.preventDefault();
      li.classList.add("over");
    };
    li.ondragleave = () => li.classList.remove("over");
    li.ondrop = (e) => {
      e.preventDefault();
      li.classList.remove("over");
      const uid = Number(e.dataTransfer.getData("text/plain"));
      if (uid && uid !== t.uid) window.mgi.music.control({ action: "move", uid, index: i });
    };
  }
  return li;
}

function render(s) {
  state = s;
  const c = s.current;
  const now = $("now");
  now.className = c ? (c.video ? "" : "audio") : "idle";
  $("mcover").src = c?.thumbnail || "";
  $("nowWho").textContent = c ? `${tr("m.orderedBy")} ${c.nick}${s.votes ? ` · ${tr("m.votes")} ${s.votes}` : ""}` : "";
  $("nowTitle").textContent = c ? c.title : tr("m.nothing");
  if (!c) {
    $("nowTime").textContent = "";
    $("seekFill").style.width = "0";
  }

  $("pendingBox").classList.toggle("on", s.pending.length > 0);
  $("pendingList").replaceChildren(...s.pending.map((t, i) => row(t, i, "pending")));
  $("queueList").replaceChildren(...s.queue.map((t, i) => row(t, i, "queue")));
  $("queueEmpty").textContent = s.queue.length ? "" : tr("m.queueEmpty", cfg?.music.cmd || "/music");
}

function logLine({ nick, title, ok, reason, arg }) {
  const li = document.createElement("li");
  if (!ok) li.className = "no";
  const why = ok ? tr("m.st." + arg) : tr("m.why." + reason, arg);
  li.innerHTML = `<span><b></b> · <span class="what"></span><br><span class="why"></span></span>`;
  li.querySelector("b").textContent = nick;
  li.querySelector(".what").textContent = title || "";
  li.querySelector(".why").textContent = why;
  $("log").prepend(li);
  while ($("log").children.length > 8) $("log").lastElementChild.remove();
}

// ── the subscription ─────────────────────────────────────────────────────────

function until(ts) {
  return new Date(ts * 1000).toLocaleDateString(document.documentElement.lang || "ru", { day: "numeric", month: "long" });
}

function renderAccount() {
  const a = account;
  const box = $("subBody");
  const price = `<div class="price"><b>${a.price} ₽</b><span>${tr("m.perMonth")}</span></div>`;
  let html;
  if (a.login) {
    html = `<p class="hint">${tr("m.loginOpened")}</p><div class="code">${esc(a.login.code)}</div>
      <div class="row"><button class="secondary small" id="acc-reopen">${tr("m.reopen")}</button>
      <button class="secondary small" id="acc-cancel">${tr("m.cancel")}</button></div>`;
  } else if (!a.signedIn) {
    html = `${price}<p class="hint">${tr("m.pitch")}</p>
      <div class="row"><button class="primary" id="acc-in">${tr("m.signIn")}</button></div>`;
  } else {
    const ok = a.ok;
    const line = ok
      ? a.trial
        ? tr("m.trialUntil", until(a.until))
        : tr("m.activeUntil", until(a.until))
      : tr("m.reason." + a.reason);
    const cls = ok ? "state" : a.reason === "offline" ? "state wait" : "state bad";
    html = `<div class="${cls}"><i></i><span>${esc(line)}</span></div>
      <p class="hint">${esc(a.name)}</p>
      ${ok && !a.trial ? "" : price}
      ${ok ? "" : `<p class="hint">${tr("m.payLater")} <a href="${a.contact}" target="_blank">t.me/madgodinc</a></p>`}
      <div class="row"><button class="secondary small" id="acc-refresh">${tr("m.refresh")}</button>
      <button class="secondary small" id="acc-cabinet">${tr("m.cabinet")}</button>
      <button class="secondary small" id="acc-out">${tr("m.signOut")}</button></div>`;
  }
  if (a.error && !a.login) html += `<p class="hint err">${esc(a.error === "expired" ? tr("m.codeExpired") : a.error)}</p>`;
  box.innerHTML = html;

  const on = (id, fn) => $(id) && ($(id).onclick = fn);
  on("acc-in", async () => {
    $("acc-in").disabled = true;
    const r = await window.mgi.account.signIn();
    if (!r.ok) {
      account = { ...account, error: r.error };
      renderAccount();
    }
  });
  on("acc-reopen", () => window.mgi.account.signIn());
  on("acc-cancel", () => window.mgi.account.cancel());
  on("acc-refresh", () => window.mgi.account.refresh());
  on("acc-cabinet", () => window.mgi.account.cabinet());
  on("acc-out", () => window.mgi.account.signOut());
}

// ── outside ──────────────────────────────────────────────────────────────────

export function setUrl(url) {
  $("m-url").textContent = url || tr("notRunning");
}

export function relabel() {
  if (!cfg) return;
  paint();
  render(state);
  renderAccount();
  $("m-play").textContent = player.paused ? tr("m.play") : tr("m.pause");
  if (!$("m-url").textContent || $("m-url").textContent.startsWith("http") === false) setUrl("");
}

export async function initMusic(opts) {
  cfg = opts.cfg;
  touched = opts.touched;
  wire();
  paint();
  window.mgi.on("account", (a) => {
    account = a;
    renderAccount();
  });
  window.mgi.on("music:state", render);
  window.mgi.on("music:play", play);
  window.mgi.on("music:stop", stopped);
  window.mgi.on("music:request", logLine);
  render(await window.mgi.music.state());
  relabel();
  // The first answer waits for the hardware ids (a PowerShell call, a few
  // seconds); the tab is usable meanwhile.
  window.mgi.account.get().then((a) => {
    account = a;
    renderAccount();
  });
}
