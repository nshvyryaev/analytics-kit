import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSqliteSink, openAnalyticsDb } from '../src/server/sinks/sqlite.mjs';

const session = (over = {}) => ({
  session_id: 'с1', app: 'word-chain', subject_id: 'ПС1', anon_subject: 'АН1',
  key_version: 1, platform: 'vk', verified: 1, app_version: 'abc', language: 'ru',
  os: 'android', mobile: 1, screen: 'sm', entry: 'direct', day: '2026-09-09',
  started_at: 1000, last_seen_at: 1000, ...over,
});

const event = (over = {}) => ({
  session_id: 'с1', seq: 1, name: 'level_start', ts: 1000, received_at: 1100,
  day: '2026-09-09', props: '{"length":5}', known: 1, ...over,
});

test('сессия пишется и заводит игрока', () => {
  const db = openAnalyticsDb(':memory:');
  createSqliteSink(db).session(session());
  const row = db.prepare('SELECT * FROM subjects WHERE subject_id = ?').get('ПС1');
  assert.equal(row.first_day, '2026-09-09');
  assert.equal(row.sessions, 1);
  db.close();
});

test('вторая сессия не меняет первый день, но считает сессии', () => {
  const db = openAnalyticsDb(':memory:');
  const sink = createSqliteSink(db);
  sink.session(session());
  sink.session(session({ session_id: 'с2', day: '2026-09-10' }));
  const row = db.prepare('SELECT * FROM subjects WHERE subject_id = ?').get('ПС1');
  assert.equal(row.first_day, '2026-09-09');
  assert.equal(row.last_day, '2026-09-10');
  assert.equal(row.sessions, 2);
  db.close();
});

test('день активности отмечается один раз', () => {
  const db = openAnalyticsDb(':memory:');
  const sink = createSqliteSink(db);
  sink.session(session());
  sink.session(session({ session_id: 'с2' }));
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM activity').get();
  assert.equal(n, 1);
  db.close();
});

test('повтор пачки не задваивает события', () => {
  const db = openAnalyticsDb(':memory:');
  const sink = createSqliteSink(db);
  sink.session(session());
  sink.events([event(), event({ seq: 2 })]);
  sink.events([event(), event({ seq: 2 })]);
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM events').get();
  assert.equal(n, 2);
  db.close();
});

test('сессия помнит последнее касание и число событий', () => {
  const db = openAnalyticsDb(':memory:');
  const sink = createSqliteSink(db);
  sink.session(session());
  sink.events([event({ received_at: 5000 }), event({ seq: 2, received_at: 5000 })]);
  const row = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get('с1');
  assert.equal(row.events, 2);
  assert.equal(row.last_seen_at, 5000);
  db.close();
});

test('события чужой сессии не пишутся', () => {
  const db = openAnalyticsDb(':memory:');
  const sink = createSqliteSink(db);
  sink.session(session());
  sink.events([event({ session_id: 'нет-такой' })]);
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM events').get();
  assert.equal(n, 0);
  db.close();
});
