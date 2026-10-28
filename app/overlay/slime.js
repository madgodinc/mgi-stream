// A soft-body jelly: a ring of points held to a rest shape by springs
// (shape matching), pulled down by gravity and squashed on the floor. Hops,
// leans and tilts are forces on that ring, so every move wobbles for real.
// Drawn on a 2D canvas; the face rides the deformed body.
//
// Copied from MGI Assistant (src/features/avatar/slime.js) for the stream's
// music window, with three changes: it draws at any `scale`, its colours are
// set from outside (`colors`), and `inside(ctx, body)` paints into the jelly
// under the gloss, which is where the music player lives; the face moves up
// out of its way while it plays. It also always moves: this is a picture for
// the viewers, so the streamer's own reduced-motion setting does not apply.

const W = 300;
const H = 340;
const FLOOR = 314;
const N = 30;
const R = 88;
const STEP = 1 / 120;

const PALETTE = {
  idle: ["#ff6a3d", "#ff3d9a"],
  listening: ["#38e8ff", "#7dff6a"],
  thinking: ["#ffc23d", "#ff6a3d"],
  speaking: ["#ff3d9a", "#ffc23d"],
  confirm: ["#ffc23d", "#ff3d6e"],
};

// How each feeling looks. Numbers blend between feelings; shapes (eyes,
// mouth, props) crossfade by weight. brows = [raiseL, angleL, raiseR, angleR]:
// a positive angle drops the inner end (cross), a negative one lifts it (sad).
const MOODS = {
  neutral: {},
  happy: { eyes: "arc", mouth: "smile", brows: [4, -0.15, 4, -0.15], blush: 0.7, smile: 1, hopEvery: 2.4, hopPow: 120, sy: 1.03 },
  excited: { eyes: "star", wide: 0.3, mouth: "grin", brows: [9, -0.1, 9, -0.1], blush: 0.6, smile: 1, hopEvery: 0.8, hopPow: 175, sparkles: 1 },
  curious: { eyes: "normal", wide: 0.12, mouth: "o", brows: [-1, 0.15, 11, -0.2], tilt: 0.14, look: [0.5, -0.35], uneven: 0.2 },
  focused: { eyes: "normal", lid: 0.42, lidAngle: 0.28, mouth: "flat", brows: [-3, 0.4, -3, 0.4], still: 1, sy: 1.02, look: [0, 0.15] },
  surprised: { eyes: "round", wide: 0.35, mouth: "O", brows: [13, 0, 13, 0], jolt: 300, sx: 0.95, sy: 1.08, burst: 1 },
  confused: { eyes: "uneven", mouth: "wavy", brows: [8, -0.35, -3, 0.25], tilt: -0.17, question: 1 },
  sad: { eyes: "normal", lid: 0.32, lidAngle: -0.4, mouth: "frown", brows: [5, -0.5, 5, -0.5], smile: -1, sx: 1.12, sy: 0.84, tears: 1, look: [0, 0.55], still: 1 },
  worried: { eyes: "normal", wide: 0.08, mouth: "wobble", brows: [8, -0.55, 8, -0.55], smile: -0.4, sx: 0.9, sy: 0.92, tremble: 1, sweat: 1 },
  sheepish: { eyes: "normal", lid: 0.22, mouth: "lopsided", brows: [4, -0.3, 4, -0.3], blush: 1, smile: 0.4, tilt: 0.08, sx: 0.97, look: [-0.95, 0.35], sweat: 0.7 },
  sleepy: { eyes: "sleepy", mouth: "yawn", sx: 1.08, sy: 0.88, sway: 1, zzz: 1, look: [0, 0.4], still: 1 },
  pout: { eyes: "normal", lid: 0.5, lidAngle: 0.3, mouth: "pout", brows: [-2, 0.35, -2, 0.35], blush: 0.8, puff: 1, smile: -0.3, sx: 1.07, tilt: -0.07, look: [0.9, 0.05] },
  love: { eyes: "heart", mouth: "smile", blush: 1, smile: 1, wiggle: 1, hearts: 1 },
  proud: { eyes: "arc", mouth: "smirk", brows: [6, -0.1, 6, -0.1], blush: 0.3, smile: 0.8, sx: 0.94, sy: 1.12, faceY: -5, tilt: -0.05, sparkles: 0.8 },
  angry: { eyes: "normal", lid: 0.3, lidAngle: 0.45, mouth: "frown", brows: [-5, 0.5, -5, 0.5], smile: -0.6, sx: 1.04, sy: 0.94, still: 1 },
  bored: { eyes: "normal", lid: 0.32, mouth: "flat", brows: [-2, 0.1, -2, 0.1], sway: 0.5, still: 1, look: [0.6, 0.15] },
  determined: { eyes: "normal", lid: 0.1, mouth: "flat", brows: [-4, 0.45, -4, 0.45], tilt: -0.04, still: 1, hopEvery: 1.8, hopPow: 130 },
  amazed: { eyes: "star", wide: 0.3, mouth: "O", brows: [10, -0.1, 10, -0.1], sparkles: 1, sy: 1.05 },
  laughing: { eyes: "arc", mouth: "grin", brows: [5, -0.1, 5, -0.1], blush: 0.4, smile: 1, wiggle: 1, hopEvery: 0.5, hopPow: 90 },
  sneaky: { eyes: "wink", mouth: "smirk", brows: [-1, 0.1, 6, -0.25], tilt: 0.1, look: [0.6, 0.05] },
  grateful: { eyes: "arc", mouth: "smile", brows: [3, -0.1, 3, -0.1], blush: 0.5, smile: 0.8, tilt: 0.08, faceY: 3, sy: 0.97 },
  scared: { eyes: "round", mouth: "wavy", brows: [11, -0.05, 11, -0.05], sx: 0.88, sy: 0.96, tremble: 1, sweat: 0.8, jolt: 150, look: [0, -0.2] },
};
const NAMES = Object.keys(MOODS);
const BLEND = { wide: 0, sx: 1, sy: 1, tilt: 0, still: 0, tremble: 0, sway: 0, wiggle: 0, faceY: 0 };

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const rgba = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const WHITE = [255, 255, 255];
const INK = [26, 12, 30];

