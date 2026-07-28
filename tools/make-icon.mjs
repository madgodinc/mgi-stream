// Draws the app icon from scratch so the repo carries no binary blobs it cannot
// rebuild: a raw RGBA canvas -> PNG -> ICO container. Run: node tools/make-icon.mjs
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 256;
const BG = [11, 10, 9, 255];
const HOT = [232, 163, 61, 255];
const INK = [244, 239, 230, 255];

const px = Buffer.alloc(SIZE * SIZE * 4);
const put = (x, y, c) => {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  px.set(c, (y * SIZE + x) * 4);
};

for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) put(x, y, BG);

// Corner cut, the same 9px-at-1x bevel the UI uses on its buttons.
const cut = 46;
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    if (x + y < cut || (SIZE - x) + (SIZE - y) < cut) put(x, y, [0, 0, 0, 0]);
  }
}

// Four bars: chat turning into speech, tallest in the middle.
const bars = [
  { h: 76, c: INK },
  { h: 132, c: HOT },
  { h: 176, c: HOT },
  { h: 104, c: INK },
];
const barW = 22;
const gap = 18;
const totalW = bars.length * barW + (bars.length - 1) * gap;
let x0 = Math.round((SIZE - totalW) / 2);
const baseY = 172;

for (const bar of bars) {
  for (let y = baseY - bar.h; y < baseY; y++) {
    for (let x = x0; x < x0 + barW; x++) put(x, y, bar.c);
  }
  x0 += barW + gap;
}

// Baseline rule under the bars.
for (let x = 42; x < SIZE - 42; x++) for (let y = baseY + 18; y < baseY + 21; y++) put(x, y, HOT);

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

const scanlines = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  scanlines[y * (SIZE * 4 + 1)] = 0; // filter: none
  px.copy(scanlines, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // truecolour with alpha

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(scanlines, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

// ── ICO ───────────────────────────────────────────────────────────────────────
// A 256x256 entry stores its width as 0 and may hold a PNG verbatim.

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(1, 4); // one image

const entry = Buffer.alloc(16);
entry[0] = 0;
entry[1] = 0;
entry.writeUInt16LE(1, 4); // colour planes
entry.writeUInt16LE(32, 6); // bits per pixel
entry.writeUInt32LE(png.length, 8);
entry.writeUInt32LE(header.length + entry.length, 12);

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "build");
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "icon.ico"), Buffer.concat([header, entry, png]));
fs.writeFileSync(path.join(out, "icon.png"), png);
console.log(`build/icon.ico and build/icon.png written (${png.length} bytes of image data)`);
