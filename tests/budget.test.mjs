import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

/**
 * Бюджет транспорта: `client.mjs` — единственный файл kit в бандле игры, и
 * он должен укладываться в 3 КБ gzip.
 *
 * Меряем код без комментариев, а не сырой файл: сборка игры минифицирует
 * бандл, комментарии до игрока не доезжают, а сырой файл с подробными
 * комментариями превысил бы бюджет, ничего не прибавив в бандле (Сп-1:
 * сырой — 3 925 Б, прирост сборки — 1,6 КБ). Минификатор не тянем ради
 * одного теста: снимаем комментарии и отступы маленьким сканером, который
 * знает про строки и шаблоны, чтобы не принять `//` внутри строки за
 * комментарий.
 */
function stripComments(source) {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
    } else if (c === '/' && next === '*') {
      i = source.indexOf('*/', i + 2) + 2;
    } else if (c === '"' || c === "'" || c === '`') {
      const start = i;
      i += 1;
      while (i < source.length && source[i] !== c) i += source[i] === '\\' ? 2 : 1;
      i += 1;
      out += source.slice(start, i);
    } else {
      out += c;
      i += 1;
    }
  }
  // Отступы и пустые строки минификатор тоже снимает.
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

test('сканер снимает комментарии, но не трогает строки', () => {
  const code = "const a = '//не комментарий'; // комментарий\n/* блок */ const b = `x/*y*/`;";
  assert.equal(stripComments(code), "const a = '//не комментарий';\nconst b = `x/*y*/`;");
});

test('client.mjs без комментариев — не больше 3 КБ gzip', () => {
  const source = readFileSync(new URL('../src/browser/client.mjs', import.meta.url), 'utf8');
  const size = gzipSync(stripComments(source)).length;
  assert.ok(size <= 3072, `client.mjs: ${size} Б gzip, бюджет 3072`);
});
