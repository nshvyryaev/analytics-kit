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

test('счётчик побед не проседает при повторной свёртке после отсечки старого дня', () => {
  // Регрессия: прежний пересчёт levels_won читал COUNT(*) прямо из events без
  // ограничения по дню. Это не ловится свёрткой одного дня и уж тем более не
  // ловится вызовом prune() самим по себе — prune никогда не трогал subjects,
  // поэтому "свернуть — отсечь — проверить, что не изменилось" проходит
  // одинаково что на старом, что на новом коде и ничего не доказывает. Баг
  // проявляется только на СЛЕДУЮЩЕЙ свёртке ПОСЛЕ отсечки: пересчёт берёт
  // COUNT по уже урезанному events и теряет победы из отсечённых дней.
  const OLD_DAY = '2026-08-01';
  const NEW_DAY = '2026-09-09';
  const db = openAnalyticsDb(':memory:');
  const sink = createSqliteSink(db);
  const session = (id, day) => ({
    session_id: id, app: 'word-chain', subject_id: 'ПС1', anon_subject: 'ПС1',
    key_version: 1, platform: 'vk', verified: 1, app_version: 'abc', language: 'ru',
    os: 'android', mobile: 1, screen: 'sm', entry: 'direct', day,
    started_at: 1000, last_seen_at: 1000,
  });
  sink.session(session('старая', OLD_DAY));
  sink.session(session('свежая', NEW_DAY));
  sink.events([
    { session_id: 'старая', seq: 1, name: 'level_end', ts: 1, received_at: 1, day: OLD_DAY, props: '{"outcome":"solved"}', known: 1 },
  ]);
  sink.events([
    { session_id: 'свежая', seq: 1, name: 'level_end', ts: 1, received_at: 1, day: NEW_DAY, props: '{"outcome":"solved"}', known: 1 },
  ]);

  // 1-2. Победа в старый день и победа в свежий — сворачиваем оба дня.
  rollup(db, OLD_DAY);
  rollup(db, NEW_DAY);
  const total = () => db.prepare('SELECT levels_won FROM subjects WHERE subject_id = ?').get('ПС1').levels_won;
  assert.equal(total(), 2);

  // 3. Отсекаем сырьё так, чтобы старый день ушёл, а свежий остался.
  const removed = prune(db, { before: NEW_DAY });
  assert.ok(removed.events > 0);

  // 4-5. Свёртка свежего дня ЕЩЁ РАЗ, уже после отсечки старого — счётчик
  // должен остаться 2, а не просесть до 1 из-за потери отсечённой победы.
  rollup(db, NEW_DAY);
  assert.equal(total(), 2);
  db.close();
});

test('незнакомое событие не подделывает метрику по исходу', () => {
  // Событие с именем, буквально равным составному ключу метрики, но пришедшее
  // как незнакомое (known = 0), не должно сливаться с настоящей агрегацией
  // по исходу — иначе клиент подделывает деловую метрику мимо словаря.
  const db = filled();
  const sink = createSqliteSink(db);
  sink.events([
    { session_id: 'с1', seq: 3, name: 'level_end:solved', ts: 1, received_at: 1, day: DAY, props: '{}', known: 0 },
  ]);
  rollup(db, DAY);
  assert.equal(metric(db, 'level_end:solved'), 2);
  assert.equal(metric(db, 'events_unknown'), 1);
  db.close();
});
