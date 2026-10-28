import fs from "node:fs";

// The streamer's wishlist: tracks from the stream worth keeping. One JSON file,
// newest first; a track is there once, by its YouTube id.

const FIELDS = ["id", "title", "channel", "duration", "thumbnail", "nick"];

export class Wishlist {
  constructor(file) {
    this.file = file;
    this.items = [];
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Array.isArray(data)) this.items = data.filter((t) => t && typeof t.id === "string");
    } catch {
      // No list yet, or a broken one: start empty.
    }
  }

  list() {
    return this.items;
  }

  has(id) {
    return this.items.some((t) => t.id === id);
  }

  add(track) {
    if (!track?.id || this.has(track.id)) return this.items;
    const item = { added: Date.now() };
    for (const k of FIELDS) item[k] = track[k] ?? "";
    this.items.unshift(item);
    this.#save();
    return this.items;
  }

  remove(id) {
    this.items = this.items.filter((t) => t.id !== id);
    this.#save();
    return this.items;
  }

  #save() {
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.items, null, 1));
    fs.renameSync(tmp, this.file);
  }
}
