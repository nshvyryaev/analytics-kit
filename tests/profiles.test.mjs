import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSqliteSink, openAnalyticsDb } from '../src/server/sinks/sqlite.mjs';
import { ROLLUP, rollup } from '../src/server/rollup.mjs';

const DAY = '2026-10-01';

function filled(app) {
  const db = openAnalyticsDb(':memory:');
  const sink = createSqliteSink(db);
  sink.session({
    session_id: 'с1', app, subject_id: 'П1', anon_subject: 'П1', key_version: 1,
    platform: 'vk', verified: 1, app_version: null, language: null, os: null, mobile: null,
    screen: null, entry: null, day: DAY, started_at: 1, last_seen_at: 1,
  });
  sink.events([
    { session_id: 'с1', seq: 1, name: 'level_end', ts: 1, received_at: 1, day: DAY, props: '{"outcome":"won","mode":"campaign","level":3}', known: 1 },
    { session_id: 'с1', seq: 2, name: 'level_end', ts: 1, received_at: 1, day: DAY, props: '{"outcome":"solved","length":5}', known: 1 },
    { session_id: 'с1', seq: 3, name: 'purchase_result', ts: 1, received_at: 1, day: DAY, props: '{"outcome":"purchased"}', known: 1 },
    { session_id: 'с1', seq: 4, name: 'purchase_credited', ts: 1, received_at: 1, day: DAY, props: '{"hints":5,"repeat":false}', known: 1 },
    { session_id: 'с1', seq: 5, name: 'нечто', ts: 1, received_at: 1, day: DAY, props: '{}', known: 0 },
  ]);
  rollup(db, DAY);
  const metrics = Object.fromEntries(
    db.prepare('SELECT metric, value FROM daily WHERE app = ? AND day = ?').all(app, DAY)
      .map((r) => [r.metric, r.value]),
  );
  const activity = db.prepare('SELECT levels_won, purchases, hints_bought FROM activity WHERE app = ? AND day = ?')
    .get(app, DAY);
  db.close();
  return { metrics, activity: { ...activity } };
}

const BARE_METRICS = {
  dau: 1, sessions: 1, level_end: 2, purchase_result: 1, purchase_credited: 1, events_unknown: 1,
};
const ZERO = { levels_won: 0, purchases: 0, hints_bought: 0 };

test('K-11: профиль IU — голые имена событий, dau, sessions; activity — только факт сессии', () => {
  const { metrics, activity } = filled('image-uncovered');
  assert.deepEqual(metrics, BARE_METRICS);
  assert.deepEqual(activity, ZERO);
});

test('K-11: приложение без профиля — только dau, sessions и голые имена', () => {
  const { metrics, activity } = filled('другое');
  assert.deepEqual(metrics, BARE_METRICS);
  assert.deepEqual(activity, ZERO);
});

test('K-11: профиль word-chain — прежние измерения и счётчики', () => {
  const { metrics, activity } = filled('word-chain');
  assert.equal(metrics['level_end:solved:5'], 1);
  // У word-chain нет length в событии IU — метрика сводится к голому имени.
  assert.equal(metrics.level_end, 1);
  assert.equal(metrics['purchase_result:purchased'], 1);
  assert.deepEqual(activity, { levels_won: 1, purchases: 1, hints_bought: 5 });
});

test('K-11: профиль IU называет пару для вывода концов уровня', () => {
  assert.deepEqual(ROLLUP['image-uncovered'].ends.map((p) => [p.start, p.end, p.key]),
    [['level_start', 'level_end', ['level_id', 'attempt']]]);
  assert.deepEqual(ROLLUP['word-chain'].ends, []);
});
