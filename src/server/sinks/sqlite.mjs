/**
 * Хранилище событий. Отдельный файл базы — не аккуратность, а требование:
 * приёмник живёт в процессе, который принимает деньги, и переезд статистики на
 * свой сервер должен стоить перенос файла, а не разделение таблиц.
 *
 * Три слоя с разным сроком жизни. Сырьё живёт тридцать суток и отсекается;
 * `subjects` и `activity` живут вечно, потому что на них стоит ретеншен, и
 * глубина ретеншена не должна зависеть от глубины сырья.
 */
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sessions (
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
  CREATE INDEX IF NOT EXISTS sessions_day     ON sessions (app, day);
  CREATE INDEX IF NOT EXISTS sessions_subject ON sessions (app, subject_id);

  CREATE TABLE IF NOT EXISTS events (
    session_id  TEXT    NOT NULL,
    seq         INTEGER NOT NULL,
    name        TEXT    NOT NULL,
    ts          INTEGER NOT NULL,
    received_at INTEGER NOT NULL,
    day         TEXT    NOT NULL,
    props       TEXT,
    known       INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (session_id, seq),
    FOREIGN KEY (session_id) REFERENCES sessions (session_id)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS events_day_name ON events (day, name);

  CREATE TABLE IF NOT EXISTS subjects (
    app          TEXT NOT NULL,
    subject_id   TEXT NOT NULL,
    first_day    TEXT NOT NULL,
    last_day     TEXT NOT NULL,
    platform     TEXT NOT NULL,
    sessions     INTEGER NOT NULL DEFAULT 0,
    levels_won   INTEGER NOT NULL DEFAULT 0,
    purchases    INTEGER NOT NULL DEFAULT 0,
    hints_bought INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (app, subject_id)
  );

  CREATE TABLE IF NOT EXISTS aliases (
    app          TEXT NOT NULL,
    anon_subject TEXT NOT NULL,
    subject_id   TEXT NOT NULL,
    PRIMARY KEY (app, anon_subject, subject_id)
  );

  CREATE TABLE IF NOT EXISTS activity (
    app        TEXT NOT NULL,
    day        TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    PRIMARY KEY (app, day, subject_id)
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS daily (
    app      TEXT NOT NULL,
    day      TEXT NOT NULL,
    platform TEXT NOT NULL,
    metric   TEXT NOT NULL,
    value    REAL NOT NULL,
    PRIMARY KEY (app, day, platform, metric)
  ) WITHOUT ROWID;
`;

/**
 * Кэш страниц задан явно и мал. На машине с 1967 МБ памяти база аналитики
 * иначе вытеснит кэш платёжной, а платежи важнее статистики.
 */
export function openAnalyticsDb(file = ':memory:', { cachePages = 2000 } = {}) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`PRAGMA cache_size = ${cachePages}`);
  db.exec(SCHEMA);
  return db;
}

export function createSqliteSink(db) {
  const insertSession = db.prepare(
    `INSERT OR IGNORE INTO sessions
       (session_id, app, subject_id, anon_subject, key_version, platform, verified,
        app_version, language, os, mobile, screen, entry, day, started_at, last_seen_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const upsertSubject = db.prepare(
    `INSERT INTO subjects (app, subject_id, first_day, last_day, platform, sessions)
     VALUES (?,?,?,?,?,1)
     ON CONFLICT (app, subject_id) DO UPDATE SET
       last_day = MAX(last_day, excluded.last_day),
       sessions = sessions + 1`,
  );
  const markActivity = db.prepare(
    'INSERT OR IGNORE INTO activity (app, day, subject_id) VALUES (?,?,?)',
  );
  const linkAlias = db.prepare(
    'INSERT OR IGNORE INTO aliases (app, anon_subject, subject_id) VALUES (?,?,?)',
  );
  const insertEvent = db.prepare(
    `INSERT OR IGNORE INTO events (session_id, seq, name, ts, received_at, day, props, known)
     VALUES (?,?,?,?,?,?,?,?)`,
  );
  const touchSession = db.prepare(
    `UPDATE sessions SET last_seen_at = MAX(last_seen_at, ?), events = events + ?
     WHERE session_id = ?`,
  );
  const sessionExists = db.prepare('SELECT 1 AS found FROM sessions WHERE session_id = ?');

  return {
    session(row) {
      db.exec('BEGIN');
      try {
        insertSession.run(
          row.session_id, row.app, row.subject_id, row.anon_subject, row.key_version,
          row.platform, row.verified, row.app_version, row.language, row.os,
          row.mobile, row.screen, row.entry, row.day, row.started_at, row.last_seen_at,
        );
        upsertSubject.run(row.app, row.subject_id, row.day, row.day, row.platform);
        markActivity.run(row.app, row.day, row.subject_id);
        // Псевдоним от анонимного идентификатора и псевдоним игрока — один
        // человек. Без этой связи каждый первый запуск выглядит как два разных.
        if (row.anon_subject !== row.subject_id) {
          linkAlias.run(row.app, row.anon_subject, row.subject_id);
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },

    events(rows) {
      if (rows.length === 0) return 0;
      const sessionId = rows[0].session_id;
      // События без своей сессии писать некуда: внешний ключ их всё равно не
      // пустит, а падать на чужом идентификаторе незачем — он приходит извне.
      if (!sessionExists.get(sessionId)) return 0;

      db.exec('BEGIN');
      try {
        let written = 0;
        let latest = 0;
        for (const row of rows) {
          if (row.session_id !== sessionId) continue;
          const result = insertEvent.run(
            row.session_id, row.seq, row.name, row.ts, row.received_at,
            row.day, row.props, row.known,
          );
          written += result.changes;
          latest = Math.max(latest, row.received_at);
        }
        touchSession.run(latest, written, sessionId);
        db.exec('COMMIT');
        return written;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },

    close() {
      db.close();
    },
  };
}
