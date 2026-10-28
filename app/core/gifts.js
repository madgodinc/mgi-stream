// A TikTok gift event as everything downstream sees it, and the arithmetic
// that turns a combo streak into "how many new gifts just arrived".
//
// giftType 1 is the combo kind: the viewer taps and TikTok sends one event
// per tap with a running total in repeatCount, then a last event with
// repeatEnd set and the same total. A plain gift arrives once per send with
// its own count. The slime (pet.js) waits for a streak to end before it
// says thanks; a piggy bank cannot wait, the jar fills on every tap, so it
// counts the difference between running totals instead.

/**
 * Who did something, as the rest of the app knows them. Connector 2.x hands
 * over the raw proto user: the @handle is `displayId` and the numeric account
 * id is `id`; the legacy shape names them `uniqueId` and `userId`. The handle
 * is what a viewer types and sees; the number survives a handle change.
 */
export function viewer(user) {
  const u = user ?? {};
  const id = String(u.uniqueId || u.displayId || "");
  return { nick: u.nickname || id || "someone", id, uid: String(u.userId || u.id || "") };
}

/** The fields of a connector GIFT event the app uses. */
export function parseGift(ev) {
  const d = ev?.giftDetails ?? {};
  const streakable = Number(d.giftType ?? ev?.giftType) === 1;
  const count = Number(ev?.repeatCount ?? 1) || 1;
  const end = !streakable || Boolean(ev?.repeatEnd);
  const msgId = String(ev?.common?.msgId ?? ev?.msgId ?? "");
  return {
    ...viewer(ev?.user),
    giftId: ev?.giftId,
    name: d.giftName ?? ev?.giftName ?? "",
    diamonds: Number(d.diamondCount ?? ev?.diamondCount ?? 1) || 1,
    count,
    streakable,
    end,
    // The same tap seen twice (a reconnect overlap) has the same id, count and end.
    key: msgId ? `${msgId}|${count}|${end ? 1 : 0}` : "",
  };
}

const STREAK_IDLE_MS = 5000; // the same as pet.js: a streak quiet this long is over

/**
 * Turns gift events into new gifts. Feed it every event; it answers how many
 * gifts in that event were not counted before.
 */
export class Streaks {
  constructor({ now = () => Date.now(), idleMs = STREAK_IDLE_MS } = {}) {
    this.now = now;
    this.idleMs = idleMs;
    this.open = new Map(); // viewer|gift -> { count, at, ended }
  }

  take(g) {
    if (!g.streakable) return Math.max(0, g.count);
    const t = this.now();
    for (const [k, s] of this.open) if (t - s.at > this.idleMs) this.open.delete(k);
    // Two viewers with one display name are still two streaks.
    const key = `${g.id || g.nick}|${g.giftId ?? g.name}`;
    const s = this.open.get(key);
    let fresh;
    if (!s) fresh = g.count;
    else if (s.ended) {
      // The closing event repeated is nothing new; anything else starts a new streak.
      fresh = g.end && g.count === s.count ? 0 : g.count;
    } else if (g.count < s.count) fresh = g.count; // the old streak ended unseen
    else fresh = g.count - s.count;
    this.open.set(key, { count: g.count, at: t, ended: g.end });
    return fresh;
  }

  clear() {
    this.open.clear();
  }
}

/**
 * Gifts people mostly send, with their price in coins as TikTok listed it in
 * 2026. Prices drift; the list only helps type a name.
 */
export const KNOWN_GIFTS = [
  ["Rose", 1], ["TikTok", 1], ["GG", 1], ["Ice Cream Cone", 1], ["Heart Me", 1],
  ["Finger Heart", 5], ["Perfume", 20], ["Doughnut", 30], ["Hat and Mustache", 99],
  ["Confetti", 100], ["Hand Hearts", 100], ["Corgi", 299], ["Money Gun", 500],
  ["Galaxy", 1000], ["Whale diving", 2150], ["Lion", 29999], ["TikTok Universe", 44999],
];
