import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSqliteSink, openAnalyticsDb } from '../src/server/sinks/sqlite.mjs';
import { prune, rollup } from '../src/server/rollup.mjs';

const DAY = '2026-09-09';

function filled() {
  const db = openAnalyticsDb(':memory:');
  const sink = createSqliteSink(db);
  for (const [id, subject] of [['с1', 'ПС1'], ['с2', 'ПС2'], ['с3', 'ПС1']]) {
    sink.session({
      session_id: id, app: 'word-chain', subject_id: subject, anon_subject: subject,
      key_version: 1, platform: 'vk', verified: 1, app_version: 'abc', language: 'ru',
      os: 'android', mobile: 1, screen: 'sm', entry: 'direct', day: DAY,
      started_at: 1000, last_seen_at: 1000,
    });
  }
  sink.events([
    { session_id: 'с1', seq: 1, name: 'level_end', ts: 1, received_at: 1, day: DAY, props: '{"outcome":"solved"}', known: 1 },
    { session_id: 'с1', seq: 2, name: 'level_end', ts: 1, received_at: 1, day: DAY, props: '{"outcome":"abandoned"}', known: 1 },
  ]);
  sink.events([
    { session_id: 'с2', seq: 1, name: 'level_end', ts: 1, received_at: 1, day: DAY, props: '{"outcome":"solved"}', known: 1 },
  ]);
  return db;
}

const metric = (db, name) =>
  db.prepare('SELECT value FROM daily WHERE app = ? AND day = ? AND metric = ?')
    .get('word-chain', DAY, name)?.value;

test('свёртка считает игроков за день, а не сессии', () => {
  const db = filled();
  rollup(db, DAY);
  assert.equal(metric(db, 'dau'), 2);
  assert.equal(metric(db, 'sessions'), 3);
  db.close();
});

test('свёртка разбивает событие по исходу', () => {
  const db = filled();
  rollup(db, DAY);
  assert.equal(metric(db, 'level_end:solved'), 2);
  assert.equal(metric(db, 'level_end:abandoned'), 1);
  db.close();
});

test('повторная свёртка того же дня не задваивает', () => {
  const db = filled();
  rollup(db, DAY);
  rollup(db, DAY);
  assert.equal(metric(db, 'dau'), 2);
  db.close();
});

test('свёртка обновляет счётчик побед у игрока', () => {
  const db = filled();
  rollup(db, DAY);
  const row = db.prepare('SELECT levels_won FROM subjects WHERE subject_id = ?').get('ПС1');
  assert.equal(row.levels_won, 1);
  db.close();
});

test('отсечка убирает сырьё, но оставляет игроков и активность', () => {
  const db = filled();
  rollup(db, DAY);
  const removed = prune(db, { before: '2026-10-10' });
  assert.ok(removed.events > 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM subjects').get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM activity').get().n, 2);
  assert.equal(metric(db, 'dau'), 2);
  db.close();
});
