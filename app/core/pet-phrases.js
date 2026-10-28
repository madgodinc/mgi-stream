// What the slime says. Each list is picked from at random, so a line comes
// back rarely enough to still sound alive. Placeholders: {nick} the viewer,
// {gift} a gift with its count already declined ("15 роз"), {title} a track,
// {name} the slime's own name, {count} a number, {list} a few nicknames,
// {bank} a piggy bank's name, {top} its biggest giver.

export const PHRASES = {
  ru: {
    thanksSmall: [
      "{nick}, ты делаешь этот стрим теплее. Спасибо за {gift}",
      "Записал в книжку добрых дел: {nick}, {gift}",
      "{gift}! {nick}, обнимаю всем желе",
      "Ура, {gift}! Спасибо, {nick}",
      "{nick}, спасибо! {gift} мне очень к лицу",
      "Ой-ой, {gift}! {nick}, ты прелесть",
      "{nick}, принимаю {gift} с поклоном",
      "Вжух, {gift} от {nick}! Спасибо",
      "{nick}, спасибо за {gift}!",
      "Ой, {gift} от {nick}! Спасибо!",
      "{nick}, ты чудо, спасибо за {gift}",
      "Спасибо, {nick}! {gift} прямо в сердечко",
      "{gift} от {nick}, я таю",
      "Ммм, {gift}! {nick}, благодарю",
      "{nick}, спасибочки за {gift}!",
      "Ловлю {gift}! Спасибо, {nick}",
    ],
    thanksBig: [
      "{nick}, я сейчас расплачусь желе! {gift}!",
      "Это вообще законно? {gift} от {nick}! Спасибо!",
      "{nick}, легенда! {gift}!",
      "Все видели? {gift} от {nick}! Аплодисменты!",
      "{nick}!!! {gift}! Я сейчас лопну от счастья!",
      "ВАУ! {nick}, спасибо за {gift}!",
      "{nick}, это же {gift}! Ты супер!",
      "Держите меня! {gift} от {nick}!",
      "{gift} от {nick}! Я прыгаю до потолка!",
      "{nick}, ну ты даёшь! Огромное спасибо за {gift}!",
    ],
    thanksMany: [
      "{nick} сегодня щедрый: {gift}! Спасибо!",
      "Спасибо, {nick}! Целый набор: {gift}",
      "{nick}, спасибо за всё: {gift}!",
      "{nick} задаривает: {gift}! Спасибо!",
    ],
    thanksCrowd: [
      "Спасибо всем за подарки: {list}!",
      "Какой подарочный дождь! Спасибо, {list}!",
      "Я не успеваю благодарить! {list}, спасибо!",
    ],
    likes: [
      "Лайки летят, я пружиню",
      "От ваших лайков я стал мягче",
      "Ещё немного лайков, и я взлечу",
      "Тап-тап-тап по экрану, я чувствую!",
      "Сколько лайков! Спасибо!",
      "{nick}, спасибо за лайки!",
      "Лайки щекочутся, хи-хи",
      "Ещё, ещё лайков! Я от них расту",
      "Лайк-лайк-лайк! Я вас обожаю",
    ],
    follow: [
      "{nick}, добро пожаловать! Располагайся",
      "Ура, {nick} с нами! Чай, печеньки, музыка",
      "{nick}, привет! Тут уютно, оставайся",
      "{nick}, добро пожаловать к нам!",
      "Привет, {nick}! Рад, что ты с нами",
      "{nick} теперь в нашей банде!",
      "Новый друг! Привет, {nick}",
    ],
    followCrowd: ["Добро пожаловать, {list}!", "Нас больше! Привет, {list}"],
    share: [
      "{nick}, спасибо за репост!",
      "{nick} делится нашим стримом, спасибо!",
      "Репост от {nick}! Обнимаю",
    ],
    music: [
      "Играет: {title}. Заказ от {nick}",
      "О, {title}! Спасибо за заказ, {nick}",
      "Танцуем под {title}!",
      "{title} от {nick}, кайф",
    ],
    musicOwn: ["Играет: {title}", "Танцуем под {title}!"],
    wake: ["Ой! Я не сплю, честно", "А? Что? Я тут!", "Проснулся! Привет!"],
    hello: ["Привет! Я {name}", "Всем привет! {name} на месте", "Я тут! Погнали"],
    thoughts: [
      "Интересно, о чём сейчас думает чат",
      "Если что, я умею ловить подарки ртом",
      "Мне бы шапочку. Маленькую",
      "Кто сегодня самый активный в чате?",
      "Закажите трек, я станцую",
      "Иногда я притворяюсь пудингом",
      "Говорят, слаймы растут от комплиментов",
      "Тут так хорошо, что я сейчас растекусь",
      "Если долго смотреть на меня, я подмигну",
      "Я репетирую благодарности, чтобы никого не забыть",
      "Помашите мне в чате, я помашу в ответ",
      "Сегодня я особенно упругий",
      "Чат, вы лучшие, я серьёзно",
      "Слайм-факт: я на 90% состою из любви к зрителям",
      "Хочу на ручки",
      "Тихо... слышите? Это мой желудок. Он из желе",
      "Ставлю лайк этому стриму",
      "Самое время для музыки, правда?",
      "Интересно, сколько нас сейчас тут?",
      "Кто-нибудь закажет музыку? Команда в чате",
      "Я сделан из желе и любви",
      "Хочу пиццу. Но я слаймик",
      "Если меня потыкать, я пружиню",
      "Пишите в чат, мне скучно молчать",
      "А вы знали, что слаймы не спят? Я сплю",
      "Мечтаю стать большим слаймом",
      "Лайкните, я от этого расту",
      "Сегодня отличный стрим, правда?",
      "Кто тут самый лучший зритель? Ты!",
      "Я бы потанцевал, да музыки нет",
      "Подписывайтесь, у нас уютно",
      "Мне кажется, я немного блестящий",
      "Шшш, я думаю о великом",
      "Где мой чай?",
      "Хочу обнимашек",
      "Посчитаю звёзды... одна, две...",
      "Кто последний в чате, тот пингвин",
      "Я сегодня в настроении попрыгать",
    ],
    thoughtsMusic: [
      "Этот трек заходит прямо в желе",
      "Кто заказал? Хороший вкус",
      "Двигаюсь в ритм, как умею",
      "Под такое можно и попрыгать",
      "Запомню этот трек",
      "Какой бит! Не могу стоять на месте",
      "Эту песню я бы поставил ещё раз",
      "Подпеваю, но тихо",
      "Музыка делает меня мягче",
    ],
    sleepy: ["Сплю... не будите... лайками можно", "Мне снятся подарки...", "Зззз...", "Я только на минуточку прилягу...", "Хррр... лайки... хррр..."],
    bankFull: [
      "Копилка «{bank}» полная! Последнюю монетку закинул {nick}",
      "Дзынь! «{bank}» наполнена. Спасибо, {nick}!",
      "{nick} добил копилку «{bank}»! Сейчас что-то будет",
      "Ура! «{bank}» до краёв. {nick}, это ты сделал",
      "«{bank}» готова! {nick} кинул решающую монетку",
    ],
    bankTop: ["Больше всех накидал {top}. Легенда!", "Главный вкладчик: {top}. Спасибо!", "{top} вложился сильнее всех"],
    giftNames: {},
  },
  en: {
    thanksSmall: ["{nick}, thanks for {gift}!", "Ooh, {gift} from {nick}! Thank you!", "{nick}, you're a gem, thanks for {gift}"],
    thanksBig: ["{nick}!!! {gift}! I'm about to pop!", "WOW! {nick}, thank you for {gift}!", "{gift} from {nick}! Jumping to the ceiling!"],
    thanksMany: ["{nick}, thanks for everything: {gift}!"],
    thanksCrowd: ["Thanks for the gifts, {list}!", "Gift rain! Thank you, {list}!"],
    likes: ["So many likes! Thank you!", "{nick}, thanks for the likes!", "Likes tickle, hehe"],
    follow: ["Welcome, {nick}!", "Hi {nick}, glad you're here", "{nick} joined the gang!"],
    followCrowd: ["Welcome, {list}!"],
    share: ["{nick}, thanks for sharing!", "A share from {nick}! Hugs"],
    music: ["Now playing: {title}. Requested by {nick}", "Dancing to {title}!"],
    musicOwn: ["Now playing: {title}"],
    wake: ["Oh! I wasn't sleeping, honest", "Huh? I'm here!"],
    hello: ["Hi! I'm {name}", "Hello everyone! {name} is here"],
    thoughts: ["Anyone want to request a song?", "I'm made of jelly and love", "Type in chat, I'm bored", "Like me, it makes me grow", "Great stream today, right?"],
    thoughtsMusic: ["What a beat! Can't stand still", "Humming along, quietly"],
    sleepy: ["Zzz...", "Just a little nap..."],
    bankFull: ["The «{bank}» jar is full! {nick} dropped the last coin", "Ding! «{bank}» is full. Thanks, {nick}!", "{nick} filled «{bank}»! Something is about to happen"],
    bankTop: ["Top giver: {top}. Legend!", "{top} put in the most. Thank you!"],
    giftNames: {},
  },
};

