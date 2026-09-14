import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteSink, openAnalyticsDb } from '../src/server/sinks/sqlite.mjs';
import { createReceiver } from '../src/server/receiver.mjs';

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

test('повтор одной и той же сессии не задваивает счётчик игрока', () => {
  const db = openAnalyticsDb(':memory:');
  const sink = createSqliteSink(db);
  const row = session();
  sink.session(row);
  sink.session(row);
  const subject = db.prepare('SELECT * FROM subjects WHERE subject_id = ?').get('ПС1');
  assert.equal(subject.sessions, 1);
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

test('серверная псевдосессия (server_origin = 1) не увеличивает счётчик заходов игрока, но отмечает день активности', () => {
  const db = openAnalyticsDb(':memory:');
  const sink = createSqliteSink(db);
  sink.session(session({ session_id: 'с2', entry: 'server', server_origin: 1 }));
  const subject = db.prepare('SELECT sessions FROM subjects WHERE subject_id = ?').get('ПС1');
  assert.equal(subject.sessions, 0);
  const activity = db.prepare('SELECT 1 AS found FROM activity WHERE subject_id = ?').get('ПС1');
  assert.ok(activity);
  db.close();
});

test('обычная и серверная сессии одного игрока: sessions считает только обычные', () => {
  const db = openAnalyticsDb(':memory:');
  const sink = createSqliteSink(db);
  sink.session(session());
  sink.session(session({ session_id: 'с2', entry: 'server', server_origin: 1 }));
  sink.session(session({ session_id: 'с3' }));
  const subject = db.prepare('SELECT sessions FROM subjects WHERE subject_id = ?').get('ПС1');
  assert.equal(subject.sessions, 2);
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

test('база со старой схемой (без server_origin) получает столбец при открытии и не падает', () => {
  // Круг 3 ревью: `SCHEMA` строится на CREATE TABLE IF NOT EXISTS, а на уже
  // существующей базе эта команда не делает ничего — состав столбцов не
  // сверяется. Ревьюер воспроизвёл прогоном: база создана кодом v0.1.4 (до
  // появления server_origin), эту же базу открывает код v0.2.2 — открытие
  // проходит молча, а падает createSqliteSink() при подготовке INSERT,
  // ссылающегося на несуществующий столбец ("table sessions has no column
  // named server_origin"). Строим старую базу вручную литералом (а не через
  // старый тег), чтобы тест не зависел от того, доступен ли тег локально, и
  // явно фиксировал именно тот состав столбцов, который был до этой правки.
  const dir = mkdtempSync(join(tmpdir(), 'sqlite-migrate-'));
  const file = join(dir, 'old.db');

  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE sessions (
      session_id   TEXT PRIMARY KEY,
      app          TEXT    NOT NULL,
      subject_id   TEXT    NOT NULL,
      anon_subject TEXT    NOT NULL,
      key_version  INTEGER NOT NULL,
      platform     TEXT    NOT NULL,
      verified     INTEGER NOT NULL,
      app_version  TEXT,
      language     TEXT,
      os           TEXT,
      mobile       INTEGER,
      screen       TEXT,
      entry        TEXT,
      day          TEXT    NOT NULL,
      started_at   INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      events       INTEGER NOT NULL DEFAULT 0
    );
  `);
  old.prepare(
    `INSERT INTO sessions
       (session_id, app, subject_id, anon_subject, key_version, platform, verified,
        app_version, language, os, mobile, screen, entry, day, started_at, last_seen_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run('старая', 'word-chain', 'ПС0', 'ПС0', 1, 'vk', 1, null, null, null, null, null, 'direct', '2026-09-01', 1, 1);
  old.close();

  // Открываем ТУ ЖЕ базу текущим кодом — та самая точка, которую до этой
  // правки нужно было обкладывать try/catch на стороне потребителя.
  const db = openAnalyticsDb(file);
  const columns = db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
  assert.ok(columns.includes('server_origin'));

  // Строка, заведённая до появления столбца, получила 0 — не NULL и не
  // падение на отсутствующем значении: это точный факт (все такие строки —
  // клиентские сессии), а не заглушка "неизвестно".
  const oldRow = db.prepare('SELECT server_origin FROM sessions WHERE session_id = ?').get('старая');
  assert.equal(oldRow.server_origin, 0);

  // Библиотека на такой базе не просто открывается — она работает: и синк,
  // подготовка запросов которого раньше падала первой, и приёмник поверх
  // него, — оба создаются и пишут новую сессию без исключений.
  const sink = createSqliteSink(db);
  const receiver = createReceiver({
    sink, key: 'ключ', apps: ['word-chain'], verify: () => ({ ok: false }),
  });
  const out = receiver.session({ app: 'word-chain', anon_id: 'новая', ctx: {} });
  assert.equal(out.status, 200);
  const newRow = db.prepare('SELECT server_origin FROM sessions WHERE session_id = ?').get(out.body.session_id);
  assert.equal(newRow.server_origin, 0);

  db.close();
  rmSync(dir, { recursive: true, force: true });
});
