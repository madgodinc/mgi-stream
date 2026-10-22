// Draws the app icon from scratch so the repo carries no binary blobs it cannot
// rebuild: a raw RGBA canvas -> PNG -> ICO container. Run: node tools/make-icon.mjs
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A blue tile with a red T. Inside the T's stem a small T is cut out, and
// inside that one's stem sits a tiny red T again: T all the way down, for
// TikTok. Shapes live in 0..1 units and every size is drawn on its own, 4x4
// samples per pixel, so the 16 px tray icon stays crisp.

const RED = [255, 45, 75];
const LIP = [120, 10, 40];
const BLUE_A = [43, 92, 255];
const BLUE_B = [11, 29, 122];

const rect = (x0, y0, x1, y1) => (x, y) => x >= x0 && x < x1 && y >= y0 && y < y1;
const T = (cx, top, w, barH, stemW, bottom) => {
  const bar = rect(cx - w / 2, top, cx + w / 2, top + barH);
  const stem = rect(cx - stemW / 2, top + barH, cx + stemW / 2, bottom);
  return (x, y) => bar(x, y) || stem(x, y);
};

const big = T(0.5, 0.16, 0.72, 0.23, 0.28, 0.86);
const small = T(0.5, 0.45, 0.21, 0.055, 0.06, 0.8);
const tiny = T(0.5, 0.56, 0.05, 0.016, 0.014, 0.72);
const shadow = (x, y) => big(x - 0.025, y - 0.03);
// Corner cut, the bevel the UI puts on its tiles.
const inside = (x, y) => x + y >= 0.18 && 2 - x - y >= 0.18;

function colour(x, y) {
  if (!inside(x, y)) return null;
  const t = (x + y) / 2;
  const blue = BLUE_A.map((a, i) => a + (BLUE_B[i] - a) * t);
  if (tiny(x, y)) return RED;
  if (small(x, y)) return blue;
  if (big(x, y)) return RED;
  if (shadow(x, y)) return LIP;
  return blue;
}

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const N = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < N; sy++) {
        for (let sx = 0; sx < N; sx++) {
          const c = colour((x + (sx + 0.5) / N) / size, (y + (sy + 0.5) / N) / size);
          if (!c) continue;
          r += c[0]; g += c[1]; b += c[2]; a++;
        }
      }
      const o = (y * size + x) * 4;
      if (a) px.set([r / a, g / a, b / a, (a / (N * N)) * 255].map(Math.round), o);
    }
  }
  return px;
}

// ── PNG ───────────────────────────────────────────────────────────────────────

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function png(size) {
  const px = render(size);
  const scanlines = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    scanlines[y * (size * 4 + 1)] = 0; // filter: none
    px.copy(scanlines, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(scanlines, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── ICO ───────────────────────────────────────────────────────────────────────
// Every entry holds a PNG verbatim; a 256 px entry stores its width as 0.

const SIZES = [16, 20, 24, 32, 40, 48, 64, 256];
const images = SIZES.map(png);
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(SIZES.length, 4);

let offset = header.length + 16 * SIZES.length;
const entries = SIZES.map((size, i) => {
  const entry = Buffer.alloc(16);
  entry[0] = size % 256;
  entry[1] = size % 256;
  entry.writeUInt16LE(1, 4); // colour planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(images[i].length, 8);
  entry.writeUInt32LE(offset, 12);
  offset += images[i].length;
  return entry;
});

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "build");
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "icon.ico"), Buffer.concat([header, ...entries, ...images]));
fs.writeFileSync(path.join(out, "icon.png"), images.at(-1));
// The tray and the window take theirs from the app folder, which is what gets packed.
fs.writeFileSync(path.join(root, "app", "icon.png"), images.at(-1));
fs.writeFileSync(path.join(root, "app", "tray.png"), png(32));
console.log(`build/icon.ico (${SIZES.join(", ")} px), build/icon.png, app/icon.png, app/tray.png written`);
