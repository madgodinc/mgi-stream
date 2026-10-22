const EMOJI_ONLY = /^[\p{Extended_Pictographic}\p{Emoji_Component}\s]+$/u;
const LINK = /(https?:\/\/|www\.|\.(com|ru|net|org|io|me)\b)/i;

/** Audience tiers, widest first. A viewer passes if their rank reaches the setting. */
export const RANK = { everyone: 0, followers: 1, subscribers: 2, moderators: 3 };

export function rankOf(identity = {}) {
  if (identity.isModeratorOfAnchor || identity.isAnchor) return RANK.moderators;
  if (identity.isSubscriberOfAnchor) return RANK.subscribers;
  if (identity.isFollowerOfAnchor || identity.isMutualFollowingWithAnchor) return RANK.followers;
  return RANK.everyone;
}

const listed = (list, nick) => list.some((u) => u.trim().toLowerCase() === nick.toLowerCase());

/**
 * The nickname as it is read out: without digits ("kate_1998" -> "kate"),
 * since a voice spelling "одна тысяча девятьсот девяносто восемь" before
 * every message is the loudest noise in a TikTok chat. Separators left
 * dangling by the cut become spaces.
 */
export function spokenNick(nick) {
  return String(nick ?? "")
    .replace(/\p{Nd}+/gu, " ")
    .replace(/[_.\-\s]+/g, " ")
    .trim();
}

/**
 * Decides what to do with one chat message.
 * Returns { speak: true, phrase } or { speak: false, reason, arg }, where the
 * reason is a code the UI translates rather than a ready-made sentence.
 */
export function decide(cfg, { nick, text, identity }) {
  const raw = String(text ?? "").trim();

  if (listed(cfg.ignoreUsers, nick)) return { speak: false, reason: "ignored" };

  const trusted = listed(cfg.allowUsers, nick);
  if (cfg.audience === "whitelist" && !trusted) return { speak: false, reason: "notListed" };
  if (!trusted && rankOf(identity) < RANK[cfg.audience]) {
    return { speak: false, reason: "tier", arg: cfg.audience };
  }

  let body = raw;
  if (cfg.requirePrefix) {
    const mark = cfg.prefix || "!";
    if (!body.startsWith(mark)) return { speak: false, reason: "prefix", arg: mark };
    body = body.slice(mark.length).trim();
  }

  if (body.length < cfg.minChars) return { speak: false, reason: "short" };
  if (cfg.skipEmojiOnly && EMOJI_ONLY.test(body)) return { speak: false, reason: "emoji" };
  if (cfg.skipLinks && LINK.test(body)) return { speak: false, reason: "link" };

  if (body.length > cfg.maxChars) body = body.slice(0, cfg.maxChars) + "…";
  // The nickname part travels separately so speech can hurry it and pause after it.
  // A nickname with nothing left once its digits go is not said at all.
  const said = spokenNick(nick);
  const lead = cfg.sayNickname && said ? cfg.nicknameTemplate.replace("{nick}", said).trim() : "";
  const phrase = lead ? lead + " " + body : body;

  return { speak: true, phrase, lead, body };
}
