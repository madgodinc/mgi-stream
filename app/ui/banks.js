// The «Копилки» tab: piggy banks and gift rules, each read and edited as one
// sentence ("Когда копилка «Тьма» наберёт 350 монет → затемнить экран на
// 10 с"), the kill switch, and what fired lately. The left column is the line
// of banks in fill order; the right column edits the one picked.
//
// Settings save with the rest of the config (cfg.banks, cfg.gifts, cfg.fx);
// the jars' progress comes from the main process (core/banks.js).

import { tr, lang, t } from "./i18n.js";
import { normalizeStep, normalizeBank, normalizeGiftRule, stepsText, newId, pressesKeys } from "../core/rules.js";
import { keyLabel, comboFromEvent, vk } from "../core/keys.js";
import { KNOWN_GIFTS } from "../core/gifts.js";
import { DOTA2 } from "../core/games/dota2.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const DOTA_EXE = DOTA2.exe;
const COIN_USD = 0.005; // 100 coins are about half a dollar (Mad, 23.10.2026)
const GOALS = [100, 350, 1000, 3000, 10000];
const COLORS = ["#000000", "#ffffff", "#ff1a1a", "#7a2cff"];

let cfg = null;
let touched = () => {};
let snap = { active: "", banks: [], log: [] };
let pick = null; // { type: "bank" | "gift", id }
let capture = null; // what the next keydown sets
let delArmed = "";
let note = "";
const fxLog = [];

// ── small pieces ─────────────────────────────────────────────────────────────

const plural = (n, [one, few, many]) => {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  return a > 10 && a < 20 ? many : b > 1 && b < 5 ? few : b === 1 ? one : many;
};
const coinsWord = (n) => plural(n, t.fx.coins);
const usd = (coins) => {
  const v = coins * COIN_USD;
  const t = v >= 10 ? Math.round(v).toString() : v.toFixed(2);
  return lang === "ru" ? `${t.replace(".", ",")} $` : `$${t}`;
};
const giftPrice = (name) => KNOWN_GIFTS.find(([n]) => n.toLowerCase() === String(name).trim().toLowerCase())?.[1];

let vid = 0;
/** A round glass vessel filled to `level` (0..1) with a moving surface. */
function vessel(level, cls = "") {
  const id = `vs${vid++}`;
  const y = 96 - Math.max(0, Math.min(1, level)) * 92;
  return `<svg class="vessel ${cls}" viewBox="0 0 100 100" aria-hidden="true">
    <defs><clipPath id="${id}"><circle cx="50" cy="50" r="43"/></clipPath>
    <linearGradient id="${id}g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="vessel__top"/><stop offset="1" class="vessel__deep"/></linearGradient></defs>
    <circle cx="50" cy="50" r="47" class="vessel__rim"/>
    <g clip-path="url(#${id})"><g class="vessel__level" data-css="transform:translateY(${y}px)">
      <path class="vessel__wave vessel__wave--back" d="M0 2 Q12.5 -4 25 2 T50 2 T75 2 T100 2 T125 2 T150 2 T175 2 T200 2 V110 H0Z"/>
      <path class="vessel__wave" fill="url(#${id}g)" d="M0 0 Q12.5 6 25 0 T50 0 T75 0 T100 0 T125 0 T150 0 T175 0 T200 0 V110 H0Z"/>
    </g></g>
    <path class="vessel__shine" d="M24 34 A30 30 0 0 1 40 18"/>
  </svg>`;
}

// The window's CSP drops style attributes in markup; inline styles go through the CSSOM.
function styled(root) {
  for (const el of root.querySelectorAll("[data-css]")) el.style.cssText = el.dataset.css;
  return root;
}

const jarOf = (id) => snap.banks.find((b) => b.id === id) ?? { have: 0, round: [] };
const bankOf = (id) => cfg.banks.find((b) => b.id === id);
const giftOf = (id) => cfg.gifts.find((g) => g.id === id);
const current = () => (pick?.type === "bank" ? bankOf(pick.id) : pick?.type === "gift" ? giftOf(pick.id) : null);

