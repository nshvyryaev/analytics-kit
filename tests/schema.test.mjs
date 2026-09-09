import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, MAX_STR, MAX_PROPS_BYTES, MAX_UNKNOWN_KEYS } from '../src/schema.mjs';

test('известное событие сохраняет объявленные свойства', () => {
  const out = validate('level_start', { mode: 'daily', length: 5, level: 3, resumed: false });
  assert.equal(out.known, true);
  assert.deepEqual(out.props, { mode: 'daily', length: 5, level: 3, resumed: false });
});

test('неизвестное имя принимается, но помечается', () => {
  const out = validate('нет_такого', { a: 1 });
  assert.equal(out.known, false);
});

test('необъявленный ключ у известного события отбрасывается', () => {
  const out = validate('level_start', { mode: 'daily', лишнее: 'да' });
  assert.equal('лишнее' in out.props, false);
});

test('свойство неверного типа отбрасывается, остальные целы', () => {
  const out = validate('level_start', { mode: 'daily', length: 'пять' });
  assert.equal(out.props.mode, 'daily');
  assert.equal('length' in out.props, false);
});

test('значение вне перечисления отбрасывается', () => {
  const out = validate('level_start', { mode: 'выдумка' });
  assert.equal('mode' in out.props, false);
});

test('длинная строка обрезается', () => {
  const out = validate('app_error', { where: 'x'.repeat(200), fatal: true });
  assert.equal(out.props.where.length, MAX_STR);
});

test('слишком большие свойства урезаются до предела', () => {
  const out = validate('level_end', { chain: Array.from({ length: 500 }, () => 'СЛОВО') });
  assert.ok(JSON.stringify(out.props).length <= 2048);
});

test('незнакомое событие с тысячами ключей обрабатывается быстро и режется до потолка', () => {
  const source = {};
  for (let i = 0; i < 5000; i += 1) source[`key${i}`] = i;

  const started = Date.now();
  const out = validate('нет_такого', source);
  const elapsed = Date.now() - started;

  assert.equal(out.known, false);
  assert.ok(Object.keys(out.props).length <= MAX_UNKNOWN_KEYS);
  // Без потолка на число ключей fit() пересериализует убывающий объект на
  // каждый удаляемый ключ — O(n²) от размера тела запроса. С потолком в 32
  // ключа обработка тела в 5000 ключей укладывается в доли секунды даже на
  // медленной машине; секунда — заведомо щедрый запас.
  assert.ok(elapsed < 1000, `validate() занял ${elapsed}мс на 5000 ключей`);
});

test('предел меряется в байтах UTF-8, а не в единицах длины строки', () => {
  // 'ё' — одна единица длины JS-строки (UTF-16), но два байта в UTF-8.
  // При такой длине результат укладывается в лимит по .length, но почти
  // вдвое превышает его в байтах: проверка через .length пропустила бы
  // это без урезания, проверка через TextEncoder — обязана урезать.
  const big = 'ё'.repeat(1100);
  const out = validate('level_end', { chain: [big], streak: 5 });
  const bytes = new TextEncoder().encode(JSON.stringify(out.props)).length;
  assert.ok(bytes <= MAX_PROPS_BYTES);
  assert.equal('streak' in out.props, false);
});