/**
 * TikTok names its gifts in English. The usual ones get Russian names with
 * their three plural forms (1 роза, 2 розы, 5 роз); anything else keeps its
 * own name with "×N".
 */
export const GIFT_RU = {
  rose: ["роза", "розы", "роз", "розу"],
  tiktok: ["тикток", "тиктока", "тиктоков"],
  "finger heart": ["сердечко", "сердечка", "сердечек"],
  "heart me": ["сердце", "сердца", "сердец"],
  "hand hearts": ["сердечко руками", "сердечка руками", "сердечек руками"],
  heart: ["сердце", "сердца", "сердец"],
  gg: ["GG", "GG", "GG"],
  "ice cream cone": ["мороженое", "мороженых", "мороженых"],
  doughnut: ["пончик", "пончика", "пончиков"],
  donut: ["пончик", "пончика", "пончиков"],
  perfume: ["духи", "духов", "духов"],
  "friendship necklace": ["ожерелье дружбы", "ожерелья дружбы", "ожерелий дружбы"],
  rosa: ["роза", "розы", "роз", "розу"],
  cap: ["кепка", "кепки", "кепок", "кепку"],
  "hat and mustache": ["шляпа с усами", "шляпы с усами", "шляп с усами", "шляпу с усами"],
  sunglasses: ["очки", "очков", "очков"],
  corgi: ["корги", "корги", "корги"],
  "money gun": ["денежная пушка", "денежные пушки", "денежных пушек", "денежную пушку"],
  galaxy: ["галактика", "галактики", "галактик", "галактику"],
  lion: ["лев", "льва", "львов"],
  universe: ["вселенная", "вселенные", "вселенных", "вселенную"],
  "sports car": ["спорткар", "спорткара", "спорткаров"],
  "whale diving": ["кит", "кита", "китов"],
  "drama queen": ["королева драмы", "королевы драмы", "королев драмы", "королеву драмы"],
  "love bang": ["любовный взрыв", "любовных взрыва", "любовных взрывов"],
  "tiny diny": ["динозаврик", "динозаврика", "динозавриков"],
  coffee: ["кофе", "кофе", "кофе"],
  mic: ["микрофон", "микрофона", "микрофонов"],
  panda: ["панда", "панды", "панд", "панду"],
};

export function pluralRu(n, [one, few, many]) {
  const d = n % 10;
  const h = n % 100;
  if (d === 1 && h !== 11) return one;
  if (d >= 2 && d <= 4 && (h < 12 || h > 14)) return few;
  return many;
}

/**
 * A gift as a thanks names it: "15 роз", and a single one in the case "за"
 * wants ("спасибо за розу"), which is the optional fourth form.
 */
export function giftText(name, count, lang) {
  const key = String(name ?? "").trim().toLowerCase();
  if (lang === "ru" && GIFT_RU[key]) {
    const forms = GIFT_RU[key];
    if (count === 1) return forms[3] ?? forms[0];
    return `${count} ${pluralRu(count, forms)}`;
  }
  const label = name ? `«${name}»` : lang === "ru" ? "подарок" : "a gift";
  return count > 1 ? `${label} ×${count}` : label;
}
