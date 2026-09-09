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

const MODE = ['puzzle', 'daily', 'shared'];

export const EVENTS = {
  // Жизненный цикл
  app_ready: { ms_to_ready: 'int', ms_data_load: 'int', from_cache: 'bool' },
  platform_fallback: { platform: 'str', stage: ['sdk_load', 'ready', 'storage'] },
  pause: { ms: 'int' },
  resume: { ms: 'int' },
  session_end: { ms: 'int', events: 'int', reason: ['pagehide', 'timeout'] },

  // Уровни
  level_start: { mode: MODE, length: 'int', level: 'int', resumed: 'bool' },
  word_rejected: { word: 'str', length: 'int', reason: 'str', attempt: 'int', ms_since_start: 'int' },
  level_end: {
    outcome: ['solved', 'abandoned'], mode: MODE, length: 'int', level: 'int',
    moves: 'arr', rejects: 'int', hints: 'int', ms: 'int', chain: 'arr', streak: 'int',
  },
  hint_used: {
    length: 'int', level: 'int', move_no: 'int', wallet_before: 'int',
    source: ['free', 'purchased', 'reward'],
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
  store_item_select: { item_id: 'str', price: 'num', currency: 'str' },
  purchase_result: {
    item_id: 'str', outcome: ['purchased', 'cancelled', 'unavailable', 'timeout'], ms: 'int',
  },
  store_close: { bought: 'bool', ms: 'int', items_seen: 'int' },
  wallet_sync: { credited: 'int', spent_local: 'int', drift: 'int' },
  purchase_credited: {
    source: 'str', item_id: 'str', hints: 'int', ad_free: 'bool', repeat: 'bool',
  },
  payment_rejected: { source: 'str', reason: 'str' },

  // Остальное
  screen_view: { screen: ['home', 'game', 'stats'], from: 'str' },
  share_click: { kind: ['puzzle', 'result'], method: ['platform', 'clipboard', 'browser'] },
  share_result: { kind: ['puzzle', 'result'], method: ['platform', 'clipboard', 'browser'], ok: 'bool' },
  settings_change: { key: ['sound', 'accent', 'theme'], value: 'str' },
  app_error: { where: 'str', message: 'str', fatal: 'bool' },
};

const isInt = (v) => Number.isInteger(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function coerce(spec, value) {
  if (Array.isArray(spec)) return spec.includes(value) ? value : undefined;
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
 */
function fit(props) {
  const keys = Object.keys(props);
  while (keys.length && JSON.stringify(props).length > MAX_PROPS_BYTES) {
    delete props[keys.pop()];
  }
  return props;
}

export function validate(name, props) {
  const shape = EVENTS[name];
  const source = props && typeof props === 'object' ? props : {};
  const out = {};

  if (!shape) {
    for (const [key, value] of Object.entries(source)) {
      const kept = loose(value);
      if (kept !== undefined) out[key] = kept;
    }
    return { known: false, props: fit(out) };
  }

  for (const [key, spec] of Object.entries(shape)) {
    if (!(key in source)) continue;
    const kept = coerce(spec, source[key]);
    if (kept !== undefined) out[key] = kept;
  }
  return { known: true, props: fit(out) };
}
