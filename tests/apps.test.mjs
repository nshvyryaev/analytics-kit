import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  APPS, COMMON, DEFAULT_APP, EVENTS, dictionary, validate,
} from '../src/schema.mjs';

const WORD_CHAIN_V028 = JSON.parse(
  readFileSync(new URL('./fixtures/word-chain-v0.2.8.json', import.meta.url), 'utf8'),
);

/** Имена событий ImageUncovered — data.md §7 (общие с word-chain + раздел IU). */
const IU_NAMES = [
  // общие
  'app_ready', 'platform_fallback', 'pause', 'resume', 'session_end', 'app_error',
  'store_item_select', 'purchase_result', 'purchase_credited', 'payment_rejected',
  // раздел image-uncovered
  'level_load', 'net_error', 'screen_view', 'campaign_select', 'settings_change',
  'run_start', 'level_start', 'life_lost', 'level_end', 'continue_choice', 'run_end',
  'ad_request', 'ad_result', 'ad_skipped', 'store_open', 'auth_prompt', 'auth_result',
  'nick_prompt', 'nick_result', 'score_submit', 'score_rejected', 'vote_prompt', 'vote_result',
];

test('словарь word-chain совпадает со словарём v0.2.8 байт в байт', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(dictionary('word-chain'))), WORD_CHAIN_V028);
  assert.equal(DEFAULT_APP, 'word-chain');
  assert.equal(EVENTS, dictionary('word-chain'));
});

test('validate без приложения — это validate для word-chain', () => {
  const props = { mode: 'daily', length: 5, level: 3, resumed: false };
  assert.deepEqual(validate('level_start', props), validate('level_start', props, 'word-chain'));
});

test('список событий image-uncovered равен словарю data §7 (33 события)', () => {
  const names = Object.keys(dictionary('image-uncovered'));
  assert.deepEqual([...names].sort(), [...IU_NAMES].sort());
  assert.equal(names.length, 33);
});

test('раздел приложения перекрывает общее событие целиком', () => {
  // У IU начисление без подсказок, у word-chain — с ними.
  assert.deepEqual(dictionary('image-uncovered').purchase_credited, COMMON.purchase_credited);
  assert.equal('hints' in dictionary('word-chain').purchase_credited, true);
  const iu = validate('purchase_credited', { source: 'yandex', item_id: 'life-1', repeat: false, hints: 5 }, 'image-uncovered');
  assert.deepEqual(iu.props, { source: 'yandex', item_id: 'life-1', repeat: false });
  // Поле word-chain у одноимённого события IU не объявлено.
  const start = validate('level_start', { mode: 'campaign', length: 5, level: 1 }, 'image-uncovered');
  assert.deepEqual(start.props, { mode: 'campaign', level: 1 });
});

test('событие чужого раздела незнакомо, общее — знакомо всем', () => {
  assert.equal(validate('level_load', { mode: 'campaign' }, 'word-chain').known, false);
  assert.equal(validate('hint_used', { length: 4 }, 'image-uncovered').known, false);
  assert.equal(validate('app_ready', { ms_to_ready: 1 }, 'image-uncovered').known, true);
});

test('приложение без раздела получает только общую часть', () => {
  assert.equal(dictionary('нет-такого'), COMMON);
  assert.equal(validate('pause', { ms: 1 }, 'нет-такого').known, true);
  assert.equal(validate('level_start', { level: 1 }, 'нет-такого').known, false);
  // Имя события, совпадающее со свойством прототипа, — не событие.
  assert.equal(validate('constructor', {}, 'image-uncovered').known, false);
});

/** Допустимое значение для каждого вида объявления. */
function sample(spec) {
  if (Array.isArray(spec)) return spec[0];
  if (spec && typeof spec === 'object' && spec.kind === 'range') return spec.min;
  return { int: 3, num: 1.5, bool: true, str: 'x', arr: [] }[spec];
}

for (const [name, shape] of Object.entries(dictionary('image-uncovered'))) {
  test(`image-uncovered: ${name} — все свойства и все значения перечислений проходят`, () => {
    const full = Object.fromEntries(Object.entries(shape).map(([key, spec]) => [key, sample(spec)]));
    const out = validate(name, full, 'image-uncovered');
    assert.equal(out.known, true);
    assert.deepEqual(out.props, full);

    for (const [key, spec] of Object.entries(shape)) {
      if (Array.isArray(spec)) {
        for (const value of spec) {
          assert.equal(validate(name, { [key]: value }, 'image-uncovered').props[key], value, `${key}=${value}`);
        }
        assert.equal(key in validate(name, { [key]: 'выдумка' }, 'image-uncovered').props, false);
      } else if (spec && typeof spec === 'object' && spec.kind === 'range') {
        for (const value of [spec.min, spec.max]) {
          assert.equal(validate(name, { [key]: value }, 'image-uncovered').props[key], value, `${key}=${value}`);
        }
        for (const value of [spec.min - 1, spec.max + 1, spec.min + 0.5]) {
          assert.equal(key in validate(name, { [key]: value }, 'image-uncovered').props, false, `${key}=${value}`);
        }
      }
    }
  });
}

test('диапазоны раздела image-uncovered — по data §7', () => {
  const iu = dictionary('image-uncovered');
  assert.deepEqual(iu.level_start.level, { kind: 'range', min: 1, max: 99999 });
  assert.deepEqual(iu.life_lost.coverage_pct, { kind: 'range', min: 0, max: 100 });
  assert.deepEqual(iu.run_start.lives, { kind: 'range', min: 0, max: 7 });
  assert.deepEqual(iu.vote_result.liked, { kind: 'range', min: 1, max: 5 });
  assert.deepEqual(iu.level_start.mode, ['campaign', 'endless', 'daily', 'custom']);
});

test('разделы объявлены для обоих приложений', () => {
  assert.deepEqual(Object.keys(APPS).sort(), ['image-uncovered', 'word-chain']);
});