function save() {
  touched();
}

// ── templates ────────────────────────────────────────────────────────────────

const key = (code, mods = [], repeat = 1) => ({ kind: "key", code, mods, repeat });
const dotaKey = (id) => {
  const a = DOTA2.actions.find((x) => x.id === id);
  if (!a) return [];
  return [a.hold ? { kind: "hold", code: a.code, mods: a.mods, seconds: 3 } : key(a.code, a.mods, a.repeat)];
};
const TPL = {
  screen: {
    dark: () => [{ kind: "dim", level: 90, color: "#000000", seconds: 10 }],
    flash: () => [{ kind: "dim", level: 100, color: "#ffffff", seconds: 0.6 }],
    red: () => [{ kind: "dim", level: 55, color: "#ff1a1a", seconds: 5 }],
  },
  system: {
    alttab: () => [key("Tab", ["alt"]), { kind: "delay", ms: 3000 }, key("Tab", ["alt"])],
    altf4: () => [key("F4", ["alt"])],
  },
  dota: {
    ult: () => dotaKey("ult"),
    tpBase: () => dotaKey("tp_base"),
    stop: () => dotaKey("stop"),
    hold: () => dotaKey("hold"),
    scoreboard: () => dotaKey("scoreboard"),
  },
};

function addSteps(list, dota = false) {
  const r = current();
  if (!r) return;
  r.steps.push(...list.map(normalizeStep).filter(Boolean));
  // A Dota key pressed into OBS is worse than one not pressed: guard on by default.
  if (dota && !r.game) r.game = DOTA_EXE;
  save();
  renderAll();
}

const STARTERS = [
  { key: "dark", goal: 350, steps: () => TPL.screen.dark() },
  { key: "home", goal: 1000, steps: () => TPL.dota.tpBase(), game: DOTA_EXE },
  { key: "hide", goal: 3000, steps: () => TPL.system.alttab() },
];

// ── the left column ──────────────────────────────────────────────────────────

function renderLine() {
  const box = $("bk-line");
  const n = cfg.banks.length;
  box.innerHTML = cfg.banks
    .map((b, i) => {
      const jar = jarOf(b.id);
      const active = snap.active === b.id;
      const tag = b.paused ? tr("fx.state.paused") : active ? tr("fx.state.active") : tr("fx.state.waiting");
      return `<li class="bk${active ? " is-active" : ""}${b.paused ? " is-paused" : ""}${pick?.id === b.id ? " is-picked" : ""}" data-id="${esc(b.id)}">
        <button class="bk__hit" data-act="pick">${vessel(jar.have / b.goal, "vessel--sm")}
          <span class="bk__text"><b>${esc(b.name)}</b><span class="bk__nums">${jar.have} / ${b.goal}</span><span class="bk__does">${esc(stepsText(b.steps, lang))}</span></span>
          <span class="bk__tag">${tag}</span></button>
        <span class="bk__move"><button data-act="up" title="${tr("fx.up")}" ${i === 0 ? "disabled" : ""}>↑</button><button data-act="down" title="${tr("fx.down")}" ${i === n - 1 ? "disabled" : ""}>↓</button></span>
      </li>`;
    })
    .join("");
  styled(box);
}

function renderGifts() {
  const box = $("gr-list");
  box.innerHTML = cfg.gifts.length
    ? cfg.gifts
        .map(
          (g) => `<li class="gr${g.enabled ? "" : " is-off"}${pick?.id === g.id ? " is-picked" : ""}" data-id="${esc(g.id)}">
        <button class="gr__hit" data-act="pick"><b>${esc(g.gift || "?")}</b><span class="gr__arrow">→</span><span class="gr__does">${esc(stepsText(g.steps, lang))}</span></button></li>`,
        )
        .join("")
    : `<li class="hint">${tr("fx.emptyGifts")}</li>`;
}

