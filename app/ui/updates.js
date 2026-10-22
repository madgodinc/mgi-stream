// The update strip and the "what changed" dialog, the same offer the other
// MGI programs make: a strip under the title bar says a new version is out,
// "what's new" lists every change since the installed one, and the streamer
// updates now, later, or skips that version. Backend: core/updates.js.

import { tr } from "./i18n.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function newer(a, b) {
  const x = String(a || "0").split(".").map(Number);
  const y = String(b || "0").split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
}

/** Releases after `from` up to and including `to`, newest first. */
const between = (history, from, to) => history.filter((h) => newer(h.version, from) && !newer(h.version, to));

const date = (d) => {
  const [y, m, day] = String(d || "").split("-");
  return day ? `${+day}.${m}.${y}` : "";
};

function list(releases) {
  if (!releases.length) return `<p class="hint">${tr("upd.noNotes")}</p>`;
  return releases
    .map((r) => {
      const changes = r.changes?.length ? `<ul>${r.changes.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>` : "";
      return `<section class="rel"><h3>${esc(r.version)} <em>${esc(date(r.date))}</em></h3><p>${esc(r.summary)}</p>${changes}</section>`;
    })
    .join("");
}

let info = { state: "idle" };
let version = "";

function strip() {
  const key = { available: "available", downloading: "downloading", ready: "ready", error: "error" }[info.state];
  $("upd").hidden = !key;
  if (!key) return;
  const pct = Math.round((info.progress || 0) * 100);
  $("upd-text").textContent = tr("upd." + key, info.state === "downloading" ? `${pct}%` : info.state === "error" ? info.detail : info.version);
  $("upd-open").hidden = info.state !== "available";
  $("upd-skip").hidden = info.state !== "available";
  $("upd-go").hidden = !["available", "error"].includes(info.state);
  $("upd-go").textContent = tr(info.state === "error" ? "upd.retry" : "upd.update");
}

function dialog(title, body, actions) {
  $("upd-title").textContent = title;
  $("upd-list").innerHTML = body;
  $("upd-actions").replaceChildren(
    ...actions.map(([id, label, primary]) => {
      const b = document.createElement("button");
      b.className = primary ? "primary" : "secondary";
      b.textContent = label;
      b.onclick = () => {
        $("upd-dlg").hidden = true;
        if (id === "go") window.mgi.updates.install();
        if (id === "skip") window.mgi.updates.skip(info.version);
      };
      return b;
    }),
  );
  $("upd-dlg").hidden = false;
}

async function offer() {
  const rel = between(await window.mgi.updates.history(), version, info.version);
  dialog(tr("upd.whatsNew", info.version), list(rel), [
    ["go", tr("upd.now"), true],
    ["later", tr("upd.later")],
    ["skip", tr("upd.skip")],
  ]);
}

export function relabel() {
  strip();
}

export async function initUpdates() {
  $("upd-open").onclick = offer;
  $("upd-go").onclick = () => window.mgi.updates.install();
  $("upd-skip").onclick = () => window.mgi.updates.skip(info.version);
  $("upd-dlg").onclick = (e) => e.target === $("upd-dlg") && ($("upd-dlg").hidden = true);
  window.mgi.on("update", (i) => {
    info = i;
    strip();
  });

  const s = await window.mgi.updates.state();
  version = s.version;
  if (s.info.state !== "idle") {
    info = s.info;
    strip();
  }
  // Just updated: say once what changed since the version the streamer had.
  const was = await window.mgi.updates.seen();
  if (!was || !newer(version, was)) return;
  const rel = between(await window.mgi.updates.history(), was, version);
  if (rel.length) dialog(tr("upd.updated", version), list(rel), [["ok", tr("upd.ok"), true]]);
}
