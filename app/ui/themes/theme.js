// The look every MGI program shares (docs/themes.md). This module puts the
// chosen id on <html data-theme> and draws the picker; storing the choice and
// following other programs is the app's backend (Rust `mgi_shared::theme`
// for the Tauri apps, mgi-stream's own for Electron), reached through the
// three functions the app passes in, so nothing here knows Tauri.

export const THEMES = ["studio", "silence", "night", "fog", "amber"];

// What each tile in the picker looks like: the theme itself, in miniature,
// whatever theme the window is in right now.
const SWATCH = {
  studio: { bg: "linear-gradient(135deg, #1a1030, #07060c 60%)", ink: "#f5f1ff", line: "rgba(255,255,255,.12)", acc: "#ff3d8b", r: "14px", font: "'Manrope', sans-serif", display: "'Unbounded', sans-serif" },
  silence: { bg: "#f2f0eb", ink: "#111111", line: "#111111", acc: "#e8321a", r: "0px", font: "'Inter Tight', sans-serif", display: "'Inter Tight', sans-serif" },
  night: { bg: "#0b0b0c", ink: "#ededed", line: "#2a2a2d", acc: "#c6ff3d", r: "18px", font: "'Onest', sans-serif", display: "'Onest', sans-serif" },
  fog: { bg: "radial-gradient(circle at 30% 20%, #23365f, #14161a 70%)", ink: "#e9ecf2", line: "rgba(255,255,255,.1)", acc: "#3d7bff", r: "20px", font: "'Geist', sans-serif", display: "'Geist', sans-serif" },
  amber: { bg: "#1a1714", ink: "#efe6d8", line: "#3a332b", acc: "#ffb000", r: "0px", font: "'Martian Mono', monospace", display: "'Literata', serif" },
};

const NAMES = {
  ru: { studio: "Студия", silence: "Тишина", night: "Ночной эфир", fog: "Туман", amber: "Янтарь" },
  uk: { studio: "Студія", silence: "Тиша", night: "Нічний ефір", fog: "Туман", amber: "Бурштин" },
  en: { studio: "Studio", silence: "Silence", night: "Night air", fog: "Fog", amber: "Amber" },
};

export const themeName = (id, lang = "ru") => (NAMES[lang] ?? NAMES.en)[id] ?? id;

let current = "studio";
const listeners = new Set();

export function applyTheme(id) {
  current = THEMES.includes(id) ? id : "studio";
  document.documentElement.dataset.theme = current;
  for (const fn of listeners) fn(current);
  return current;
}

export const theme = () => current;
export const onThemeChange = (fn) => (listeners.add(fn), () => listeners.delete(fn));

/**
 * `load()` gives the stored id, `save(id)` stores it, `subscribe(fn)` calls
 * fn(id) when another program changed it. Tauri apps:
 *   initTheme({ load: () => invoke("theme_state").then((s) => s.theme),
 *               save: (id) => invoke("theme_set", { theme: id }),
 *               subscribe: (fn) => listen("theme", (e) => fn(e.payload.theme)) })
 */
export async function initTheme({ load, save, subscribe }) {
  initTheme.save = save;
  // `load` may give the id alone or the backend's whole { theme, asked } state.
  let asked = true;
  try {
    const got = await load();
    const id = typeof got === "string" ? got : got?.theme;
    asked = typeof got === "string" ? true : Boolean(got?.asked);
    applyTheme(id);
  } catch {
    applyTheme("studio");
  }
  subscribe?.((id) => {
    if (!previewing) applyTheme(typeof id === "string" ? id : id?.theme);
  });
  return { asked };
}

// While the first-run question is open, a theme another program picks does
// not yank the preview away from under the streamer.
let previewing = false;

export async function chooseTheme(id) {
  applyTheme(id);
  try {
    await initTheme.save?.(id);
  } catch {}
}

/** Fills `el` with one tile per theme; `lang()` gives the window's language. */
export function mountThemePicker(el, { lang = () => "ru" } = {}) {
  el.classList.add("theme-pick");
  el.setAttribute("role", "radiogroup");
  const draw = () => {
    el.replaceChildren(
      ...THEMES.map((id) => {
        const b = tile(id, lang());
        b.onclick = () => chooseTheme(id);
        return b;
      }),
    );
  };
  draw();
  onThemeChange(draw);
  return { redraw: draw };
}

/** One tile: the theme itself in miniature, whatever theme the window is in. */
function tile(id, lng) {
  const s = SWATCH[id];
  const b = document.createElement("button");
  b.type = "button";
  b.className = "theme-pick__opt" + (id === current ? " is-on" : "");
  b.setAttribute("role", "radio");
  b.setAttribute("aria-checked", String(id === current));
  b.style.setProperty("--sw-bg", s.bg);
  b.style.setProperty("--sw-ink", s.ink);
  b.style.setProperty("--sw-line", s.line);
  b.style.setProperty("--sw-acc", s.acc);
  b.style.setProperty("--sw-r", s.r);
  b.style.setProperty("--sw-font", s.font);
  b.style.setProperty("--sw-display", s.display);
  const sample = document.createElement("span");
  sample.className = "theme-pick__sample";
  sample.textContent = "Аа";
  const dot = document.createElement("span");
  dot.className = "theme-pick__dot";
  const name = document.createElement("span");
  name.textContent = themeName(id, lng);
  b.append(sample, dot, name);
  return b;
}