function renderKill() {
  const k = cfg.fx.killKey;
  $("fx-killKeyCap").textContent = k;
  $("fx-killKey").textContent = capture?.what === "kill" ? tr("fx.killKeyPress") : k;
  $("fx-killKey").classList.toggle("is-capturing", capture?.what === "kill");
  $("fx-enabled").classList.toggle("on", cfg.fx.enabled);
  $("fx-enabledNote").textContent = cfg.fx.enabled ? "" : tr("fx.enabledOff");
  $("fx-inputNote").textContent = snap.input === false ? tr("fx.noInput", snap.inputError || "Windows only") : "";
  $("fx-killNote").textContent = snap.killKey && snap.killKey.combo !== k ? "" : snap.killKey?.ok === false ? tr("fx.killKeyBusy") : "";
}

function renderLog() {
  const box = $("fx-log");
  const time = (at) => new Date(at).toLocaleTimeString(lang === "ru" ? "ru-RU" : "en-GB", { hour: "2-digit", minute: "2-digit" });
  box.innerHTML = fxLog.length
    ? fxLog
        .slice(0, 6)
        .map((l) => `<li class="t-${l.type}"><span class="mono">${time(l.at)}</span> <b>${esc(l.name || "")}</b>${l.who ? ` · ${esc(l.who)}` : ""} · ${esc(tr("fx.log." + l.type))}${l.type === "error" && l.text ? `: ${esc(l.text)}` : ""}</li>`)
        .join("")
    : `<li class="hint">${tr("fx.logEmpty")}</li>`;
}

// ── the editor ───────────────────────────────────────────────────────────────

function stepRow(s, i, n) {
  const num = (f, v, { step = 1, min = 0, max = 9999, w = 4 } = {}) =>
    `<input class="tok tok--num" type="number" data-f="${f}" value="${v}" step="${step}" min="${min}" max="${max}" data-css="--w:${w}ch">`;
  const keycap = () => `<button class="keycap${capture?.what === "step" && capture.i === i ? " is-capturing" : ""}" data-act="key">${capture?.what === "step" && capture.i === i ? tr("fx.keyPress") : esc(keyLabel(s.code, s.mods))}</button>`;
  let body = "";
  switch (s.kind) {
    case "key":
      body = `${tr("fx.sPress")} ${keycap()} ${num("repeat", s.repeat, { min: 1, max: 50, w: 3 })} ${tr("fx.sTimes")}`;
      break;
    case "hold":
      body = `${tr("fx.sHold")} ${keycap()} ${tr("fx.sFor")} ${num("seconds", s.seconds, { step: 0.5, min: 0.1, max: 120 })} ${tr("fx.sSec")}`;
      break;
    case "delay":
      body = `${tr("fx.sWait")} ${num("sec", s.ms / 1000, { step: 0.5, min: 0, max: 60 })} ${tr("fx.sSec")}`;
      break;
    case "dim":
      body = `${tr("fx.sDim")} ${num("seconds", s.seconds, { step: 0.5, min: 0.1, max: 120 })} ${tr("fx.sSec")},
        ${tr("fx.sLevel")} ${num("level", s.level, { min: 5, max: 100, w: 3 })}%,
        <span class="swatches">${COLORS.map((c) => `<button class="sw${c === s.color ? " sel" : ""}" data-act="color" data-color="${c}" data-css="--sw:${c}" title="${c}"></button>`).join("")}<input type="color" class="sw sw--any" data-f="color" value="${s.color}"></span>`;
      break;
    case "media":
      body = `${tr("fx.sShow")} <button class="tok tok--file" data-act="file" data-kind="media">${esc(s.name || tr("fx.sPick"))}</button>
        ${tr("fx.sFor")} ${num("seconds", s.seconds, { step: 0.5, min: 0, max: 120 })} ${tr("fx.sSec")},
        ${tr("fx.sSize")} ${num("size", s.size, { min: 5, max: 100, w: 3 })}%,
        ${tr("fx.sWhere")} <span class="spots">${["tl", "tc", "tr", "ml", "c", "mr", "bl", "bc", "br"].map((p) => `<button class="${p === s.pos ? "sel" : ""}" data-act="pos" data-pos="${p}"></button>`).join("")}</span>
        <span class="hint inline-hint">${tr("fx.sToEnd")}</span>`;
      break;
    case "click":
      body = `${tr("fx.sClick")} <select class="tok" data-f="button">${["left", "right", "middle"].map((b) => `<option value="${b}" ${b === s.button ? "selected" : ""}>${tr("fx.sButton." + b)}</option>`).join("")}</select> ${tr("fx.sClickTail")} ${num("repeat", s.repeat, { min: 1, max: 50, w: 3 })} ${tr("fx.sTimes")}`;
      break;
    case "say":
      body = `${tr("fx.sSay")} <input class="tok tok--text" type="text" data-f="text" maxlength="140" value="${esc(s.text)}" placeholder="${esc(tr("fx.sSayPh"))}">`;
      break;
    case "sound":
      body = `${tr("fx.sSound")} <button class="tok tok--file" data-act="file" data-kind="sound">${esc(s.name || tr("fx.sPick"))}</button>, ${tr("fx.sVolume")} ${num("volume", s.volume, { min: 0, max: 100, w: 3 })}%`;
      break;
  }
  return `<li class="st st--${s.kind}" data-i="${i}"><span class="st__n">${i + 1}</span><div class="st__say">${body}</div>
    <span class="st__acts"><button data-act="sup" ${i === 0 ? "disabled" : ""} title="${tr("fx.up")}">↑</button><button data-act="sdown" ${i === n - 1 ? "disabled" : ""} title="${tr("fx.down")}">↓</button><button data-act="sdel" title="${tr("fx.remove")}">×</button></span></li>`;
}

