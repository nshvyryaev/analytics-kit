/**
 * Словарь событий: имена и форма свойств. Один на клиент и сервер.
 *
 * Общий он не ради красоты. Опечатка в имени события иначе тихо заводит новую
 * метрику, и обнаруживается это через месяц по дырке в графике; необъявленное
 * свойство точно так же тихо копится в базе и ничего не значит.
 *
 * Типы намеренно бедные: 'int', 'num', 'str', 'bool', массив допустимых
 * значений для перечисления и 'arr' для списков. Богаче — значит писать свой
 * валидатор схем, а он тут не нужен.
 */

export const MAX_STR = 64;
export const MAX_PROPS_BYTES = 2048;
/**
 * У известного события ключей и так ровно столько, сколько объявлено в
 * словаре — ограничивать нечего, тело запроса не может добавить их сверху
 * (цикл идёт по `shape`, а не по `source`). У незнакомого события ключи идут
 * прямиком из тела запроса, и без явного потолка `fit()` ниже режет их по
 * одному, на каждый шаг заново сериализуя убывающий объект — при тысячах
 * ключей это O(n²) на точке входа, открытой в сеть.
 */
export const MAX_UNKNOWN_KEYS = 32;

/**
 * Модуль общий для браузера и сервера, а `Buffer` в браузере не существует —
 * импорт с ним уронил бы клиентскую сборку. `TextEncoder` — глобальный API
 * и там, и там, поэтому байты UTF-8 считаем именно им.
 */
const encoder = new TextEncoder();
const byteSize = (value) => encoder.encode(JSON.stringify(value)).length;

const MODE = ['puzzle', 'daily', 'shared'];

/**
 * Целое в границах — форма объявления числового поля с диапазоном, а не
 * голый 'int'. Нужна конкретно для `length`: значение слова используется в
 * ИМЕНИ метрики свёртки (rollup.mjs), а не только хранится — без диапазона
 * мощность `daily` (таблицы без срока хранения) определял бы клиент, просто
 * присылая произвольные числа. Форма общая, чтобы любое другое числовое
 * поле, которому когда-нибудь тоже понадобится диапазон, не изобретало
 * второй способ его объявить.
 */
const range = (min, max) => ({ kind: 'range', min, max });

/**
 * Длина слова в игре — от трёх до восьми букв. Не экспортируется и
 * намеренно не используется нигде за пределами словаря: у rollup.mjs (где
 * длина попадает в имя метрики) — свой, отдельно заданный диапазон. Общая
 * константа связала бы два независимых предохранителя в один: смягчи здесь
 * границу ради нового игрового режима — и лимит на число строк в `daily`
 * (таблице без ретеншена) молча смягчился бы вместе с ней, никем не
 * пересмотренный.
 */
const WORD_LENGTH = range(3, 8);

/**
 * Шаг — строка, а не перечисление: сценарий обучения меняется (и будет
 * меняться в A/B), а перечисление здесь требовало бы новой версии пакета на
 * каждую правку сценария. В имя метрики свёртки шаг не попадает, так что
 * мощность `daily` клиент через него не раздует.
 */
const ONBOARDING_FROM = ['first-play', 'how-to', 'help'];

/**
 * Общая часть словаря — события, которые значат одно и то же в любой игре:
 * жизненный цикл, ошибка, окно оплаты, факты о деньгах. Раздел приложения
 * (`APPS`) перекрывает общую часть по имени события ЦЕЛИКОМ, а не по
 * отдельным свойствам: слияние двух разных форм под одним именем дало бы
 * форму, которую не объявлял никто.
 */
