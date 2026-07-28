const EMOJI_ONLY = /^[\p{Extended_Pictographic}\p{Emoji_Component}\s]+$/u;
const LINK = /(https?:\/\/|www\.|\.(com|ru|net|org|io|me)\b)/i;

/** Audience tiers, widest first. A viewer passes if their rank reaches the setting. */
const RANK = { everyone: 0, followers: 1, subscribers: 2, moderators: 3 };

function rankOf(identity = {}) {
  if (identity.isModeratorOfAnchor || identity.isAnchor) return RANK.moderators;
  if (identity.isSubscriberOfAnchor) return RANK.subscribers;
  if (identity.isFollowerOfAnchor || identity.isMutualFollowingWithAnchor) return RANK.followers;
  return RANK.everyone;
}

const listed = (list, nick) => list.some((u) => u.trim().toLowerCase() === nick.toLowerCase());

/**
 * Decides what to do with one chat message.
 * Returns { speak: true, phrase } or { speak: false, reason }.
 */
export function decide(cfg, { nick, text, identity }) {
  const raw = String(text ?? "").trim();

  if (listed(cfg.ignoreUsers, nick)) return { speak: false, reason: "ignored user" };

  const trusted = listed(cfg.allowUsers, nick);
  if (cfg.audience === "whitelist" && !trusted) return { speak: false, reason: "not on the list" };
  if (!trusted && rankOf(identity) < RANK[cfg.audience]) {
    return { speak: false, reason: `not a ${cfg.audience.replace(/s$/, "")}` };
  }

  let body = raw;
  if (cfg.requirePrefix) {
    const mark = cfg.prefix || "!";
    if (!body.startsWith(mark)) return { speak: false, reason: `no ${mark} prefix` };
    body = body.slice(mark.length).trim();
  }

  if (body.length < cfg.minChars) return { speak: false, reason: "too short" };
  if (cfg.skipEmojiOnly && EMOJI_ONLY.test(body)) return { speak: false, reason: "emoji only" };
  if (cfg.skipLinks && LINK.test(body)) return { speak: false, reason: "contains a link" };

  if (body.length > cfg.maxChars) body = body.slice(0, cfg.maxChars) + "…";
  const phrase = cfg.sayNickname
    ? cfg.nicknameTemplate.replace("{nick}", nick) + " " + body
    : body;

  return { speak: true, phrase };
}
