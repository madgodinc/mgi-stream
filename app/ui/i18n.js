// Every visible string lives here. The UI marks nodes with data-t (text) and
// data-ph (placeholder); apply() rewrites them when the language changes.

const RU = {
  channel: "Канал TikTok",
  channelPlaceholder: "@ник",
  air: { off: "не в эфире", connecting: "подключаюсь", live: "в эфире", error: "проблема" },
  goOnAir: "в эфир",
  stop: "стоп",

  voice: "Голос",
  ruMale: "рус м",
  ruFemale: "рус ж",
  enMale: "анг м",
  enFemale: "анг ж",
  allVoices: "Все голоса",
  speed: "Скорость",
  pitch: "Тон",
  testVoice: "проверить голос",
  synthesizing: "синтезирую",
  voiceListFailed: "не удалось загрузить список голосов",

  who: "Кого озвучивать",
  everyone: "всех",
  followers: "подписчиков",
  subscribers: "сабов",
  moderators: "модеров",
  whitelist: "только список",
  prefixOnly: "Только сообщения, начинающиеся с",
  alwaysRead: "Читать всегда (по нику в строке)",
  neverRead: "Не читать никогда",

  reading: "Чтение",
  sayNickname: "Называть ник",
  nickTemplate: "{nick} пишет.",
  skipEmoji: "Пропускать сообщения из одних эмодзи",
  skipLinks: "Пропускать сообщения со ссылками",
  playInApp: "Дублировать звук в этом окне",
  cutAfter: "Обрезать сообщения после",
  queueDepth: "Глубина очереди",
  port: "Порт оверлея",

  obsSource: "источник для OBS",
  notRunning: "не запущено",
  copy: "копировать",
  open: "открыть",
  demo: "демо-чат",
  queue: "очередь",
  dropped: "выброшено",

  emptyTitle: "Впишите канал и выходите в эфир.",
  emptyBody: "Чат появится здесь, а речь пойдёт в OBS через источник снизу.",

  reason: {
    ignored: "в чёрном списке",
    notListed: "нет в списке",
    tier: "не $1",
    prefix: "без $1",
    short: "слишком коротко",
    emoji: "одни эмодзи",
    link: "со ссылкой",
  },
  tier: {
    followers: "подписчик",
    subscribers: "саб",
    moderators: "модер",
  },
  err: {
    noUsername: "Сначала впишите ник канала.",
    portTaken: "Порт $1 занят, выберите другой в настройках.",
    notLive: "$1 сейчас не в эфире.",
    speech: "Озвучка не удалась: $1",
    ended: "Стрим закончился.",
  },
};

const EN = {
  channel: "TikTok channel",
  channelPlaceholder: "@username",
  air: { off: "off air", connecting: "connecting", live: "on air", error: "problem" },
  goOnAir: "go on air",
  stop: "stop",

  voice: "Voice",
  ruMale: "ru male",
  ruFemale: "ru female",
  enMale: "en male",
  enFemale: "en female",
  allVoices: "All voices",
  speed: "Speed",
  pitch: "Pitch",
  testVoice: "test voice",
  synthesizing: "synthesizing",
  voiceListFailed: "could not load the voice list",

  who: "Who gets read",
  everyone: "everyone",
  followers: "followers",
  subscribers: "subs",
  moderators: "mods",
  whitelist: "list only",
  prefixOnly: "Only messages starting with",
  alwaysRead: "Always read (one nickname per line)",
  neverRead: "Never read",

  reading: "Reading",
  sayNickname: "Say the nickname",
  nickTemplate: "{nick} says.",
  skipEmoji: "Skip emoji-only messages",
  skipLinks: "Skip messages with links",
  playInApp: "Play sound in this window too",
  cutAfter: "Cut messages after",
  queueDepth: "Queue depth",
  port: "Overlay port",

  obsSource: "OBS browser source",
  notRunning: "not running",
  copy: "copy",
  open: "open",
  demo: "demo chat",
  queue: "queue",
  dropped: "dropped",

  emptyTitle: "Enter the channel and go on air.",
  emptyBody: "Chat shows up here, and the speech plays through the OBS browser source below.",

  reason: {
    ignored: "ignored user",
    notListed: "not on the list",
    tier: "not a $1",
    prefix: "no $1 prefix",
    short: "too short",
    emoji: "emoji only",
    link: "contains a link",
  },
  tier: {
    followers: "follower",
    subscribers: "subscriber",
    moderators: "moderator",
  },
  err: {
    noUsername: "Enter the channel name first.",
    portTaken: "Port $1 is taken, pick another one in settings.",
    notLive: "$1 is not live right now.",
    speech: "Speech failed: $1",
    ended: "The stream ended.",
  },
};

const PACKS = { ru: RU, en: EN };

export let lang = "en";
export let t = EN;

export function setLang(next) {
  lang = PACKS[next] ? next : "en";
  t = PACKS[lang];
  apply();
  return lang;
}

/** Looks up a dotted key and fills $1 with the argument. */
export function tr(key, arg) {
  let node = t;
  for (const part of key.split(".")) node = node?.[part];
  const text = typeof node === "string" ? node : key;
  return arg === undefined ? text : text.replace("$1", arg);
}

export function apply() {
  for (const el of document.querySelectorAll("[data-t]")) el.textContent = tr(el.dataset.t);
  for (const el of document.querySelectorAll("[data-ph]")) el.placeholder = tr(el.dataset.ph);
}