const BUTTON = { ru: "Тема приложения", uk: "Тема застосунку", en: "App theme" };

/**
 * A "Тема приложения" button for the title bar: a click opens a small panel
 * with the picker right there, so a theme is one click away on every screen.
 * Put `el` (an empty element) in the bar's right-hand cluster.
 */
export function mountThemeButton(el, { lang = () => "ru" } = {}) {
  el.classList.add("theme-btn");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "theme-btn__open";
  btn.setAttribute("aria-haspopup", "dialog");
  btn.setAttribute("aria-expanded", "false");
  btn.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.6-.9 1.2-1.8-.5-1.1.3-2.2 1.5-2.2H17a4 4 0 0 0 4-4c0-5.5-4-10-9-10z"/><circle cx="7.5" cy="11" r="1.2"/><circle cx="10.5" cy="7" r="1.2"/><circle cx="15" cy="7.5" r="1.2"/></svg><span></span>';
  const panel = document.createElement("div");
  panel.className = "theme-btn__panel";
  panel.setAttribute("role", "dialog");
  panel.hidden = true;
  const pick = document.createElement("div");
  panel.append(pick);
  el.replaceChildren(btn, panel);
  const picker = mountThemePicker(pick, { lang });

  const label = () => {
    btn.querySelector("span").textContent = (BUTTON[lang()] ?? BUTTON.en);
    btn.title = btn.querySelector("span").textContent;
    panel.setAttribute("aria-label", btn.title);
  };
  const close = () => {
    panel.hidden = true;
    btn.setAttribute("aria-expanded", "false");
  };
  btn.onclick = (e) => {
    e.stopPropagation();
    panel.hidden = !panel.hidden;
    btn.setAttribute("aria-expanded", String(!panel.hidden));
  };
  panel.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", close);
  document.addEventListener("keydown", (e) => e.key === "Escape" && close());
  label();
  return { redraw: () => (label(), picker.redraw()) };
}

const ASK = {
  ru: { title: "Выберите, как будет выглядеть программа", hint: "Нажмите на тему: программа сразу переоденется, можно посмотреть каждую. Сменить её можно когда угодно кнопкой «Тема приложения» сверху. Выбор действует во всех программах MGI на этом компьютере.", keep: "Оставить «$1»" },
  uk: { title: "Оберіть, як виглядатиме програма", hint: "Натисніть на тему: програма одразу перевдягнеться, можна подивитися кожну. Змінити її можна будь-коли кнопкою «Тема застосунку» вгорі. Вибір діє в усіх програмах MGI на цьому комп'ютері.", keep: "Залишити «$1»" },
  en: { title: "Choose how the app looks", hint: "Click a theme and the app re-dresses at once, so you can try each one. Change it any time with the \"App theme\" button at the top. The choice applies to every MGI program on this computer.", keep: "Keep \"$1\"" },
};

/**
 * The first-run question: a panel at the bottom over the live window. A
 * click on a tile puts the whole app in that theme (the app itself is the
 * preview); the button keeps it. Resolves with the chosen id once it is saved.
 */
export function askTheme({ lang = () => "ru" } = {}) {
  return new Promise((resolve) => {
    previewing = true;
    const words = () => ASK[lang()] ?? ASK.en;
    const root = document.createElement("div");
    root.className = "theme-ask";
    root.innerHTML = '<div class="theme-ask__panel" role="dialog" aria-modal="true"><h2 class="theme-ask__title"></h2><p class="theme-ask__hint"></p><div class="theme-ask__pick"></div><button type="button" class="theme-ask__keep"></button></div>';
    document.body.append(root);
    const keep = root.querySelector(".theme-ask__keep");
    const pick = root.querySelector(".theme-ask__pick");
    pick.classList.add("theme-pick");
    const draw = () => {
      const w = words();
      root.querySelector(".theme-ask__title").textContent = w.title;
      root.querySelector(".theme-ask__hint").textContent = w.hint;
      root.querySelector(".theme-ask__panel").setAttribute("aria-label", w.title);
      keep.textContent = w.keep.replace("$1", themeName(current, lang()));
      pick.replaceChildren(
        ...THEMES.map((id) => {
          const b = tile(id, lang());
          b.onclick = () => {
            applyTheme(id);
            draw();
          };
          return b;
        }),
      );
    };
    draw();
    keep.onclick = async () => {
      previewing = false;
      root.classList.add("is-leaving");
      await chooseTheme(current);
      setTimeout(() => root.remove(), 350);
      resolve(current);
    };
    keep.focus();
  });
}