// The rest silhouette: a drop with a soft tip on top and a flatter base.
function restShape() {
  const out = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2 - Math.PI / 2;
    const s = Math.sin(a);
    const c = Math.cos(a);
    let x = c * R * 1.06;
    let y = s * R * (s > 0 ? 0.9 : 1);
    x *= 1 - 0.1 * Math.max(0, -s);
    y -= Math.pow(Math.max(0, -s), 14) * 22;
    out.push([x, y]);
  }
  // centred on its own mean, or the springs would push the whole body
  const mx = out.reduce((s, p) => s + p[0], 0) / N;
  const my = out.reduce((s, p) => s + p[1], 0) / N;
  return out.map(([x, y]) => [x - mx, y - my]);
}

export function createSlime(host, { scale = 1, colors = PALETTE.idle, inside = null } = {}) {
  const reduce = false;
  const canvas = document.createElement("canvas");
  canvas.className = "av-slime";
  canvas.style.cssText = `width:${W * scale}px;height:${H * scale}px;display:block`;
  host.innerHTML = "";
  host.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  let dpr = 0;

  const rest = restShape();
  // {x,y} form of the same shape, centred on the canvas: smoothPath wants
  // objects with .x/.y, but rest[i] is a plain [x,y] pair (used elsewhere
  // as rest[i][0]/[1] for the per-point spring targets)
  const restPts = rest.map(([x, y]) => ({ x, y }));
  const restBottom = Math.max(...rest.map((p) => p[1]));
  const cx0 = W / 2;
  const cy0 = FLOOR - restBottom - 4;
  const pts = rest.map(([x, y]) => ({ x: cx0 + x, y: cy0 + y - 30, vx: 0, vy: 0 }));

  let phase = "idle";
  let env = null;
  let envStart = 0;
  let envMs = 40;
  let mouth = 0;
  let level = 0;
  let pulse = 0;
  let tilt = 0;
  let own = colors;
  let c1 = hex(own[0]);
  let c2 = hex(own[1]);
  // how far the face has moved up for the player, eased toward liftTarget
  let lift = 0;
  let liftTarget = 0;
  let look = [0, 0];
  let lookTarget = [0, 0];
  let nextLook = 0;
  let blink = 0;
  let nextBlink = 1500;
  let nextHop = 2500;
  let wide = 0;
  let squint = 0;
  let brow = 0;
  let think = 0;
  let mood = "neutral";
  let nextMoodHop = 0;
  // the rest-shape affine transform simulate() just aimed the points at,
  // reused by draw() to place the pre-rendered glow/rim sprites (see below)
  let bodyAngle = 0;
  let bodySx = 1;
  let bodySy = 1;
  // weight of each feeling, faded towards the current one
  const w = Object.fromEntries(NAMES.map((n) => [n, n === "neutral" ? 1 : 0]));
  // the mood table's numbers, blended by those weights every frame
  const B = { ...BLEND };
  let raf = 0;
  let last = performance.now();
  let acc = 0;
  let t = 0;
  const bubbles = Array.from({ length: 4 }, (_, i) => ({ x: -30 + i * 22, y: 40 - i * 30, r: 2 + (i % 3) * 1.5, s: 10 + i * 3 }));

  const hop = (power) => {
    if (reduce) return;
    for (const p of pts) p.vy -= power;
  };

  // thinking sways, sleepy rocks slowly, love wiggles
  function bodySway() {
    if (reduce) return 0;
    return (phase === "thinking" ? Math.sin(t * 1.3) * 0.07 : 0) + B.sway * Math.sin(t * 0.9) * 0.07 + B.wiggle * Math.sin(t * 7) * 0.08;
  }

  function simulate(dt) {
    t += dt;
    let cx = 0;
    let cy = 0;
    for (const p of pts) {
      cx += p.x;
      cy += p.y;
    }
    cx /= N;
    cy /= N;

    // keep it near the middle of the canvas
    const home = (cx0 - cx) * 2;
    const breathe = reduce ? 0 : Math.sin(t * 1.7) * 0.025;
    const angle = tilt + bodySway();
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);
    const sx = (1 + breathe * 0.4 + pulse * 0.08 - mouth * 0.03) * B.sx;
    const sy = (1 - breathe + pulse * 0.06 + mouth * 0.07) * B.sy;
    bodyAngle = angle;
    bodySx = sx;
    bodySy = sy;
    const k = 175;
    const damp = 5;
    const g = 520;

    for (let i = 0; i < N; i++) {
      const p = pts[i];
      const rx = rest[i][0] * sx;
      const ry = rest[i][1] * sy;
      const tx = cx + rx * ca - ry * sa;
      const ty = cy + rx * sa + ry * ca;
      const a = pts[(i + N - 1) % N];
      const b = pts[(i + 1) % N];
      const lx = (a.x + b.x) / 2 - p.x;
      const ly = (a.y + b.y) / 2 - p.y;
      p.vx += (k * (tx - p.x) + 55 * lx - damp * p.vx + home) * dt;
      p.vy += (k * (ty - p.y) + 55 * ly - damp * p.vy + g) * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.y > FLOOR) {
        p.y = FLOOR;
        if (p.vy > 0) p.vy *= -0.15;
        p.vx *= 0.86;
      }
    }
  }

  function smoothPath(list, g = ctx) {
    const n = list.length;
    const m = (a, b) => [(a.x + b.x) / 2, (a.y + b.y) / 2];
    const s = m(list[n - 1], list[0]);
    g.beginPath();
    g.moveTo(s[0], s[1]);
    for (let i = 0; i < n; i++) {
      const p = list[i];
      const q = m(p, list[(i + 1) % n]);
      g.quadraticCurveTo(p.x, p.y, q[0], q[1]);
    }
    g.closePath();
  }

  // The outer glow (shadowBlur) and the inner rim (ctx.filter blur) used to
  // be redrawn and reblurred every frame on the live, wobbling point ring -
  // real per-frame cost, paid again for each OBS/desktop copy of the
  // character running at once. Blur already hides the few pixels of spring
  // wobble, so both are instead rendered once onto an offscreen sprite from
  // the undeformed rest shape, cached by colour and blur amount, and then
  // just placed each frame with the same rotate+scale the live points are
  // springing towards (bodyAngle/bodySx/bodySy from simulate()).
  let glowSprite = null;
  let glowKey = "";
  let rimSprite = null;
  let rimKey = "";

  function buildSprite(blurPx, paint) {
    const want = Math.min(window.devicePixelRatio || 1, 2) * scale;
    const pad = blurPx * 2.5 + 20;
    const size = Math.ceil(R * 2.4 + pad * 2);
    const off = document.createElement("canvas");
    off.width = Math.ceil(size * want);
    off.height = Math.ceil(size * want);
    const o = off.getContext("2d");
    o.setTransform(want, 0, 0, want, 0, 0);
    o.translate(size / 2, size / 2);
    paint(o);
    return { canvas: off, size };
  }

  function drawSprite(sprite, px, py) {
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(bodyAngle);
    ctx.scale(bodySx, bodySy);
    ctx.drawImage(sprite.canvas, -sprite.size / 2, -sprite.size / 2, sprite.size, sprite.size);
    ctx.restore();
  }

  function draw() {
    const want = Math.min(window.devicePixelRatio || 1, 2);
    if (want !== dpr) {
      dpr = want;
      canvas.width = W * dpr * scale;
      canvas.height = H * dpr * scale;
    }
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
    ctx.clearRect(0, 0, W, H);
    // worry makes the whole jelly shiver
    if (B.tremble > 0.01 && !reduce) ctx.translate(Math.sin(t * 61) * 1.8 * B.tremble, Math.cos(t * 47) * 0.6 * B.tremble);

    let cx = 0;
    let cy = 0;
    let minX = 1e9;
    let maxX = -1e9;
    let minY = 1e9;
    let maxY = -1e9;
    for (const p of pts) {
      cx += p.x;
      cy += p.y;
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    cx /= N;
    cy /= N;
    const bw = (maxX - minX) / 2;
    const bh = (maxY - minY) / 2;
    const fsx = bw / (R * 1.0);
    const fsy = bh / (R * 1.0);

    const light = mix(c1, WHITE, 0.55);
    const deep = mix(c2, INK, 0.45);

    // no floor shadow (13.10, Mad: characters stand on nothing)
    // outer glow: pre-rendered sprite from the rest shape (see buildSprite),
    // rebuilt only when its colour or the voice-level blur bucket changes
    const lvl = Math.round(level * 10) / 10;
    const glowBlur = 34 + lvl * 30;
    const gk = `${c2.map((v) => Math.round(v)).join(",")}|${glowBlur}|${dpr}`;
    if (gk !== glowKey) {
      glowKey = gk;
      glowSprite = buildSprite(glowBlur, (o) => {
        o.shadowColor = rgba(c2, 0.55 + lvl * 0.3);
        o.shadowBlur = glowBlur;
        smoothPath(restPts, o);
        o.fillStyle = rgba(c2);
        o.fill();
      });
    }
    drawSprite(glowSprite, cx, cy);

    // body
    smoothPath(pts);
    let gr = ctx.createRadialGradient(cx - bw * 0.35, cy - bh * 0.45, bw * 0.05, cx, cy + bh * 0.1, Math.max(bw, bh) * 1.25);
    gr.addColorStop(0, rgba(light));
    gr.addColorStop(0.35, rgba(c1));
    gr.addColorStop(0.78, rgba(c2));
    gr.addColorStop(1, rgba(deep));
    ctx.fillStyle = gr;
    ctx.fill();

    ctx.save();
    smoothPath(pts);
    ctx.clip();

    // subsurface: light gathering at the bottom of the jelly
    gr = ctx.createRadialGradient(cx + bw * 0.1, maxY + bh * 0.1, 0, cx, maxY, bw * 1.1);
    gr.addColorStop(0, rgba(mix(c1, WHITE, 0.35), 0.75));
    gr.addColorStop(0.5, rgba(c1, 0.25));
    gr.addColorStop(1, rgba(c1, 0));
    ctx.fillStyle = gr;
    ctx.fillRect(0, 0, W, H);

    // darker refracted rim: same sprite trick, clipped by the live body
    // path already in effect above
    const rk = `${deep.map((v) => Math.round(v)).join(",")}|${dpr}`;
    if (rk !== rimKey) {
      rimKey = rk;
      rimSprite = buildSprite(7, (o) => {
        o.filter = "blur(7px)";
        smoothPath(restPts, o);
        o.lineWidth = 20;
        o.strokeStyle = rgba(deep, 0.55);
        o.stroke();
        o.filter = "none";
      });
    }
    drawSprite(rimSprite, cx, cy);

    // bubbles drifting up inside
    for (const b of bubbles) {
      const by = cy + bh * 0.55 - ((b.y + t * b.s) % (bh * 1.3));
      const bx = cx + b.x * fsx + Math.sin(t * 1.5 + b.s) * 3;
      ctx.beginPath();
      ctx.arc(bx, by, b.r, 0, Math.PI * 2);
      ctx.fillStyle = rgba(WHITE, 0.16);
      ctx.fill();
      ctx.lineWidth = 0.8;
      ctx.strokeStyle = rgba(WHITE, 0.35);
      ctx.stroke();
    }

    // whatever lives inside the jelly (the player), under the gloss
    if (inside) {
      ctx.save();
      inside(ctx, { cx, cy, bw, bh, minY, maxY, t });
      ctx.restore();
    }

    // big soft gloss
    ctx.save();
    ctx.translate(cx - bw * 0.38, cy - bh * 0.5);
    ctx.rotate(-0.55);
    gr = ctx.createRadialGradient(0, 0, 0, 0, 0, bw * 0.42);
    gr.addColorStop(0, rgba(WHITE, 0.6));
    gr.addColorStop(1, rgba(WHITE, 0));
    ctx.fillStyle = gr;
    ctx.scale(1, 0.55);
    ctx.beginPath();
    ctx.arc(0, 0, bw * 0.42, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.restore();

    // sharp specular streak and dot
    ctx.save();
    ctx.lineCap = "round";
    ctx.strokeStyle = rgba(WHITE, 0.85);
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.ellipse(cx, cy, bw * 0.78, bh * 0.78, 0, Math.PI * 1.13, Math.PI * 1.32);
    ctx.stroke();
    ctx.fillStyle = rgba(WHITE, 0.9);
    const da = Math.PI * 1.4;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(da) * bw * 0.78, cy + Math.sin(da) * bh * 0.78, 3, 0, Math.PI * 2);
    ctx.fill();
    // rim light on the lower right
    ctx.strokeStyle = rgba(mix(c1, WHITE, 0.6), 0.55);
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.ellipse(cx, cy, bw * 0.9, bh * 0.88, 0, Math.PI * 0.08, Math.PI * 0.38);
    ctx.stroke();
    ctx.restore();

    // face, in the body's own frame: one layer per feeling, crossfaded
    ctx.save();
    ctx.translate(cx, cy + bh * 0.08 + B.faceY - lift * bh * 0.5);
    if (lift > 0.01) ctx.scale(1 - lift * 0.22, 1 - lift * 0.22);
    ctx.rotate(tilt + bodySway());
    ctx.scale(fsx, fsy);
    for (const n of NAMES) {
      if (w[n] < 0.02) continue;
      ctx.save();
      ctx.globalAlpha = w[n];
      if (n === "neutral") drawFace();
      else drawMoodFace(MOODS[n]);
      ctx.restore();
    }
    ctx.restore();

    // thought dots above the head
    if (think > 0.01) {
      ctx.save();
      ctx.globalAlpha = think;
      for (let i = 0; i < 3; i++) {
        const ph = (t * 0.9 + i / 3) % 1;
        const x = cx + 34 + i * 16 + Math.sin(t * 2 + i) * 2;
        const y = minY + 4 - i * 14 - ph * 6;
        const r = 3 + i * 2.2;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = rgba(mix(c1, WHITE, 0.5), 0.35 + 0.5 * Math.sin(ph * Math.PI));
        ctx.fill();
      }
      ctx.restore();
    }

    drawProps(cx, minY, bw, bh);
  }

  function eye(x, y, side, o = {}) {
    const sc = 1 + (o.wide ?? wide) * 0.18;
    const rx = 12.5 * sc;
    const ry = 17 * sc;
    const shut = Math.max(blink, o.shut ?? (side < 0 ? squint : 0));
    const lk = o.look ?? look;
    const lx = lk[0] * 6;
    const ly = lk[1] * 6;
    ctx.save();
    ctx.translate(x + lx * 0.6, y + ly * 0.6);
    if (shut > 0.8) {
      ctx.lineCap = "round";
      ctx.strokeStyle = rgba(INK);
      ctx.lineWidth = 3.5;
      ctx.beginPath();
      ctx.arc(0, -2, rx * 0.85, Math.PI * 0.15, Math.PI * 0.85);
      ctx.stroke();
      ctx.restore();
      return;
    }
    ctx.scale(1, 1 - shut * 0.85);
    // an eyelid: only the part of the eye below a tilted line shows
    const lid = o.lid || 0;
    const lidRot = (o.lidAngle || 0) * -side;
    if (lid > 0.01) {
      ctx.rotate(lidRot);
      ctx.beginPath();
      ctx.rect(-rx * 2, -ry + lid * ry * 2, rx * 4, ry * 3);
      ctx.rotate(-lidRot);
      ctx.clip();
    }
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = rgba(INK);
    ctx.fill();
    // iris glow at the bottom of the eye
    const gr = ctx.createRadialGradient(lx * 0.4, ry * 0.45 + ly * 0.4, 0, 0, ry * 0.4, ry * 0.9);
    gr.addColorStop(0, rgba(mix(c2, WHITE, 0.2), 0.85));
    gr.addColorStop(1, rgba(c2, 0));
    ctx.save();
    ctx.clip();
    ctx.fillStyle = gr;
    ctx.fillRect(-rx, -ry, rx * 2, ry * 2);
    ctx.restore();
    ctx.fillStyle = "#fff";
    if (o.star) {
      star(rx * 0.2 + lx * 0.4, -ry * 0.25 + ly * 0.4, rx * 0.7, t * 2);
      star(-rx * 0.38 + lx * 0.4, ry * 0.38 + ly * 0.4, rx * 0.32, -t * 2);
    } else {
      ctx.beginPath();
      ctx.ellipse(rx * 0.32 + lx * 0.4, -ry * 0.38 + ly * 0.4, rx * 0.36, ry * 0.3, -0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(-rx * 0.35 + lx * 0.4, ry * 0.3 + ly * 0.4, rx * 0.15, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    if (lid > 0.01) {
      // the lid edge itself
      ctx.save();
      ctx.translate(x + lx * 0.6, y + ly * 0.6);
      ctx.scale(1, 1 - shut * 0.85);
      ctx.rotate(lidRot);
      ctx.strokeStyle = rgba(INK);
      ctx.lineCap = "round";
      ctx.lineWidth = 4;
      const edge = -ry + lid * ry * 2;
      const half = rx * Math.sqrt(Math.max(0, 1 - (edge / ry) ** 2)) + 3;
      ctx.beginPath();
      ctx.moveTo(-half, edge);
      ctx.lineTo(half, edge);
      ctx.stroke();
      ctx.restore();
    }
  }

  // a four-point twinkle
  function star(x, y, r, rot = 0) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot * 0.15);
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const rr = i % 2 ? r * 0.28 : r;
      ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function heart(x, y, r) {
    ctx.beginPath();
    ctx.moveTo(x, y + r * 0.9);
    ctx.bezierCurveTo(x - r * 1.5, y - r * 0.1, x - r * 0.75, y - r * 1.25, x, y - r * 0.45);
    ctx.bezierCurveTo(x + r * 0.75, y - r * 1.25, x + r * 1.5, y - r * 0.1, x, y + r * 0.9);
    ctx.fill();
  }

  const ink = (lw = 3.5) => {
    ctx.strokeStyle = rgba(INK);
    ctx.lineWidth = lw;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
  };

  function cheeks(blush, puff) {
    for (const s of [-1, 1]) {
      const r = 15 + puff * 7;
      const gr = ctx.createRadialGradient(s * 44, 12, 0, s * 44, 12, r);
      gr.addColorStop(0, `rgba(255,90,140,${0.55 + blush * 0.4})`);
      gr.addColorStop(1, "rgba(255,90,140,0)");
      ctx.fillStyle = gr;
      ctx.beginPath();
      ctx.ellipse(s * 44, 12, r, 9 + puff * 6, 0, 0, Math.PI * 2);
      ctx.fill();
      if (blush > 0.75) {
        // anime blush hatching
        ctx.strokeStyle = "rgba(190,30,85,.6)";
        ctx.lineWidth = 2;
        ctx.lineCap = "round";
        for (let i = -1; i <= 1; i++) {
          ctx.beginPath();
          ctx.moveTo(s * 44 + i * 6 - 2, 16);
          ctx.lineTo(s * 44 + i * 6 + 2, 9);
          ctx.stroke();
        }
      }
    }
  }

  function drawFace() {
    const ey = -14;
    const ex = 26;
    cheeks(0, 0);
    eye(-ex, ey, -1);
    eye(ex, ey, 1);

    // a raised brow over the right eye when asking
    if (brow > 0.02) {
      ctx.save();
      ctx.globalAlpha *= brow;
      ink(4);
      ctx.beginPath();
      ctx.moveTo(ex - 13, ey - 26 - brow * 6);
      ctx.quadraticCurveTo(ex, ey - 36 - brow * 8, ex + 13, ey - 28 - brow * 4);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-ex - 12, ey - 22);
      ctx.lineTo(-ex + 12, ey - 20);
      ctx.stroke();
      ctx.restore();
    }

    // mouth
    const my = 18;
    ctx.save();
    ink();
    if (mouth > 0.06) {
      openMouth(9 + mouth * 5, 3 + mouth * 15, 0, my);
    } else if (phase === "confirm") {
      ctx.beginPath();
      ctx.moveTo(-9, my + 3);
      ctx.quadraticCurveTo(-4, my - 1, 0, my + 3);
      ctx.quadraticCurveTo(4, my + 7, 9, my + 2);
      ctx.stroke();
    } else if (phase === "thinking") {
      ctx.beginPath();
      ctx.moveTo(-3, my + 3);
      ctx.lineTo(9, my + 1);
      ctx.stroke();
    } else if (phase === "listening") {
      ctx.beginPath();
      ctx.ellipse(0, my + 3, 4.5, 5.5 + level * 3, 0, 0, Math.PI * 2);
      ctx.fillStyle = rgba(INK);
      ctx.fill();
    } else {
      // a small cat smile
      ctx.beginPath();
      ctx.moveTo(-10, my);
      ctx.quadraticCurveTo(-5, my + 7, 0, my + 1);
      ctx.quadraticCurveTo(5, my + 7, 10, my);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawMoodFace(m) {
    const ey = -14;
    const ex = 26;
    const my = 18;
    cheeks(m.blush || 0, m.puff || 0);

    const eyeLook = m.look ? mix(look, m.look, 0.75) : look;
    const kind = m.eyes || "normal";
    for (const s of [-1, 1]) {
      const x = s * ex;
      if (kind === "arc") {
        // ^ ^ closed happy eyes
        ink(5);
        ctx.beginPath();
        ctx.arc(x, ey + 8, 12, Math.PI * 1.15, Math.PI * 1.85);
        ctx.stroke();
      } else if (kind === "heart") {
        const beat = 1 + (reduce ? 0 : Math.max(0, Math.sin(t * 6)) * 0.15);
        ctx.fillStyle = "#ff2d6f";
        heart(x, ey, 16 * beat);
        ctx.fillStyle = "rgba(255,255,255,.85)";
        ctx.beginPath();
        ctx.ellipse(x - 7 * beat, ey - 6 * beat, 3.4, 2.2, -0.6, 0, Math.PI * 2);
        ctx.fill();
      } else if (kind === "sleepy") {
        // heavy lids that sag shut and lift again
        const droop = reduce ? 0.7 : 0.6 + Math.max(0, Math.sin(t * 0.9)) * 0.4;
        if (droop > 0.92) {
          ink(4);
          ctx.beginPath();
          ctx.moveTo(x - 11, ey + 4);
          ctx.quadraticCurveTo(x, ey + 9, x + 11, ey + 4);
          ctx.stroke();
        } else eye(x, ey, s, { lid: droop, look: eyeLook, shut: 0, wide: 0 });
      } else if (kind === "round") {
        // shocked: whites showing, tiny pupils
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.ellipse(x, ey, 15, 18, 0, 0, Math.PI * 2);
        ctx.fill();
        ink(3.5);
        ctx.stroke();
        ctx.fillStyle = rgba(INK);
        ctx.beginPath();
        ctx.arc(x, ey + 1, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.arc(x + 1.8, ey - 1, 1.6, 0, Math.PI * 2);
        ctx.fill();
      } else if (kind === "wink") {
        // one eye squeezed shut, the other a normal, slightly sly look
        if (s < 0) {
          ink(4.5);
          ctx.beginPath();
          ctx.moveTo(x - 9, ey - 8);
          ctx.lineTo(x + 7, ey);
          ctx.lineTo(x - 9, ey + 8);
          ctx.stroke();
        } else {
          eye(x, ey, s, { wide: m.wide || 0, lid: 0, lidAngle: 0, look: eyeLook, shut: 0 });
        }
      } else if (kind === "uneven") {
        if (s < 0) {
          // squeezed shut like ">"
          ink(4.5);
          ctx.beginPath();
          ctx.moveTo(x - 9, ey - 8);
          ctx.lineTo(x + 7, ey);
          ctx.lineTo(x - 9, ey + 8);
          ctx.stroke();
        } else {
          ctx.save();
          ctx.translate(x, ey);
          ctx.fillStyle = rgba(INK);
          ctx.beginPath();
          ctx.ellipse(0, 0, 14, 19, 0, 0, Math.PI * 2);
          ctx.fill();
          // a little spiral of confusion
          ctx.strokeStyle = "rgba(255,255,255,.9)";
          ctx.lineWidth = 2;
          ctx.beginPath();
          for (let a = 0; a < Math.PI * 5; a += 0.2) {
            const r = 1 + a * 0.72;
            const aa = a + (reduce ? 0 : t * 3);
            ctx.lineTo(Math.cos(aa) * r, Math.sin(aa) * r * 1.2);
          }
          ctx.stroke();
          ctx.restore();
        }
      } else {
        eye(x, ey, s, {
          wide: (m.wide || 0) + wide * 0.5 + (m.uneven && s > 0 ? m.uneven : 0),
          lid: m.lid || 0,
          lidAngle: m.lidAngle || 0,
          look: eyeLook,
          star: kind === "star",
          shut: 0,
        });
      }
    }

    // brows
    if (m.brows) {
      ink(4);
      for (const s of [-1, 1]) {
        const raise = s < 0 ? m.brows[0] : m.brows[2];
        const ang = s < 0 ? m.brows[1] : m.brows[3];
        ctx.save();
        ctx.translate(s * ex, ey - 27 - raise);
        ctx.rotate(ang * -s);
        ctx.beginPath();
        ctx.moveTo(-11, 2);
        ctx.quadraticCurveTo(0, -3, 11, 2);
        ctx.stroke();
        ctx.restore();
      }
    }

    // sweat drop on the temple
    if (m.sweat) {
      const sy = ey - 30 + (reduce ? 0 : (t * 12) % 10);
      ctx.save();
      ctx.globalAlpha *= m.sweat;
      ctx.fillStyle = "rgba(170,225,255,.95)";
      ctx.beginPath();
      ctx.moveTo(58, sy - 13);
      ctx.quadraticCurveTo(67, sy, 58, sy + 5);
      ctx.quadraticCurveTo(49, sy, 58, sy - 13);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(56, sy - 1, 1.7, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // tears welling up and running down
    if (m.tears) {
      for (const s of [-1, 1]) {
        ctx.fillStyle = "rgba(150,215,255,.9)";
        ctx.beginPath();
        ctx.ellipse(s * (ex + 5), ey + 12, 4.5, 5.5, 0, 0, Math.PI * 2);
        ctx.fill();
        const k2 = reduce ? 0.4 : (t * 0.8 + (s > 0 ? 0.5 : 0)) % 1;
        ctx.beginPath();
        ctx.ellipse(s * (ex + 7), ey + 18 + k2 * 34, 3.6, 5, 0, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(150,215,255,${0.95 * (1 - k2)})`;
        ctx.fill();
      }
    }

    // mouth: when talking it opens with the voice and keeps the mood's corners
    ctx.save();
    ink();
    if (mouth > 0.06) openMouth(9 + mouth * 6, 3 + mouth * 15, m.smile || 0, my);
    else moodMouth(m.mouth, my);
    ctx.restore();
  }

  // an open mouth whose corners rise with smile > 0 and drop with smile < 0
  function openMouth(w2, h, smile, my) {
    const lift = smile * 5;
    ctx.beginPath();
    ctx.moveTo(-w2, my - lift);
    ctx.quadraticCurveTo(0, my + (smile < 0 ? -5 : lift * 0.3), w2, my - lift);
    ctx.quadraticCurveTo(w2 * 0.95, my + h * 1.5, 0, my + h * 1.5);
    ctx.quadraticCurveTo(-w2 * 0.95, my + h * 1.5, -w2, my - lift);
    ctx.closePath();
    ctx.fillStyle = rgba(mix(INK, c2, 0.15));
    ctx.fill();
    ctx.save();
    ctx.clip();
    ctx.beginPath();
    ctx.ellipse(0, my + h * 1.6, w2 * 0.75, h * 0.7, 0, 0, Math.PI * 2);
    ctx.fillStyle = "#ff6f9a";
    ctx.fill();
    ctx.restore();
  }

  function moodMouth(kind, my) {
    ctx.beginPath();
    switch (kind) {
      case "smile":
        ctx.moveTo(-13, my - 2);
        ctx.quadraticCurveTo(0, my + 14, 13, my - 2);
        ctx.stroke();
        break;
      case "grin":
        openMouth(15, 8, 1, my - 2);
        break;
      case "o":
        ctx.ellipse(6, my + 3, 4.5, 5, 0, 0, Math.PI * 2);
        ctx.fillStyle = rgba(INK);
        ctx.fill();
        break;
      case "flat":
        ctx.moveTo(-8, my + 3);
        ctx.lineTo(8, my + 3);
        ctx.stroke();
        break;
      case "O":
        ctx.ellipse(0, my + 6, 8, 10, 0, 0, Math.PI * 2);
        ctx.fillStyle = rgba(mix(INK, c2, 0.15));
        ctx.fill();
        break;
      case "wavy":
        ctx.moveTo(-12, my + 3);
        for (let x = -12; x <= 12; x += 2) ctx.lineTo(x, my + 3 + Math.sin(x * 0.55 + (reduce ? 0 : t * 4)) * 2.5);
        ctx.stroke();
        break;
      case "frown":
        ctx.moveTo(-11, my + 9);
        ctx.quadraticCurveTo(0, my - 3, 11, my + 9);
        ctx.stroke();
        break;
      case "wobble":
        ctx.moveTo(-11, my + 4);
        for (let i = 1; i <= 6; i++) ctx.lineTo(-11 + i * 3.67, my + 4 + (i % 2 ? -2.5 : 2.5));
        ctx.stroke();
        break;
      case "lopsided":
        ctx.moveTo(-10, my + 4);
        ctx.quadraticCurveTo(2, my + 9, 12, my - 1);
        ctx.stroke();
        break;
      case "yawn": {
        const y = reduce ? 0 : Math.max(0, Math.sin(t * 0.9 - 1.2));
        if (y > 0.25) {
          ctx.ellipse(0, my + 5, 6 + y * 3, 4 + y * 9, 0, 0, Math.PI * 2);
          ctx.fillStyle = rgba(mix(INK, c2, 0.15));
          ctx.fill();
        } else {
          ctx.moveTo(-5, my + 3);
          ctx.quadraticCurveTo(0, my + 6, 5, my + 3);
          ctx.stroke();
        }
        break;
      }
      case "pout":
        // a pursed little "3"
        ctx.moveTo(-3, my - 2);
        ctx.quadraticCurveTo(5, my, -1, my + 4);
        ctx.quadraticCurveTo(5, my + 8, -3, my + 10);
        ctx.stroke();
        break;
      case "smirk":
        ctx.moveTo(-10, my + 3);
        ctx.quadraticCurveTo(2, my + 9, 13, my - 3);
        ctx.stroke();
        break;
      default:
        ctx.moveTo(-10, my);
        ctx.quadraticCurveTo(-5, my + 7, 0, my + 1);
        ctx.quadraticCurveTo(5, my + 7, 10, my);
        ctx.stroke();
    }
  }

  // things floating around the body: sparkles, hearts, Zs, "?", shock marks
  function drawProps(cx, top, bw, bh) {
    const amount = (key) => NAMES.reduce((sum, n) => sum + w[n] * (MOODS[n][key] || 0), 0);
    const tt = reduce ? 0.3 : t;
    const light = mix(c1, WHITE, 0.65);
    ctx.save();
    let k = amount("sparkles");
    if (k > 0.02) {
      ctx.fillStyle = rgba(mix(light, WHITE, 0.6));
      ctx.shadowColor = rgba(c1, 0.9);
      ctx.shadowBlur = 10;
      const spots = [[-1.2, -0.55, 17], [1.22, -0.8, 14], [1.12, 0.3, 10], [-1.1, 0.45, 11], [0.4, -1.35, 12]];
      spots.forEach(([sx, sy, r], i) => {
        const tw = 0.5 + 0.5 * Math.sin(tt * 4 + i * 1.7);
        ctx.globalAlpha = k * (0.3 + tw * 0.7);
        star(cx + sx * bw, top + bh + sy * bh, r * (0.6 + tw * 0.5), tt * 3 + i);
      });
      ctx.shadowBlur = 0;
    }
    k = amount("hearts");
    if (k > 0.02) {
      ctx.fillStyle = "#ff3d7f";
      for (let i = 0; i < 4; i++) {
        const ph = (tt * 0.45 + i / 4) % 1;
        ctx.globalAlpha = k * Math.sin(ph * Math.PI);
        heart(cx + (i % 2 ? 1 : -1) * (bw * 0.8 + i * 5) + Math.sin(ph * 9 + i) * 6, top + 40 - ph * 70, 8 + (i % 3) * 2);
      }
    }
    k = amount("zzz");
    if (k > 0.02) {
      ctx.fillStyle = rgba(light);
      for (let i = 0; i < 3; i++) {
        const ph = (tt * 0.3 + i / 3) % 1;
        ctx.globalAlpha = k * Math.sin(ph * Math.PI);
        ctx.font = `800 ${14 + ph * 14}px Unbounded, Manrope, sans-serif`;
        ctx.fillText("Z", cx + bw * 0.45 + ph * 36, top + 16 - ph * 48);
      }
    }
    k = amount("question");
    if (k > 0.02) {
      ctx.globalAlpha = k;
      ctx.fillStyle = rgba(light);
      ctx.font = "800 36px Unbounded, Manrope, sans-serif";
      ctx.save();
      ctx.translate(cx + bw * 0.62, top + 8 + Math.sin(tt * 2.5) * 3);
      ctx.rotate(0.18 + Math.sin(tt * 1.7) * 0.08);
      ctx.fillText("?", 0, 0);
      ctx.restore();
    }
    k = amount("burst");
    if (k > 0.02) {
      ctx.globalAlpha = k;
      ctx.strokeStyle = rgba(light);
      ctx.lineWidth = 4;
      ctx.lineCap = "round";
      for (const [ang, len] of [[-2.3, 14], [-1.57, 18], [-0.84, 14]]) {
        const r0 = bh + 8;
        const ox = cx + Math.cos(ang) * bw * 1.05;
        const oy = top + bh + Math.sin(ang) * r0;
        ctx.beginPath();
        ctx.moveTo(ox, oy);
        ctx.lineTo(ox + Math.cos(ang) * len, oy + Math.sin(ang) * len);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  const frame = (now) => {
    const dtMs = Math.min(now - last, 50);
    last = now;

    let target = 0;
    if (env) {
      const i = Math.max(0, Math.floor((now - envStart) / envMs));
      if (i < env.length) target = env[i];
      else env = null;
    }
    const prevMouth = mouth;
    mouth += (target - mouth) * 0.45;
    // a syllable onset gives the jelly a little kick
    if (mouth - prevMouth > 0.12) hop(40 * mouth);

    // feelings fade into each other over about 0.4 s
    const km = 1 - Math.pow(0.0005, dtMs / 1000);
    for (const n of NAMES) w[n] += ((n === mood ? 1 : 0) - w[n]) * km;
    for (const key of Object.keys(B)) {
      B[key] = NAMES.reduce((sum, n) => sum + w[n] * (MOODS[n][key] ?? BLEND[key]), 0);
    }
    const md = MOODS[mood];
    if (md.hopEvery && !reduce) {
      nextMoodHop -= dtMs;
      if (nextMoodHop <= 0) {
        nextMoodHop = md.hopEvery * 1000 * (0.85 + Math.random() * 0.3);
        hop(md.hopPow);
      }
    }

    level *= 0.9;
    const k = 1 - Math.pow(0.004, dtMs / 1000);
    pulse += ((phase === "listening" ? 0.35 + level * 0.9 : 0) - pulse) * k;
    tilt += ((phase === "confirm" ? -0.17 : 0) * w.neutral + B.tilt - tilt) * k * 0.7;
    wide += ((phase === "listening" ? 1 : 0) - wide) * k;
    squint += ((phase === "confirm" ? 0.55 : 0) - squint) * k;
    brow += ((phase === "confirm" ? 1 : 0) - brow) * k;
    think += ((phase === "thinking" ? 1 : 0) - think) * k;
    const pal = own;
    c1 = mix(c1, hex(pal[0]), k * 0.6);
    c2 = mix(c2, hex(pal[1]), k * 0.6);
    lift += (liftTarget - lift) * k * 0.5;

    // where the eyes look
    nextLook -= dtMs;
    if (phase === "thinking") lookTarget = [0.7, -0.9];
    else if (phase === "listening") lookTarget = [0, 0.1];
    else if (phase === "confirm") lookTarget = [-0.3, -0.2];
    else if (nextLook <= 0) {
      nextLook = 1400 + Math.random() * 2600;
      lookTarget = Math.random() < 0.4 ? [0, 0] : [Math.random() * 2 - 1, Math.random() * 1.2 - 0.6];
    }
    look = mix(look, lookTarget, Math.min(1, dtMs / 90));

    if (!reduce) {
      nextBlink -= dtMs;
      if (nextBlink <= 0) {
        blink = Math.min(1, blink + dtMs / 50);
        if (blink >= 1) nextBlink = 2200 + Math.random() * 4200;
      } else blink = Math.max(0, blink - dtMs / 70);

      nextHop -= dtMs;
      if (nextHop <= 0) {
        nextHop = phase === "idle" ? 3500 + Math.random() * 4500 : 6000 + Math.random() * 3000;
        const restless = B.still < 0.5 && !md.hopEvery;
        if ((phase === "idle" || phase === "listening") && restless) hop(170 + Math.random() * 90);
      }
    }

    acc += dtMs / 1000;
    while (acc >= STEP) {
      simulate(STEP);
      acc -= STEP;
    }
    draw();
    raf = requestAnimationFrame(frame);
  };
  // settle on the floor before the first frame instead of dropping in
  for (let i = 0; i < 240; i++) simulate(STEP);
  draw();
  raf = requestAnimationFrame(frame);

  return {
    phase(p) {
      if (p === "listening" && phase !== "listening") hop(140);
      if (p === "confirm" && phase !== "confirm") hop(110);
      phase = p;
      if (p !== "speaking") env = null;
    },
    speak(values, ms) {
      env = values;
      envMs = ms;
      envStart = performance.now();
    },
    level(l) {
      level = Math.max(level, l);
    },
    emotion(e) {
      const next = e in MOODS ? e : "neutral";
      if (next === mood) return;
      mood = next;
      nextMoodHop = 250;
      if (MOODS[next].jolt) hop(MOODS[next].jolt);
    },
    // character_action "look_at_cursor": overrides the idle wander for a
    // few seconds, dx/dy -1..1.
    look(dx, dy) {
      lookTarget = [Math.max(-1, Math.min(1, dx)), Math.max(-1, Math.min(1, dy))];
      nextLook = 1800;
    },
    colors(pair) {
      own = pair;
    },
    // the player is up (true) or gone: the face makes room for it
    screen(on) {
      liftTarget = on ? 1 : 0;
    },
    hop(power = 200) {
      hop(power);
    },
    destroy() {
      cancelAnimationFrame(raf);
      canvas.remove();
    },
  };
}