export const COMMON = {
  // Жизненный цикл
  app_ready: { ms_to_ready: 'int', ms_data_load: 'int', from_cache: 'bool' },
  platform_fallback: { platform: 'str', stage: ['sdk_load', 'ready', 'storage'] },
  pause: { ms: 'int' },
  resume: { ms: 'int' },
  session_end: { ms: 'int', events: 'int', reason: ['pagehide', 'timeout'] },
  app_error: { where: 'str', message: 'str', fatal: 'bool' },

  // Покупки
  /**
   * Цена лежит в двух видах не ради дублирования, а потому что площадки
   * отдают её по-разному, и это не унифицировать на клиенте без разбора
   * локализованного текста регулярками. ВКонтакте отдаёт число с валютой
   * (голоса/ОКи) — `price`/`currency` заполнены и пригодны для арифметики
   * (сумма, средний чек). Яндекс отдаёт только готовую строку вида «19 ₽» —
   * для неё `price_text` обязателен и есть у всех площадок; `price`/`currency`
   * там просто не приходят, и разбирать строку в число значило бы гадать по
   * формату конкретной локали, который может измениться без нашего ведома.
   */
  store_item_select: { item_id: 'str', price: 'num', currency: 'str', price_text: 'str' },
  purchase_result: {
    item_id: 'str', outcome: ['purchased', 'cancelled', 'unavailable', 'timeout'], ms: 'int',
  },
  purchase_credited: { source: ['vk', 'yandex', 'manual'], item_id: 'str', repeat: 'bool' },
  payment_rejected: { source: 'str', reason: 'str' },
};

/**
 * Раздел word-chain. Вместе с `COMMON` даёт словарь v0.2.8 без единого
 * изменения (tests/fixtures/word-chain-v0.2.8.json). `purchase_credited`
 * свой: у word-chain начисление несёт подсказки и отключение рекламы.
 */
const WORD_CHAIN = {
  // Уровни
  level_start: { mode: MODE, length: WORD_LENGTH, level: 'int', resumed: 'bool' },
  word_rejected: { word: 'str', length: 'int', reason: 'str', attempt: 'int', ms_since_start: 'int' },
  level_end: {
    outcome: ['solved', 'abandoned'], mode: MODE, length: WORD_LENGTH, level: 'int',
    moves: 'arr', rejects: 'int', hints: 'int', ms: 'int', chain: 'arr', streak: 'int',
  },
  /**
   * `kind` — какая это подсказка: буква или целое слово. Поле нужно затем, что
   * две подсказки стоят разного и берутся по-разному: буква идёт из бесплатной,
   * запаса или ролика, слово — только из запаса и только после взятой буквы. По
   * `source` их не различить (у обеих он про то, откуда взялась подсказка), а
   * без различения не считается главная воронка этой механики: сколько игроков
   * доходит от буквы до слова.
   */
  hint_used: {
    length: 'int', level: 'int', move_no: 'int', wallet_before: 'int',
    source: ['free', 'purchased', 'reward'],
    kind: ['letter', 'word'],
  },
  hint_blocked: { reason: ['empty', 'no-reward', 'ad-too-soon'], wallet: 'int' },
  glossary_open: { word: 'str', from: ['game', 'stats'] },

  // Реклама
  ad_request: { kind: ['interstitial', 'rewarded'], placement: ['level_end', 'hint'], gap_ms: 'int' },
  ad_result: {
    kind: ['interstitial', 'rewarded'], placement: ['level_end', 'hint'],
    outcome: ['shown', 'dismissed', 'no_fill', 'timeout', 'error', 'absent'], ms: 'int',
  },

  // Покупки
  store_open: { from: ['hint_blocked', 'menu', 'level_end'], wallet: 'int', ms_catalog: 'int' },
  store_close: { bought: 'bool', ms: 'int', items_seen: 'int' },
  wallet_sync: { credited: 'int', spent_local: 'int', drift: 'int' },
  purchase_credited: {
    source: 'str', item_id: 'str', hints: 'int', ad_free: 'bool', repeat: 'bool',
  },

  // Обучение. Шаг — имя, а не номер: номера съедут от первой правки сценария,
  // а имя шага в воронке останется тем же. Имена — OnboardingStep в игре.
  // `from` — откуда пришли: первое «Играть» или «Как играть?» с главной.
  onboarding_start: { from: ONBOARDING_FROM },
  onboarding_step: { step: 'str', from: ONBOARDING_FROM },
  onboarding_skip: { step: 'str', from: ONBOARDING_FROM, ms: 'int' },
  onboarding_done: { from: ONBOARDING_FROM, ms: 'int' },
  // Отказ хода на свободных шагах обучения. Без него было не видно, почему
  // игроки уходят на последнем, самостоятельном ходе: пробуют и не выходит —
  // или не пробуют вовсе.
  onboarding_reject: { step: 'str', from: ONBOARDING_FROM },

  // A/B-эксперименты (ab-kit). Показ, а не назначение: событие уходит, когда
  // вариант реально увиден, и только у записанных в эксперимент. По нему
  // отчёт делит игроков на группы, а метрики берёт из остальных событий.
  ab_exposure: { experiment: 'str', variant: 'str' },

  // Подсказка «Посмотрите обучение» у игрока без обучения: предложена (по
  // двум отказам хода или по простою) и открыта. Пара даёт воронку подсказки.
  help_offer: { reason: ['rejects', 'idle'] },
  help_open: {},

  // Остальное
  screen_view: { screen: ['home', 'game', 'stats'], from: 'str' },
  share_click: { kind: ['puzzle', 'result'], method: ['platform', 'clipboard', 'browser'] },
  share_result: { kind: ['puzzle', 'result'], method: ['platform', 'clipboard', 'browser'], ok: 'bool' },
  settings_change: { key: ['sound', 'accent', 'theme'], value: 'str' },
};

