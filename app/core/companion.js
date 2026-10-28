// MGI Games is a separate app (a Tauri program that turns gift coins into game
// effects). When it is installed, this app starts it, once, and tells it which
// port the feed is on; it reads the room from ws://127.0.0.1:<port>/games.

import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";

// Tauri names the installed binary after the crate, not the product name.
const EXE = "mgi-games.exe";

/** Where the per-user installer puts it, newest layout first. */
export function gamesExe(env = process.env, exists = fs.existsSync) {
  const base = env.LOCALAPPDATA;
  if (!base) return null;
  const spots = [path.join(base, "MGI Games", EXE), path.join(base, "Programs", "MGI Games", EXE)];
  return spots.find((p) => exists(p)) ?? null;
}

/** True when a process of that image name is running for anyone on this machine. */
export function isRunning(image = EXE) {
  return new Promise((done) => {
    execFile("tasklist", ["/FI", `IMAGENAME eq ${image}`, "/FO", "CSV", "/NH"], { windowsHide: true, timeout: 5000 }, (err, out) => {
      // A tasklist that fails says nothing; starting a second copy is the lesser harm than never starting.
      done(!err && String(out).toLowerCase().includes(`"${image.toLowerCase()}"`));
    });
  });
}

/**
 * Starts MGI Games unless it is missing or already up. Quiet either way: the
 * app is optional. Resolves to what happened, for logs and tests.
 */
export async function startGames(port, { exe = gamesExe(), running = isRunning, run = spawn } = {}) {
  if (!exe) return "missing";
  if (await running(path.basename(exe))) return "running";
  try {
    const child = run(exe, ["--stream-port", String(port)], { detached: true, stdio: "ignore", windowsHide: false });
    child.on?.("error", () => {});
    child.unref?.();
    return "started";
  } catch {
    return "failed";
  }
}
