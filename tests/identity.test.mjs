import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anonSubject, playerSubject, subject } from '../src/server/identity.mjs';

const KEY = 'ключ-для-тестов';

test('один вход даёт один и тот же псевдоним', () => {
  assert.equal(playerSubject('vk', '12345', KEY), playerSubject('vk', '12345', KEY));
});

test('другой ключ даёт другой псевдоним', () => {
  assert.notEqual(playerSubject('vk', '12345', KEY), playerSubject('vk', '12345', 'другой'));
});

test('псевдоним — 22 символа base64url без набивки', () => {
  const value = playerSubject('vk', '12345', KEY);
  assert.equal(value.length, 22);
  assert.match(value, /^[A-Za-z0-9_-]{22}$/);
});

test('площадки не сталкиваются между собой', () => {
  assert.notEqual(playerSubject('vk', '1', KEY), playerSubject('ok', '1', KEY));
});

test('анонимное пространство не сталкивается с игроком', () => {
  assert.notEqual(anonSubject('vk:1', KEY), playerSubject('vk', '1', KEY));
});

test('пустой ключ — это ошибка, а не «считать без ключа»', () => {
  assert.throws(() => subject('vk:1', ''), /ключ/);
});
