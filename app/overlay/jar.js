// The piggy bank viewers see beside the slime: a glass jar that fills with
// coins as gifts arrive, coins dropping in through the neck, and a jar that
// shakes and spills over when it is full. Drawn on a canvas; the caption
// under it is plain text so it stays sharp at any size.
//
// Coin positions come from a fixed hash, so the pile looks the same on every
// redraw instead of shimmering.

const hash = (a, b) => {
  const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

export function createJar(host, { shadow = true } = {}) {
  host.innerHTML = '<canvas class="jar__glass"></canvas><div class="jar__cap"><b class="jar__name"></b><span class="jar__count"></span></div>';
  const canvas = host.querySelector("canvas");
  const ctx = canvas.getContext("2d");
  const nameEl = host.querySelector(".jar__name");
  const countEl = host.querySelector(".jar__count");

  let w = 0;
  let h = 0;
  let shown = 0; // the level drawn, eased toward `level`
  let level = 0;
  let goal = 1;
  let have = 0;
  let falling = []; // coins on their way in: { x, y, vy, spin }
  let spill = []; // coins thrown out of a full jar
  let shakeUntil = 0;
  let glow = 0;
  let hold = 0; // while full, the pile waits before it empties
  let raf = 0;
  let seq = 0;

  function size() {
    const dpr = devicePixelRatio || 1;
    w = host.clientWidth;
    h = Math.round(w * 1.22);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // The jar's inside, where coins lie.
  const inner = () => ({ x: w * 0.13, y: h * 0.27, w: w * 0.74, h: h * 0.66 });

  function jarPath() {
    const bx = w * 0.08;
    const bw = w * 0.84;
    const top = h * 0.22;
    const r = w * 0.2;
    const neckL = w * 0.24;
    const neckR = w * 0.76;
    ctx.beginPath();
    ctx.moveTo(neckL, h * 0.1);
    ctx.lineTo(neckL, top - h * 0.02);
    ctx.quadraticCurveTo(bx, top, bx, top + r);
    ctx.lineTo(bx, h - 6 - r * 0.6);
    ctx.quadraticCurveTo(bx, h - 6, bx + r * 0.6, h - 6);
    ctx.lineTo(bx + bw - r * 0.6, h - 6);
    ctx.quadraticCurveTo(bx + bw, h - 6, bx + bw, h - 6 - r * 0.6);
    ctx.lineTo(bx + bw, top + r);
    ctx.quadraticCurveTo(bx + bw, top, neckR, top - h * 0.02);
    ctx.lineTo(neckR, h * 0.1);
  }

  function coin(x, y, rx, tilt = 0) {
    const ry = rx * 0.42;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(tilt);
    // the edge, a shade darker, under the face
    ctx.beginPath();
    ctx.ellipse(0, ry * 0.5, rx, ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = "#a8650a";
    ctx.fill();
    const g = ctx.createLinearGradient(-rx, -ry, rx, ry);
    g.addColorStop(0, "#fff1a8");
    g.addColorStop(0.45, "#ffc93d");
    g.addColorStop(1, "#e08a12");
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(0, 0, rx * 0.62, ry * 0.62, 0, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(160, 90, 10, .55)";
    ctx.lineWidth = Math.max(1, rx * 0.12);
    ctx.stroke();
    ctx.restore();
  }

  /** The pile: rows of coins from the bottom up to `lvl` of the inside. */
  function pile(lvl) {
    const box = inner();
    const rx = w * 0.095;
    const step = rx * 0.62;
    const rows = Math.floor((box.h * lvl) / step);
    const per = Math.max(3, Math.floor(box.w / (rx * 1.55)));
    for (let r = 0; r <= rows; r++) {
      const y = box.y + box.h - rx * 0.3 - r * step;
      // the top row is only as full as the level reaches into it
      const part = r === rows ? (box.h * lvl - rows * step) / step : 1;
      const n = Math.round(per * Math.max(0, Math.min(1, part)));
      for (let i = 0; i < n; i++) {
        const k = hash(r, i);
        const x = box.x + rx * 0.9 + ((i + (r % 2) * 0.5) / per) * (box.w - rx * 1.6) + (k - 0.5) * rx * 0.5;
        coin(Math.min(box.x + box.w - rx * 0.8, x), y + (hash(i, r) - 0.5) * 3, rx, (k - 0.5) * 0.35);
      }
    }
    return box.y + box.h - (rows + 0.5) * step;
  }

  function draw(t) {
    raf = 0;
    if (!w) size();
    ctx.clearRect(0, 0, w, h);
    const shaking = t < shakeUntil;
    ctx.save();
    if (shaking) ctx.translate(Math.sin(t / 28) * w * 0.035, Math.cos(t / 41) * 1.5);

    // glow behind a full jar
    if (glow > 0.01) {
      const r = w * 0.5;
      const g = ctx.createRadialGradient(w / 2, h * 0.6, 0, w / 2, h * 0.6, r);
      g.addColorStop(0, `rgba(255, 210, 80, ${0.55 * glow})`);
      g.addColorStop(1, "rgba(255, 210, 80, 0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(w / 2, h * 0.6, r, 0, Math.PI * 2);
      ctx.fill();
      glow *= 0.985;
    }

    // its shadow on the floor; none over a chroma-key green, it would key badly
    if (shadow) {
      const floor = ctx.createRadialGradient(w / 2, h - 5, 0, w / 2, h - 5, w * 0.48);
      floor.addColorStop(0, "rgba(0, 0, 0, .45)");
      floor.addColorStop(1, "rgba(0, 0, 0, 0)");
      ctx.fillStyle = floor;
      ctx.beginPath();
      ctx.ellipse(w / 2, h - 5, w * 0.48, h * 0.05, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // glass body
    jarPath();
    ctx.fillStyle = "rgba(255, 255, 255, .10)";
    ctx.fill();

    ctx.save();
    jarPath();
    ctx.clip();
    if (hold > t) shown += (1 - shown) * 0.2;
    else shown += (level - shown) * 0.06;
    const surface = pile(Math.max(0, Math.min(1, shown)));
    // coins on their way in, landing on the pile
    falling = falling.filter((c) => {
      c.vy += 0.5;
      c.y += c.vy;
      coin(c.x, c.y, w * 0.095, c.spin);
      c.spin += 0.15;
      return c.y < surface;
    });
    ctx.restore();

    // glass shine and outline over the coins
    jarPath();
    ctx.strokeStyle = "rgba(255, 255, 255, .7)";
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(w * 0.17, h * 0.36);
    ctx.lineTo(w * 0.17, h * 0.78);
    ctx.strokeStyle = "rgba(255, 255, 255, .35)";
    ctx.lineWidth = w * 0.035;
    ctx.lineCap = "round";
    ctx.stroke();
    // the lid
    ctx.beginPath();
    ctx.roundRect(w * 0.19, h * 0.025, w * 0.62, h * 0.085, h * 0.025);
    const lid = ctx.createLinearGradient(0, h * 0.025, 0, h * 0.11);
    lid.addColorStop(0, "#ffd66b");
    lid.addColorStop(1, "#c97a12");
    ctx.fillStyle = lid;
    ctx.fill();
    ctx.restore();

    // coins thrown out when it fills
    spill = spill.filter((c) => {
      c.vy += 0.35;
      c.x += c.vx;
      c.y += c.vy;
      coin(c.x, c.y, w * 0.08, (c.spin += 0.2));
      return c.y < h + 30;
    });

    if (falling.length || spill.length || Math.abs(level - shown) > 0.002 || shaking || glow > 0.01 || hold > t) raf = requestAnimationFrame(draw);
  }

  const kick = () => {
    if (!raf) raf = requestAnimationFrame(draw);
  };

  function drop(n) {
    for (let i = 0; i < n; i++) {
      seq++;
      falling.push({
        x: w * (0.38 + hash(seq, 1) * 0.24),
        y: -h * 0.05 - i * h * 0.1,
        vy: hash(seq, 2) * 2,
        spin: hash(seq, 3) * 3,
      });
    }
  }

  return {
    /** The bank being filled now. A rise drops a few coins in through the neck. */
    set({ name, have: next, goal: g }) {
      const before = have;
      const same = nameEl.textContent === name && goal === g;
      goal = Math.max(1, g);
      have = next;
      level = have / goal;
      nameEl.textContent = name;
      countEl.textContent = `${have} / ${goal}`;
      if (same && next > before) drop(Math.min(6, 1 + Math.ceil(((next - before) / goal) * 12)));
      if (!same) shown = level;
      kick();
    },
    /** Full: it shakes, glows and spills over, then shows the next round. */
    filled() {
      const t = performance.now();
      shakeUntil = t + 900;
      hold = t + 1400;
      glow = 1;
      for (let i = 0; i < 14; i++) {
        seq++;
        spill.push({
          x: w / 2 + (hash(seq, 4) - 0.5) * w * 0.3,
          y: h * 0.12,
          vx: (hash(seq, 5) - 0.5) * 7,
          vy: -4 - hash(seq, 6) * 5,
          spin: 0,
        });
      }
      host.classList.remove("jar--full");
      void host.offsetWidth;
      host.classList.add("jar--full");
      kick();
    },
    resize() {
      size();
      kick();
    },
  };
}
