// The Музыка tab: the MGI subscription that pays for requests, the request
// rules, and the deck where the streamer sees and steers the queue.
//
// This window keeps the time. Its <video> runs muted and reports the position;
// the music window (a process of its own, see app/helper.js) plays the sound to
// the stream and the hidden headphone window plays it to the streamer, both
// following that position.

import { tr } from "./i18n.js";

const $ = (id) => document.getElementById(id);

let cfg = null;
let touched = () => {};
let account = { signedIn: false, ok: false, reason: "signed_out", price: 300 };
let state = { current: null, queue: [], pending: [] };
let playing = null; // the track this window is playing
let ducked = false;
let wishes = []; // the streamer's wishlist, newest first

const player = $("mplayer");
const CHECKS = ["enabled", "approve", "songReply", "showNotes", "duck"];
const SLIDERS = {
  monitor: (v) => `${v}%`,
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
/**
 * Puts `items` into the list `ol`, keeping the rows that did not change: the
 * state comes every second while a track downloads, and rebuilding every row
 * each time made the lists twitch (thumbnails reloaded, hover buttons
 * blinked). A row is made anew only when its `sig` changes.
 */
function sync(ol, items, key, sig, make) {
  const old = new Map([...ol.children].map((li) => [li.dataset.key, li]));
  const rows = items.map((it, i) => {
    const k = String(key(it));
    const sg = sig(it, i);
    const have = old.get(k);
    if (have && have.dataset.sig === sg) return have;
    const li = make(it, i);
    li.dataset.key = k;
    li.dataset.sig = sg;
    return li;
  });
  const keep = new Set(rows);
  for (const li of [...ol.children]) if (!keep.has(li)) li.remove();
  rows.forEach((li, i) => {
    if (ol.children[i] !== li) ol.insertBefore(li, ol.children[i] ?? null);
  });
}

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
  for (const id of ["audience", "mode", "maxHeight", "windowBg"]) {
    for (const b of $("m-" + id).children) b.classList.toggle("sel", b.dataset.v === String(m[id]));
  }
  $("m-maxHeight").style.display = m.mode === "video" ? "" : "none";
  for (const id of ["m-volume", "m-stream"]) {
    $(id).value = m.volume;
    fill($(id));
  }
  $("m-streamVal").textContent = `${m.volume}%`;
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
  for (const id of ["audience", "mode", "maxHeight", "windowBg"]) {
    for (const b of $("m-" + id).children) {
      b.onclick = () => {
        m()[id] = id === "maxHeight" ? Number(b.dataset.v) : b.dataset.v;
        for (const s of $("m-" + id).children) s.classList.toggle("sel", s === b);
        $("m-maxHeight").style.display = m().mode === "video" ? "" : "none";
        if (id === "windowBg") window.mgi.music.windowBg(b.dataset.v);
        touched();
      };
    }
  }
  for (const id of ["m-volume", "m-stream"]) {
    $(id).oninput = () => {
      m().volume = Number($(id).value);
      for (const other of ["m-volume", "m-stream"]) {
        $(other).value = m().volume;
        fill($(other));
      }
      $("m-streamVal").textContent = `${m().volume}%`;
      touched();
    };
  }
  $("m-mute").onclick = () => {
    m().muted = !m().muted;
    $("m-mute").classList.toggle("on", m().muted);
    volume();
    touched();
  };
  $("m-copy").onclick = () => window.mgi.music.copyUrl();
  $("m-window").onclick = async () => {
    const res = await window.mgi.music.window(m().windowBg);
    if (res && !res.ok) $("m-url").textContent = tr("notRunning");
  };
  window.mgi.on("music:window", (open) => {
    windowOpen = open;
    $("m-window").textContent = tr(open ? "m.windowClose" : "m.windowOpen");
    $("pet-window").textContent = $("m-window").textContent;
  });

  $("m-play").onclick = () => {
    if (!playing) return;
    if (player.paused) player.play().catch(() => {});
    else player.pause();
  };
  $("m-skip").onclick = () => window.mgi.music.control({ action: "skip" });
  $("m-wish").onclick = () => wish(state.current?.uid);
  $("m-wishPlay").onclick = () => (state.wishlist ? window.mgi.wishlist.stop() : playWishes());
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

// ── the wishlist ─────────────────────────────────────────────────────────────

const wished = (id) => wishes.some((w) => w.id === id);

async function wish(uid) {
  if (!uid) return;
  wishes = (await window.mgi.wishlist.add(uid)) || [];
  // The whole deck: the queue rows lose their «в вишлист» at once.
  render(state);
}

async function playWishes(id = null) {
  const r = await window.mgi.wishlist.play(id, tr("m.wishNick"));
  if (r?.error) logLine({ nick: tr("m.wishNick"), title: "", ok: false, reason: "offAir" });
}

function renderWishes(list) {
  wishes = list || [];
  const now = state.current?.wish ? state.current.id : "";
  sync($("wishList"), wishes, (w) => w.id, (w, i) => [i, w.id === now].join("|"), wishRow);
  $("wishEmpty").textContent = wishes.length ? "" : tr("m.wishEmpty");
  const c = state.current;
  $("m-wish").textContent = tr(c && wished(c.id) ? "m.wished" : "m.wish");
  $("m-wish").classList.toggle("on", Boolean(c && wished(c.id)));
  $("m-wishPlay").textContent = tr(state.wishlist ? "m.wishStop" : "m.wishPlay");
  $("m-wishPlay").classList.toggle("on", Boolean(state.wishlist));
  $("m-wishPlay").disabled = !wishes.length && !state.wishlist;
}

function wishRow(w, i) {
  const li = document.createElement("li");
  const now = state.current?.wish && state.current.id === w.id;
  li.className = now ? "track playing" : "track";
  li.innerHTML = `<span class="n">${i + 1}</span><img alt="" src="${esc(w.thumbnail)}">
    <div class="t"><b>${esc(w.title)}</b><span>${esc(w.channel || w.nick)} · ${clock(w.duration)}</span></div>
    <div class="acts"></div>`;
  const acts = li.querySelector(".acts");
  const btn = (label, fn, cls = "") => {
    const b = document.createElement("button");
    b.textContent = label;
    if (cls) b.className = cls;
    b.onclick = fn;
    acts.append(b);
  };
  if (!now) btn(tr("m.wishPlayOne"), () => playWishes(w.id), "yes");
  btn(tr("m.wishOpen"), () => window.mgi.wishlist.open(w.id));
  btn(tr("m.remove"), async () => {
    wishes = (await window.mgi.wishlist.remove(w.id)) || [];
    render(state);
  });
  return li;
}

// ── playback ─────────────────────────────────────────────────────────────────

function volume() {
  const m = cfg.music;
  // The sound is the music window's; this player only keeps the time.
  player.muted = true;
  $("m-mute").textContent = m.muted ? tr("m.unmute") : tr("m.mute");
}

/** Chat speech in this window lowers the music while it talks. */
export function duck(on) {
  if (ducked === on) return;
  ducked = on;
  window.mgi.music.duck(on);
}

function play({ track, url }) {
  playing = track;
  player.src = url;
  // A track cut off by a restart goes on from where it was.
  player.currentTime = track.start || 0;
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
  li.innerHTML = `<span class="n">${i + 1}</span><img alt="" src="${esc(t.thumbnail)}">
    <div class="t"><b>${esc(t.title)}</b><span>${esc(t.nick)} · ${clock(t.duration)}<span class="st"></span></span>
    ${t.state === "loading" ? `<div class="load"><i></i></div>` : ""}</div>
    <div class="acts"></div>`;
  paintStatus(li, t);
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
  if (!wished(t.id)) btn(tr("m.wishShort"), () => wish(t.uid));
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

/** The download share of a row, changed in place without rebuilding it. */
function paintStatus(li, t) {
  const pct = Math.round((t.progress || 0) * 100);
  const status = t.state === "loading" ? `${tr("m.loading")} ${pct}%` : t.state === "ready" ? tr("m.ready") : "";
  li.querySelector(".st").textContent = status ? " · " + status : "";
  // Through CSSOM: the page's CSP refuses style attributes in markup.
  li.querySelector(".load i")?.style.setProperty("--p", `${pct}%`);
}

const rowSig = (kind) => (t, i) => [kind, i, t.state, t.title, t.nick, wished(t.id)].join("|");

function render(s) {
  state = s;
  const c = s.current;
  const now = $("now");
  now.className = c ? (c.video ? "" : "audio") : "idle";
  // The same picture again would still flash: set only a new one.
  if ($("mcover").getAttribute("src") !== (c?.thumbnail || "")) $("mcover").src = c?.thumbnail || "";
  $("nowWho").textContent = c ? `${tr("m.orderedBy")} ${c.nick}${s.votes ? ` · ${tr("m.votes")} ${s.votes}` : ""}` : "";
  $("nowTitle").textContent = c ? c.title : tr("m.nothing");
  if (!c) {
    $("nowTime").textContent = "";
    $("seekFill").style.width = "0";
  }

  $("pendingBox").classList.toggle("on", s.pending.length > 0);
  sync($("pendingList"), s.pending, (t) => t.uid, rowSig("pending"), (t, i) => row(t, i, "pending"));
  sync($("queueList"), s.queue, (t) => t.uid, rowSig("queue"), (t, i) => row(t, i, "queue"));
  for (const t of [...s.pending, ...s.queue]) {
    const li = document.querySelector(`#pendingList li[data-key="${t.uid}"], #queueList li[data-key="${t.uid}"]`);
    if (li) paintStatus(li, t);
  }
  $("queueEmpty").textContent = s.queue.length ? "" : tr("m.queueEmpty", cfg?.music.cmd || "/music");
  renderWishes(wishes);
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

let windowOpen = false;

export function setUrl(url) {
  $("m-url").textContent = url || tr("notRunning");
}

export function relabel() {
  if (!cfg) return;
  $("m-window").textContent = tr(windowOpen ? "m.windowClose" : "m.windowOpen");
  $("pet-window").textContent = $("m-window").textContent;
  paint();
  // Rows carry translated labels: a new language makes them all anew.
  for (const id of ["pendingList", "queueList", "wishList"]) $(id).replaceChildren();
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
  wishes = await window.mgi.wishlist.get();
  render(await window.mgi.music.state());
  relabel();
  // The first answer waits for the hardware ids (a PowerShell call, a few
  // seconds); the tab is usable meanwhile.
  window.mgi.account.get().then((a) => {
    account = a;
    renderAccount();
  });
}
