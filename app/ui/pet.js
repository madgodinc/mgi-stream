// The Слаймик tab: the slime that lives in the music window (core/pet.js,
// overlay/pet.html). Settings save with the rest of the config; the test
// button sends it a few roses through the running stream.

import { tr } from "./i18n.js";

const $ = (id) => document.getElementById(id);
const CHECKS = ["enabled", "thanks", "likes", "follows", "thoughts"];

let cfg = null;
let touched = () => {};

function paint() {
  const p = cfg.pet;
  for (const k of CHECKS) $("pet-" + k).classList.toggle("on", Boolean(p[k]));
  $("pet-name").value = p.name;
  for (const b of $("pet-color").children) b.classList.toggle("sel", b.dataset.v === p.color);
}

export function initPet(opts) {
  cfg = opts.cfg;
  touched = opts.touched;
  const p = () => cfg.pet;
  for (const k of CHECKS) {
    $("pet-" + k).onclick = () => {
      p()[k] = !p()[k];
      $("pet-" + k).classList.toggle("on", p()[k]);
      touched();
    };
  }
  $("pet-name").oninput = () => {
    p().name = $("pet-name").value.trim() || "Слаймик";
    touched();
  };
  for (const b of $("pet-color").children) {
    b.onclick = () => {
      p().color = b.dataset.v;
      for (const s of $("pet-color").children) s.classList.toggle("sel", s === b);
      touched();
    };
  }
  $("pet-test").onclick = async () => {
    const r = await window.mgi.pet.test();
    $("pet-note").textContent = tr(r?.ok ? "pet.testOn" : "pet.testOff");
  };
  // The same window as the music tab's button: the slime lives there.
  $("pet-window").onclick = () => $("m-window").click();
  paint();
}

export function relabel() {
  if (cfg) paint();
  $("pet-note").textContent = "";
}