function templatesBlock() {
  const chips = (group, dota) =>
    Object.keys(TPL[group])
      .map((k) => `<button class="chip" data-act="tpl" data-group="${group}" data-tpl="${k}"${dota ? ' data-dota="1"' : ""}>${tr("fx.tpl." + k)}</button>`)
      .join("");
  const name = (x) => (lang === "ru" ? x.ru : x.en);
  return `<div class="tpls">
    <div class="tpls__row"><span class="tpls__g">${tr("fx.tpl.screen")}</span>${chips("screen")}</div>
    <div class="tpls__row"><span class="tpls__g">${tr("fx.tpl.system")}</span>${chips("system")}</div>
    <div class="tpls__row"><span class="tpls__g">${tr("fx.tpl.dota")}</span>${chips("dota", true)}
      <select class="chip chip--sel" data-act="dotaKey"><option value="">${tr("fx.tpl.anyKey")}</option>${DOTA2.actions.map((a) => `<option value="${a.id}">${esc(name(a))} · ${esc(keyLabel(a.code, a.mods))}</option>`).join("")}</select>
      <select class="chip chip--sel" data-act="hero"><option value="">${tr("fx.tpl.hero")}</option>${DOTA2.heroes.map((h, i) => `<option value="${i}">${esc(name(h))}</option>`).join("")}</select>
      <select class="chip chip--sel" data-act="skill" hidden></select>
    </div>
  </div>`;
}

function renderEditor() {
  const box = $("rules");
  box.innerHTML = editorHtml();
  styled(box);
}

