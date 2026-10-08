import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSqliteSink, openAnalyticsDb } from '../src/server/sinks/sqlite.mjs';
import { inferEnds, rollup } from '../src/server/index.mjs';

const APP = 'image-uncovered';
const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 1, 12);
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const START = {
  mode: 'campaign', campaign_id: 'c1', level: 3, level_id: 'c1-l3', lives: 3, attempt: 1,
};

function setup() {
  const db = openAnalyticsDb(':memory:');
  const sink = createSqliteSink(db);
  const open = (id, anon = 'А1', app = APP) => sink.session({
    session_id: id, app, subject_id: anon, anon_subject: anon, key_version: 1,
    platform: 'local', verified: 0, app_version: null, language: null, os: null, mobile: null,
    screen: null, entry: null, day: day(T0), started_at: T0, last_seen_at: T0,
  });
  const put = (session, seq, name, ts, props) => sink.events([{
    session_id: session, seq, name, ts, received_at: ts, day: day(ts), props: JSON.stringify(props), known: 1,
  }]);
  const ends = () => db.prepare(
    "SELECT session_id, seq, ts, day, props, known, dropped FROM events WHERE name = 'level_end' ORDER BY session_id, seq",
  ).all().map((r) => ({ ...r, props: JSON.parse(r.props) }));
  return { db, open, put, ends };
}

test('K-12: старт без конца получает level_end(abandoned, inferred) в сессии старта с seq = −seq', () => {
  const { db, open, put, ends } = setup();
  open('с1');
  put('с1', 4, 'level_start', T0, START);
  put('с1', 5, 'life_lost', T0 + 30_000, { mode: 'campaign', level: 3, level_id: 'c1-l3' });
  put('с1', 6, 'pause', T0 + 45_000, { ms: 1 });

  const result = inferEnds(db, { app: APP, olderThan: T0 + 24 * H, now: T0 + 25 * H });
  assert.deepEqual(result, { inferred: 1, removed: 0 });
  const [row] = ends();
  assert.equal(row.session_id, 'с1');
  assert.equal(row.seq, -4);
  assert.equal(row.ts, T0 + 45_000);
  assert.equal(row.day, day(T0));
  assert.equal(row.known, 1);
  assert.equal(row.dropped, null);
  assert.deepEqual(row.props, {
    outcome: 'abandoned', mode: 'campaign', campaign_id: 'c1', level: 3, level_id: 'c1-l3',
    ms: 45_000, attempt: 1, inferred: true,
  });
  db.close();
});

test('K-12: идемпотентность — два прогона дают одну строку', () => {
  const { db, open, put, ends } = setup();
  open('с1');
  put('с1', 1, 'level_start', T0, START);
  inferEnds(db, { app: APP, olderThan: T0 + 24 * H });
  const second = inferEnds(db, { app: APP, olderThan: T0 + 24 * H });
  assert.deepEqual(second, { inferred: 0, removed: 0 });
  assert.equal(ends().length, 1);
  db.close();
});

test('K-12: конец, пришедший через 3 дня в другой сессии, убирает дописанное', () => {
  const { db, open, put, ends } = setup();
  open('с1');
  put('с1', 1, 'level_start', T0, START);
  inferEnds(db, { app: APP, olderThan: T0 + 24 * H });
  assert.equal(ends().length, 1);

  open('с2');
  put('с2', 1, 'level_end', T0 + 72 * H, { outcome: 'won', level_id: 'c1-l3', attempt: 1, mode: 'campaign' });
  const result = inferEnds(db, { app: APP, olderThan: T0 + 96 * H });
  assert.deepEqual(result, { inferred: 0, removed: 1 });
  assert.deepEqual(ends().map((r) => [r.session_id, r.seq, r.props.outcome]), [['с2', 1, 'won']]);
  db.close();
});

test('K-12: отрицательный seq не конфликтует с клиентским', () => {
  const { db, open, put } = setup();
  open('с1');
  put('с1', 1, 'level_start', T0, START);
  inferEnds(db, { app: APP, olderThan: T0 + 24 * H });
  // Клиент дошлёт хвост той же сессии с seq 2, 3 — ключ (session_id, seq) свободен.
  put('с1', 2, 'pause', T0 + 1, { ms: 1 });
  const seqs = db.prepare("SELECT seq FROM events WHERE session_id = 'с1' ORDER BY seq").all().map((r) => r.seq);
  assert.deepEqual(seqs, [-1, 1, 2]);
  db.close();
});

test('K-12: свежий старт, другая попытка и другой аноним — по ключу и области', () => {
  const { db, open, put, ends } = setup();
  open('с1');
  open('с2', 'А2');
  put('с1', 1, 'level_start', T0, START);
  // Конец другой попытки того же уровня — не закрывает attempt 1.
  put('с1', 2, 'level_end', T0 + 1, { outcome: 'lost', level_id: 'c1-l3', attempt: 2 });
  // Конец того же ключа у другого анонима — не закрывает.
  put('с2', 1, 'level_end', T0 + 1, { outcome: 'won', level_id: 'c1-l3', attempt: 1 });
  // Свежий старт (моложе olderThan) — ещё не выводится.
  put('с1', 3, 'level_start', T0 + 30 * H, { ...START, attempt: 3 });

  const result = inferEnds(db, { app: APP, olderThan: T0 + 24 * H });
  assert.deepEqual(result, { inferred: 1, removed: 0 });
  assert.deepEqual(ends().filter((r) => r.seq < 0).map((r) => [r.session_id, r.seq]), [['с1', -1]]);
  db.close();
});

test('K-12: у приложения без пары в профиле inferEnds ничего не делает', () => {
  const { db, open, put, ends } = setup();
  open('с1', 'А1', 'word-chain');
  put('с1', 1, 'level_start', T0, { length: 5 });
  assert.deepEqual(inferEnds(db, { app: 'word-chain', olderThan: T0 + 24 * H }), { inferred: 0, removed: 0 });
  assert.equal(ends().length, 0);
  db.close();
});

test('K-12: дописанный конец попадает в свёртку дня', () => {
  const { db, open, put } = setup();
  open('с1');
  put('с1', 1, 'level_start', T0, START);
  inferEnds(db, { app: APP, olderThan: T0 + 24 * H });
  rollup(db, day(T0));
  const value = db.prepare("SELECT value FROM daily WHERE app = ? AND metric = 'level_end'").get(APP)?.value;
  assert.equal(value, 1);
  db.close();
});
