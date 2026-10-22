// Copies the MGI themes (mgi-shared/js/themes: tokens, fonts, picker) into
// app/ui/themes. mgi-stream is not built against mgi-shared and its window
// may load only its own files, so it carries a copy. Run after a change
// there: node tools/sync-themes.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const from = process.env.MGI_SHARED ?? path.join(root, "..", "mgi-shared", "js", "themes");
const to = path.join(root, "app", "ui", "themes");
fs.rmSync(to, { recursive: true, force: true });
fs.cpSync(from, to, { recursive: true });
console.log(`themes copied from ${from}`);