function editorHtml() {
  const r = current();
  if (!r) {
    if (!cfg.banks.length && !cfg.gifts.length) {
      return `<div class="ed-empty"><p>${tr("fx.empty")}</p><div class="starters">${STARTERS.map(
        (s, i) => `<button class="starter" data-act="starter" data-key="${s.key}">${vessel(0.3 + i * 0.25, "vessel--md")}<span><b>«${esc(tr("fx.starters." + s.key))}»</b> ${s.goal} ${esc(coinsWord(s.goal))}<br><em>→ ${esc(stepsText(s.steps().map(normalizeStep), lang))}</em></span></button>`,
      ).join("")}<button class="secondary small" data-act="blank">${tr("fx.blank")}</button></div></div>`;
    }
    return `<div class="ed-empty"><p>${tr("fx.pickOne")}</p></div>`;
  }
  const isBank = pick.type === "bank";
  const jar = isBank ? jarOf(r.id) : null;
  const n = r.steps.length;
  const sentence = isBank
    ? `<span class="say__w">${tr("fx.when")}</span> <input class="tok tok--name" data-r="name" maxlength="40" value="${esc(r.name)}" data-css="--w:${Math.max(3, r.name.length + 0.6)}ch">
       <span class="say__w">${tr("fx.reaches")}</span> <input class="tok tok--goal" type="number" data-r="goal" min="1" max="1000000" value="${r.goal}" data-css="--w:${String(r.goal).length + 0.8}ch">
       <span class="say__w" id="ed-coins">${esc(coinsWord(r.goal))}</span>`
    : `<span class="say__w">${tr("fx.whenGift")}</span> <input class="tok tok--name" data-r="gift" list="known-gifts" maxlength="60" value="${esc(r.gift)}" placeholder="${tr("fx.giftPlaceholder")}" data-css="--w:${Math.max(7, r.gift.length + 1)}ch">`;
  const money = isBank
    ? `<div class="goalrow"><span class="money" id="ed-money">${tr("fx.money", `${r.goal} ${coinsWord(r.goal)}`).replace("$2", usd(r.goal))}</span>
        ${GOALS.map((g) => `<button class="chip${g === r.goal ? " sel" : ""}" data-act="goal" data-goal="${g}">${g}</button>`).join("")}
        <span class="hint">${tr("fx.moneyHint")}</span></div>`
    : `<div class="goalrow"><span class="money" id="ed-money">${giftPrice(r.gift) ? `1 «${esc(r.gift)}» ≈ ${giftPrice(r.gift)} ${esc(coinsWord(giftPrice(r.gift)))}` : esc(tr("fx.giftUnknown"))}</span>
        <span class="hint">${tr("fx.giftHint")}</span></div>
        <datalist id="known-gifts">${KNOWN_GIFTS.map(([g]) => `<option value="${esc(g)}">`).join("")}</datalist>`;
  const side = isBank
    ? `<aside class="ed__side">
        ${vessel(jar.have / r.goal, "vessel--lg")}
        <div class="ed__fill"><b>${jar.have}</b> <span>${tr("fx.of")} ${r.goal}</span></div>
        <div class="mono label">${tr("fx.round")}</div>
        <ol class="who">${jar.round.length ? jar.round.slice(0, 6).map(([nick, c]) => `<li><span>${esc(nick)}</span><b>${c}</b></li>`).join("") : `<li class="hint">${tr("fx.nobody")}</li>`}</ol>
        <div class="mono label">${tr("fx.history")}</div>
        <ol class="fills">${historyOf(r.id)}</ol>
      </aside>`
    : "";
  const guard = pressesKeys(r.steps) || r.game;
  return `<div class="ed ed--${pick.type}">
    <div class="ed__main">
      <p class="say">${sentence}<span class="say__arrow">→</span><span class="say__does" id="ed-does">${esc(stepsText(r.steps, lang))}</span></p>
      ${money}
      <div class="ed__steps">
        <div class="mono label">${tr("fx.steps")}</div>
        ${n > 1 ? `<p class="hint">${tr("fx.stepsHint")}</p>` : ""}
        <ol class="steps">${r.steps.map((s, i) => stepRow(s, i, n)).join("")}</ol>
        <div class="adds"><span class="mono">${tr("fx.add")}</span>${["key", "hold", "dim", "media", "delay", "say", "sound", "click"].map((k) => `<button class="chip chip--add" data-act="add" data-kind="${k}">${tr("fx.kinds." + k)}</button>`).join("")}</div>
        <details class="tpl-box" ${n ? "" : "open"}><summary class="mono">${tr("fx.templates")}</summary>${templatesBlock()}</details>
        ${guard ? `<div class="check${r.game ? " on" : ""}" data-act="game"><i></i><span>${tr("fx.onlyGame")}</span></div><p class="hint">${tr("fx.onlyGameHint")}</p>` : ""}
        ${capture?.what === "step" ? `<p class="hint">${tr("fx.keyHint")}</p>` : ""}
      </div>
    </div>
    ${side}
    <div class="ed__bar">
      <button class="primary" data-act="test">${tr("fx.test")}</button>
      ${isBank ? `<button class="secondary small" data-act="pause">${tr(r.paused ? "fx.resume" : "fx.pause")}</button>
        ${snap.active !== r.id && !r.paused ? `<button class="secondary small" data-act="focus">${tr("fx.makeActive")}</button>` : ""}
        <button class="secondary small" data-act="reset" ${jar.have ? "" : "disabled"}>${tr("fx.reset")}</button>`
      : `<div class="check${r.enabled ? " on" : ""}" data-act="enabled"><i></i><span>${tr("fx.ruleOn")}</span></div>`}
      <span class="ed__note" id="ed-note">${esc(note)}</span>
      <button class="secondary small danger" data-act="del">${tr(delArmed === r.id ? "fx.delSure" : "fx.del")}</button>
    </div>
  </div>`;
}