// Раздел image-uncovered. Диапазоны — у всего, что может попасть в имя метрики
// свёртки или в корзину отчёта: номер уровня, проценты, жизни, оценки.
const IU_MODE = ['campaign', 'endless', 'daily', 'custom'];
const IU_LEVEL = range(1, 99999);
const IU_PCT = range(0, 100);
const IU_LIVES = range(0, 7);
const IU_SCALE = range(1, 5);
const IU_AD_KIND = ['interstitial', 'rewarded'];
const IU_AD_PLACEMENT = ['level_start', 'custom_start', 'continue'];
const IU_BOARD = ['campaign', 'endless', 'daily'];
const IU_AUTH_TRIGGER = ['purchase', 'vote'];
const IU_NICK_TRIGGER = ['leaderboard', 'settings', 'custom_level'];
const IU_VOTE_TARGET = ['campaign', 'level'];

const IMAGE_UNCOVERED = {
  // Загрузка и сеть
  level_load: {
    mode: IU_MODE, level_id: 'str', source: ['bundled', 'cache', 'network'], ms: 'int',
    image_ok: 'bool', preloaded: 'bool',
  },
  net_error: {
    kind: ['catalog', 'level', 'image', 'daily', 'leaderboard', 'score', 'nick', 'vote', 'purchase', 'session'],
    reason: ['offline', 'timeout', 'http_4xx', 'http_5xx'],
    retry: 'int',
  },

  // Экраны и настройки
  screen_view: {
    screen: ['start', 'campaigns', 'game', 'leaderboard', 'settings', 'store', 'campaign_end', 'custom'],
    from: 'str',
  },
  campaign_select: { campaign_id: 'str', campaigns_done: 'int', locked: 'bool' },
  settings_change: { key: ['control_side', 'haptics', 'controls_visibility', 'theme'], value: 'str' },

  // Забег и уровни
  run_start: { mode: IU_MODE, campaign_id: 'str', lives: IU_LIVES, ad_free: 'bool', resumed: 'bool' },
  level_start: {
    mode: IU_MODE, campaign_id: 'str', level: IU_LEVEL, level_id: 'str', lives: IU_LIVES, attempt: 'int',
  },
  life_lost: {
    mode: IU_MODE, level: IU_LEVEL, level_id: 'str', cause: ['enemy_hit_player', 'enemy_hit_trail'],
    coverage_pct: IU_PCT, ms_since_start: 'int', lives_left: IU_LIVES,
  },
  level_end: {
    outcome: ['won', 'lost', 'abandoned'], mode: IU_MODE, campaign_id: 'str', level: IU_LEVEL,
    level_id: 'str', ms: 'int', coverage_pct: IU_PCT, score: 'int', lives_left: IU_LIVES,
    deaths: 'int', bonuses: 'int', life_bonus: 'int', attempt: 'int', inferred: 'bool',
  },
  continue_choice: {
    mode: IU_MODE, level: IU_LEVEL, choice: ['ad_life', 'restart', 'menu', 'closed'], ms: 'int',
    ad_life_available: 'bool', unavailable_reason: ['limit', 'offline', 'cooldown'],
  },
  run_end: {
    mode: IU_MODE, campaign_id: 'str', outcome: ['lost', 'completed', 'quit'], levels_done: 'int',
    score: 'int', ms: 'int', ad_lives_used: 'int',
  },

  // Реклама. `granted` у `ad_result` — только для rewarded, открывшейся после
  // таймаута (`late_shown`): выдана ли награда, когда игрок уже ушёл дальше.
  ad_request: { kind: IU_AD_KIND, placement: IU_AD_PLACEMENT, gap_ms: 'int' },
  ad_result: {
    kind: IU_AD_KIND, placement: IU_AD_PLACEMENT,
    outcome: ['shown', 'dismissed', 'no_fill', 'throttled', 'timeout', 'late_shown', 'error', 'absent'],
    ms: 'int', granted: 'bool',
  },
  ad_skipped: { placement: IU_AD_PLACEMENT, reason: ['ad_free', 'first_level', 'cooldown', 'offline'] },

  // Витрина и вход
  store_open: { from: ['menu', 'catalog'] },
  auth_prompt: { trigger: IU_AUTH_TRIGGER, item_id: 'str' },
  auth_result: {
    trigger: IU_AUTH_TRIGGER, outcome: ['authorized', 'declined', 'error'], ms: 'int', continued: 'bool',
  },

  // Ник и таблицы
  nick_prompt: { trigger: IU_NICK_TRIGGER, prefilled: 'bool', input: ['touch', 'keyboard'] },
  nick_result: {
    trigger: IU_NICK_TRIGGER, outcome: ['saved', 'rejected', 'queued', 'cancelled', 'error'],
    reject_reason: ['length', 'chars', 'blocked'], attempts: 'int', ms: 'int', kept_prefill: 'bool',
  },
  score_submit: {
    board: IU_BOARD, outcome: ['accepted', 'queued', 'rejected', 'error'], new_best: 'bool',
    rank_bucket: ['1', '2-10', '11-50', '51-500', '500+'], has_nick: 'bool',
  },
  score_rejected: {
    board: IU_BOARD,
    reason: ['board', 'level_ids', 'level_count', 'level_score', 'run_score', 'duration', 'daily_window', 'rate'],
  },

  // Оценки
  vote_prompt: { target: IU_VOTE_TARGET, target_id: 'str' },
  vote_result: {
    target: IU_VOTE_TARGET, target_id: 'str', difficulty: IU_SCALE, liked: IU_SCALE,
    outcome: ['submitted', 'skipped', 'queued'],
  },
};

