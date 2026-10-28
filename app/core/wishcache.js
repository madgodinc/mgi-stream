import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";

/**
 * A copy of every wishlist track on this PC, so the wishlist plays when the
 * music server cannot reach YouTube. One file per track, named
 * `<youtube id>.<video|audio>.<ext>`: the name says what the player gets, so
 * no index file has to agree with the folder.
 *
 * A track that already came down for the queue is copied; anything else is
 * fetched from the server in the background, one at a time, and tried again
 * later when that fails. Emits `change` when the set of saved tracks changes.
 */

const NAME = /^([A-Za-z0-9_-]+)\.(video|audio)\.([a-z0-9]+)$/i;
const RETRY_MS = 10 * 60 * 1000;

export class WishCache extends EventEmitter {
  /**
   * `wanted()` returns the wishlist ids as they are now; `download(id, dir, name)`
   * brings one track down into `dir` and resolves to {file, ext, video}.
   */
  constructor({ dir, wanted, download, retryMs = RETRY_MS }) {
    super();
    this.dir = dir;
    this.wanted = wanted;
    this.download = download;
    this.retryMs = retryMs;
    this.saved = new Map(); // id -> {file, ext, video}
    this.held = new Map(); // id -> how many tracks play from the file now
    this.todo = new Set();
    this.failed = new Set(); // ids that failed this round
    this.copying = new Set(); // ids being copied in, so two copies never share a .part
    this.busy = false;
    this.timer = null;
    this.#scan();
  }

  #scan() {
    let names = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch {}
    this.saved.clear();
    for (const n of names) {
      const m = n.match(NAME);
      if (m) this.saved.set(m[1], { file: path.join(this.dir, n), ext: m[3], video: m[2] === "video" });
    }
  }

  has(id) {
    return this.saved.has(id);
  }

  get(id) {
    const s = this.saved.get(id);
    return s && fs.existsSync(s.file) ? s : null;
  }

  #isWanted(id) {
    return this.wanted().includes(id);
  }

  /** Copies a track that already came down; true when it is saved now. */
  async keep(id, file, ext, video) {
    if (this.saved.has(id)) return true;
    if (!file || this.copying.has(id) || !this.#isWanted(id)) return false;
    this.copying.add(id);
    const name = `${id}.${video ? "video" : "audio"}.${ext}`;
    const part = path.join(this.dir, name + ".part");
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      await fs.promises.copyFile(file, part);
      await this.#settle(id, part, name);
      return this.saved.has(id);
    } catch {
      fs.rm(part, { force: true }, () => {});
      return false;
    } finally {
      this.copying.delete(id);
    }
  }

  /** Moves a finished file into place, unless the track left the wishlist meanwhile. */
  async #settle(id, from, name) {
    if (this.saved.has(id) || !this.#isWanted(id)) return fs.promises.rm(from, { force: true });
    const file = path.join(this.dir, name);
    await fs.promises.rename(from, file);
    const m = name.match(NAME);
    this.saved.set(id, { file, ext: m[3], video: m[2] === "video" });
    this.todo.delete(id);
    this.emit("change");
  }

  /** A track just added: copied from the queue when it is there, otherwise fetched. */
  async add(id, track = null) {
    if (this.copying.has(id) || await this.keep(id, track?.file, track?.ext, track?.video)) return;
    this.want(id);
  }

  want(id) {
    if (this.saved.has(id)) return;
    this.todo.add(id);
    this.#next();
  }

  /** The track left the wishlist: its file goes, unless it is playing right now. */
  remove(id) {
    this.todo.delete(id);
    if (this.held.get(id)) return;
    const s = this.saved.get(id);
    if (!s) return;
    this.saved.delete(id);
    fs.rm(s.file, { force: true }, () => {});
    this.emit("change");
  }

  /** The player took this file; it is not deleted from under it. */
  hold(id) {
    this.held.set(id, (this.held.get(id) || 0) + 1);
  }

  release(id) {
    const n = (this.held.get(id) || 0) - 1;
    if (n > 0) return this.held.set(id, n);
    this.held.delete(id);
    if (!this.#isWanted(id)) this.remove(id);
  }

  /** On startup: files of tracks gone from the wishlist go, missing ones are fetched. */
  sync() {
    const ids = new Set(this.wanted());
    let names = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch {}
    for (const n of names) {
      const m = n.match(NAME);
      if (!m || !ids.has(m[1])) fs.rmSync(path.join(this.dir, n), { force: true, recursive: true });
    }
    this.#scan();
    for (const id of ids) if (!this.saved.has(id)) this.todo.add(id);
    this.#next();
  }

  /**
   * One background download at a time. A track that failed waits for the next
   * round, `retryMs` after the last one failed; the others go on meanwhile.
   */
  async #next() {
    if (this.busy) return;
    for (const i of this.todo) if (this.saved.has(i) || !this.#isWanted(i)) this.todo.delete(i);
    const id = [...this.todo].find((i) => !this.failed.has(i));
    if (!id) {
      if (this.failed.size && !this.timer) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.failed.clear();
          this.#next();
        }, this.retryMs);
        this.timer.unref?.();
      }
      return;
    }
    this.busy = true;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const got = await this.download(id, this.dir, `${id}.part`);
      await this.#settle(id, got.file, `${id}.${got.video ? "video" : "audio"}.${got.ext}`);
    } catch {
      this.failed.add(id);
      try {
        for (const n of fs.readdirSync(this.dir)) if (n.startsWith(`${id}.part`)) fs.rmSync(path.join(this.dir, n), { force: true });
      } catch {}
    }
    this.busy = false;
    this.#next();
  }

  /** Tries again now instead of after the pause. */
  resume() {
    clearTimeout(this.timer);
    this.timer = null;
    this.failed.clear();
    this.#next();
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
    this.todo.clear();
    this.failed.clear();
  }
}