function historyOf(id) {
  const fills = snap.log.filter((f) => f.bank === id).slice(0, 5);
  if (!fills.length) return `<li class="hint">${tr("fx.historyEmpty")}</li>`;
  const time = (at) => new Date(at).toLocaleString(lang === "ru" ? "ru-RU" : "en-GB", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  return fills
    .map((f) => {
      const best = f.top?.[0];
      return `<li><span class="mono">${time(f.at)}</span> ${esc(tr("fx.lastCoin", f.nick))}${best && best[0] !== f.nick ? `, ${esc(tr("fx.topGiver", `${best[0]} ${best[1]}`))}` : ""}</li>`;
    })
    .join("");
}

/** The parts of the editor that follow typing, without redrawing the inputs. */
function refreshSentence() {
  const r = current();
  if (!r) return;
  const does = $("ed-does");
  if (does) does.textContent = stepsText(r.steps, lang);
  if (pick.type === "bank") {
    $("ed-coins") && ($("ed-coins").textContent = coinsWord(r.goal));
    $("ed-money") && ($("ed-money").textContent = tr("fx.money", `${r.goal} ${coinsWord(r.goal)}`).replace("$2", usd(r.goal)));
  }
  renderLine();
  renderGifts();
}

function renderAll() {
  renderLine();
  renderGifts();
  renderKill();
  renderLog();
  renderEditor();
}

// ── events ───────────────────────────────────────────────────────────────────

function select(type, id) {
  pick = id ? { type, id } : null;
  delArmed = "";
  note = "";
  capture = null;
  renderAll();
}

function move(list, i, to) {
  if (to < 0 || to >= list.length) return;
  const [x] = list.splice(i, 1);
  list.splice(to, 0, x);
}

function onLeft(e) {
  const btn = e.target.closest("[data-act]");
  const li = e.target.closest("li[data-id]");
  if (!btn || !li) return;
  const id = li.dataset.id;
  const isBank = li.classList.contains("bk");
  const act = btn.dataset.act;
  if (act === "pick") return select(isBank ? "bank" : "gift", id);
  const i = cfg.banks.findIndex((b) => b.id === id);
  if (act === "up") move(cfg.banks, i, i - 1);
  if (act === "down") move(cfg.banks, i, i + 1);
  save();
  renderAll();
}

async function pickFile(step, kind) {
  const res = await window.mgi.fx.pick(kind);
  if (!res) return;
  if (res.error) {
    note = tr(res.error === "size" ? "fx.fileSize" : "fx.fileFormat");
    return renderEditor();
  }
  step.file = res.file;
  step.name = res.name;
  if (kind === "media" && /\.(mp4|webm|mov|m4v)$/i.test(res.file)) step.seconds = 0;
  save();
  renderAll();
}

async function onEditorClick(e) {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  const r = current();
  const li = btn.closest("li.st");
  const i = li ? Number(li.dataset.i) : -1;
  const s = r?.steps[i];

  if (act === "starter") {
    const st = STARTERS.find((x) => x.key === btn.dataset.key);
    const b = normalizeBank({ id: newId("b"), name: tr("fx.starters." + st.key), goal: st.goal, steps: st.steps(), game: st.game ?? "" });
    cfg.banks.push(b);
    save();
    return select("bank", b.id);
  }
  if (act === "blank") return addBank();
  if (!r) return;

  if (act === "goal") {
    r.goal = Number(btn.dataset.goal);
    save();
    return renderAll();
  }
  if (act === "add") return addSteps([{ kind: btn.dataset.kind }]);
  if (act === "tpl") return addSteps(TPL[btn.dataset.group][btn.dataset.tpl](), Boolean(btn.dataset.dota));
  if (act === "sup" || act === "sdown") {
    move(r.steps, i, act === "sup" ? i - 1 : i + 1);
    save();
    return renderAll();
  }
  if (act === "sdel") {
    r.steps.splice(i, 1);
    save();
    return renderAll();
  }
  if (act === "key") {
    capture = capture?.what === "step" && capture.i === i ? null : { what: "step", i };
    return renderEditor();
  }
  if (act === "color") {
    s.color = btn.dataset.color;
    save();
    return renderAll();
  }
  if (act === "pos") {
    s.pos = btn.dataset.pos;
    save();
    return renderEditor();
  }
  if (act === "file") return pickFile(s, btn.dataset.kind);
  if (act === "game") {
    r.game = r.game ? "" : DOTA_EXE;
    save();
    return renderEditor();
  }
  if (act === "enabled") {
    r.enabled = !r.enabled;
    save();
    return renderAll();
  }
  if (act === "pause") {
    r.paused = !r.paused;
    save();
    return renderAll();
  }
  if (act === "focus") {
    await window.mgi.banks.focus(r.id);
    return;
  }
  if (act === "reset") {
    await window.mgi.banks.reset(r.id);
    return;
  }
  if (act === "del") {
    if (delArmed !== r.id) {
      delArmed = r.id;
      return renderEditor();
    }
    if (pick.type === "bank") cfg.banks = cfg.banks.filter((b) => b.id !== r.id);
    else cfg.gifts = cfg.gifts.filter((g) => g.id !== r.id);
    save();
    return select(null, null);
  }
  if (act === "test") return test(r);
}

async function test(r) {
  // Saved first: the main process tests what is on disk.
  await window.mgi.saveConfig(cfg);
  const soon = pressesKeys(r.steps);
  note = !cfg.fx.enabled ? tr("fx.testOff") : soon ? tr("fx.testSoon") : "";
  renderEditor();
  const go = async () => {
    const res = pick.type === "bank" ? await window.mgi.banks.test(r.id) : await window.mgi.banks.testGift(r.id);
    if (!soon && cfg.fx.enabled) {
      note = tr(res?.live ? "fx.testLive" : "fx.testNotLive");
      const el = $("ed-note");
      if (el) el.textContent = note;
    }
  };
  // Keys go to the window in front: three seconds to switch to the game.
  if (soon && cfg.fx.enabled) setTimeout(go, 3000);
  else go();
}

function onEditorInput(e) {
  const r = current();
  const el = e.target;
  if (!r || !el.dataset) return;
  if (el.dataset.r) {
    const f = el.dataset.r;
    if (f === "goal") r.goal = Math.max(1, Math.min(1_000_000, Math.round(Number(el.value) || 1)));
    else r[f] = el.value;
    el.style.setProperty("--w", `${Math.max(3, String(el.value).length + (f === "goal" ? 0.8 : 0.6))}ch`);
    save();
    return refreshSentence();
  }
  const li = el.closest("li.st");
  if (!li || !el.dataset.f) return;
  const s = r.steps[Number(li.dataset.i)];
  const f = el.dataset.f;
  if (f === "sec") s.ms = Math.round(Number(el.value) * 1000);
  else if (["text", "button", "color"].includes(f)) s[f] = el.value;
  else s[f] = Number(el.value);
  // Out-of-range values settle on leaving the field, not under the cursor.
  if (e.type === "change") Object.assign(s, normalizeStep(s));
  save();
  refreshSentence();
}

function addBank() {
  const b = normalizeBank({ id: newId("b"), name: `${tr("fx.newBank")} ${cfg.banks.length + 1}`, goal: 350, steps: [] });
  cfg.banks.push(b);
  save();
  select("bank", b.id);
}

function addGift() {
  const g = normalizeGiftRule({ id: newId("g"), gift: "Galaxy", steps: TPL.screen.flash() });
  cfg.gifts.push(g);
  save();
  select("gift", g.id);
}

// A key for a step, or the kill switch's combination, is caught here.
function onKey(e) {
  if (!capture || document.documentElement.dataset.tab !== "banks") return;
  e.preventDefault();
  e.stopPropagation();
  if (capture.what === "kill") {
    const combo = comboFromEvent(e);
    if (!combo) return;
    cfg.fx.killKey = combo;
    capture = null;
    save();
    return renderKill();
  }
  if (/^(Shift|Control|Alt|Meta)(Left|Right)$/.test(e.code) || vk(e.code) === null) return;
  const s = current()?.steps[capture.i];
  if (s) {
    s.code = e.code;
    s.mods = [e.ctrlKey && "ctrl", e.shiftKey && "shift", e.altKey && "alt", e.metaKey && "win"].filter(Boolean);
  }
  capture = null;
  save();
  renderAll();
}

function onHero(e) {
  const el = e.target;
  if (el.dataset.act === "dotaKey" && el.value) return addSteps(dotaKey(el.value), true);
  if (el.dataset.act === "hero") {
    const sk = el.parentElement.querySelector('[data-act="skill"]');
    const h = DOTA2.heroes[Number(el.value)];
    sk.hidden = !h;
    if (!h) return;
    const name = (x) => (lang === "ru" ? x.ru : x.en);
    sk.innerHTML = `<option value="">${tr("fx.tpl.skill")}</option>` + h.skills.map((s) => `<option value="${s.slot}">${esc(name(s))} · ${esc(keyLabel(DOTA2.actions.find((a) => a.id === s.slot)?.code ?? ""))}</option>`).join("");
    return;
  }
  if (el.dataset.act === "skill" && el.value) addSteps(dotaKey(el.value), true);
}

// ── wiring ───────────────────────────────────────────────────────────────────

export async function initBanks(opts) {
  cfg = opts.cfg;
  touched = opts.touched;
  $("bk-line").onclick = onLeft;
  $("gr-list").onclick = onLeft;
  $("bk-add").onclick = addBank;
  $("gr-add").onclick = addGift;
  $("rules").addEventListener("click", onEditorClick);
  $("rules").addEventListener("input", onEditorInput);
  $("rules").addEventListener("change", (e) => (e.target.closest(".tpls") ? onHero(e) : onEditorInput(e)));
  document.addEventListener("keydown", onKey, true);
  $("fx-kill").onclick = () => window.mgi.fx.kill();
  $("fx-killKey").onclick = () => {
    capture = capture?.what === "kill" ? null : { what: "kill" };
    renderKill();
  };
  $("fx-enabled").onclick = () => {
    cfg.fx.enabled = !cfg.fx.enabled;
    save();
    renderKill();
  };
  window.mgi.on("banks:state", (s) => {
    snap = { ...snap, ...s };
    renderLine();
    // The editor's own numbers follow without losing what is being typed.
    if (pick?.type === "bank" && !document.activeElement?.closest?.("#rules")) renderEditor();
  });
  window.mgi.on("fx:log", (l) => {
    if (l.type === "done") return;
    fxLog.unshift(l);
    fxLog.length = Math.min(fxLog.length, 20);
    renderLog();
  });
  window.mgi.on("fx:killKey", (k) => {
    snap.killKey = k;
    renderKill();
  });
  snap = { ...snap, ...(await window.mgi.banks.state()) };
  if (cfg.banks.length) pick = { type: "bank", id: snap.active || cfg.banks[0].id };
  renderAll();
}

export function relabel() {
  if (cfg) renderAll();
}