/** Разделы приложений. Приложение без раздела получает только `COMMON`. */
export const APPS = {
  'word-chain': WORD_CHAIN,
  'image-uncovered': IMAGE_UNCOVERED,
};

/**
 * Приложение по умолчанию у `validate` — word-chain: до v0.3.0 словарь был
 * один, его, и вызов с двумя параметрами обязан значить ровно то же, что раньше.
 */
export const DEFAULT_APP = 'word-chain';

// Слияние считается один раз на приложение. Ключи карты — только имена из
// `APPS`: имя приложения может прийти из сети, и кэш по произвольной строке
// рос бы без предела.
const dictionaries = new Map(
  Object.entries(APPS).map(([app, section]) => [app, { ...COMMON, ...section }]),
);

/** Полный словарь приложения: общая часть, перекрытая разделом по имени события. */
export function dictionary(app = DEFAULT_APP) {
  return dictionaries.get(app) ?? COMMON;
}

/** Словарь word-chain под прежним именем — для тех, кто импортировал его до v0.3.0. */
export const EVENTS = dictionary(DEFAULT_APP);

const isInt = (v) => Number.isInteger(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function coerce(spec, value) {
  if (Array.isArray(spec)) return spec.includes(value) ? value : undefined;
  if (spec && typeof spec === 'object' && spec.kind === 'range') {
    return isInt(value) && value >= spec.min && value <= spec.max ? value : undefined;
  }
  if (spec === 'int') return isInt(value) ? value : undefined;
  if (spec === 'num') return isNum(value) ? value : undefined;
  if (spec === 'bool') return typeof value === 'boolean' ? value : undefined;
  if (spec === 'str') return typeof value === 'string' ? value.slice(0, MAX_STR) : undefined;
  if (spec === 'arr') return Array.isArray(value) ? value : undefined;
  return undefined;
}

/** Примитив, пригодный для записи от незнакомого события. */
function loose(value) {
  if (typeof value === 'string') return value.slice(0, MAX_STR);
  if (typeof value === 'boolean' || isNum(value)) return value;
  return undefined;
}

/**
 * Урезает свойства до предела по размеру. Выбрасываются последние ключи, а не
 * случайные: порядок объявления в словаре идёт от важного к подробностям, и
 * терять хвост менее обидно, чем середину.
 *
 * Предел — в байтах UTF-8 (так заявлено в спеке), а домен целиком
 * русскоязычный: кириллица в UTF-8 занимает вдвое больше места, чем единиц
 * длины JS-строки (UTF-16). Мерить через .length — значит пропускать почти
 * вдвое больше данных, чем обещано.
 */
function fit(props) {
  const keys = Object.keys(props);
  while (keys.length && byteSize(props) > MAX_PROPS_BYTES) {
    delete props[keys.pop()];
  }
  return props;
}

/**
 * События, факт которых знает только сервер: деньги и отказ результата. От
 * клиента (`/v1/collect`) такое имя — подделка или ошибка, и записывается как
 * незнакомое (`known = 0`): свойства не проверяются словарём, в свёртку
 * событие не идёт. Сервер пишет их через `track()` — там они знакомы.
 */
export const SERVER_ONLY = new Set(['purchase_credited', 'payment_rejected', 'score_rejected']);

/** Свойства незнакомого события: только примитивы, не больше `MAX_UNKNOWN_KEYS` ключей. */
function unknown(source) {
  const out = {};
  for (const [key, value] of Object.entries(source).slice(0, MAX_UNKNOWN_KEYS)) {
    const kept = loose(value);
    if (kept !== undefined) out[key] = kept;
  }
  return { known: false, props: fit(out) };
}

/** Проверка события, пришедшего от клиента: `validate`, но `SERVER_ONLY` — незнакомые. */
export function validateClient(name, props, app = DEFAULT_APP) {
  if (SERVER_ONLY.has(name)) return unknown(props && typeof props === 'object' ? props : {});
  return validate(name, props, app);
}

export function validate(name, props, app = DEFAULT_APP) {
  const dict = dictionary(app);
  const shape = Object.hasOwn(dict, name) ? dict[name] : undefined;
  const source = props && typeof props === 'object' ? props : {};
  const out = {};

  if (!shape) return unknown(source);

  for (const [key, spec] of Object.entries(shape)) {
    if (!(key in source)) continue;
    const kept = coerce(spec, source[key]);
    if (kept !== undefined) out[key] = kept;
  }
  fit(out);

  // Что пришло, но не записано: значение не того типа или вне перечисления,
  // необъявленный ключ, хвост, срезанный по размеру. Без этого известное
  // событие теряло бы свойство молча — словарь клиента разъехался, а в базе
  // всё выглядит как known = 1. Поле есть, только когда что-то отброшено.
  const dropped = [];
  for (const key of Object.keys(source)) {
    if (dropped.length >= MAX_UNKNOWN_KEYS) break;
    if (!Object.hasOwn(out, key)) dropped.push(key.slice(0, MAX_STR));
  }
  return dropped.length
    ? { known: true, props: out, dropped: dropped.join(',') }
    : { known: true, props: out };
}
