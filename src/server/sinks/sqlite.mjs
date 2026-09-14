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
    -- Признак серверного происхождения — НЕ entry. entry пишется из тела
    -- запроса (ctx.entry) и потому клиент им управляет; признак, на который
    -- опираются подсчёт аудитории и прирост sessions у игрока, обязан быть
    -- недостижим для клиента по устройству, а не по проверке значения. Этот
    -- столбец приёмник заполняет сам (receiver.mjs: session() всегда 0,
    -- serverSession()/playerServerSession() всегда 1) — из тела запроса он
    -- не читается никогда. NOT NULL с умолчанием 0, а не NULL с проверкой
    -- IS/IS NOT: обычная сессия не должна требовать особого NULL-safe
    -- сравнения нигде, где этот столбец используется.
    server_origin INTEGER NOT NULL DEFAULT 0,
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
    app          TEXT NOT NULL,
    day          TEXT NOT NULL,
    subject_id   TEXT NOT NULL,
    -- Подневные счётчики игрока. Живут здесь, а не только в events, потому
    -- что activity устроена как «приложение × день × игрок» и переживает
    -- отсечку сырья по построению — на ней и так стоит ретеншен.
    levels_won   INTEGER NOT NULL DEFAULT 0,
    purchases    INTEGER NOT NULL DEFAULT 0,
    hints_bought INTEGER NOT NULL DEFAULT 0,
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
 * Столбцы, которых не было в первом релизе схемы и которые появились уже на
 * действующей базе потребителя. `CREATE TABLE IF NOT EXISTS` выше создаёт
 * таблицу только когда её нет вовсе — если она уже существует (хоть в самом
 * первом составе столбцов), команда не делает ничего, состав не сверяется и
 * не дополняется. На пустой (новой) базе `SCHEMA` и так создаёт актуальный
 * состав, поэтому этот список нужен только тем, у кого база уже была ДО
 * появления столбца — но именно ради них миграция обязана жить в самой
 * библиотеке: потребитель может не заметить смену минорной версии в
 * `package.json`, и «прочитай CHANGELOG и сам добавь столбец» — это способ
 * гарантированно словить падение уже в проде на первом запросе, который его
 * коснётся.
 *
 * Формат — таблица → список [имя, определение для ADD COLUMN]. Следующая
 * смена состава столбцов сводится к дописыванию строки сюда, а не к новому
 * куску кода: `migrate()` ниже — общий проход по этому списку, а не разовая
 * заплатка под один столбец. Столбцы, которые уже есть в таблице, `migrate`
 * не трогает вовсе (проверяется по `PRAGMA table_info`) — переписывать или
 * переопределять существующий состав не входит в её задачу.
 */
const MIGRATIONS = {
  sessions: [
    // v0.2.2: server_origin — признак серверного происхождения сессии,
    // который ставит только приёмник и никогда не читает из тела запроса
    // (см. комментарий у столбца в SCHEMA выше). NOT NULL без DEFAULT
    // `ALTER TABLE ADD COLUMN` в SQLite не принимает — колонку нужно чем-то
    // заполнить в уже существующих строках без явного значения, поэтому
    // умолчание обязательно синтаксически. Здесь оно и по смыслу верное:
    // все строки, заведённые до появления этого столбца, — клиентские
    // сессии (серверные псевдосессии с этим полем появились в том же
    // релизе, что и сам столбец), так что 0 для них не запись «неизвестно»,
    // а точный факт.
    ['server_origin', 'INTEGER NOT NULL DEFAULT 0'],
  ],
};

/**
 * Сверяет фактический состав столбцов таблиц из `MIGRATIONS` с ожидаемым и
 * дописывает недостающие через `ALTER TABLE ... ADD COLUMN`. Идемпотентна:
 * на базе, где столбец уже есть (новая база, где его создал `SCHEMA`, или
 * база, которую уже migrate() дополнял раньше), `PRAGMA table_info` покажет
 * его существующим, и повторный `ALTER TABLE` не выполнится.
 */
function migrate(db) {
  for (const [table, columns] of Object.entries(MIGRATIONS)) {
    const existing = new Set(
      db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name),
    );
    for (const [name, definition] of columns) {
      if (!existing.has(name)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
      }
    }
  }
}

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
  migrate(db);
  return db;
}

export function createSqliteSink(db) {
  const insertSession = db.prepare(
    `INSERT OR IGNORE INTO sessions
       (session_id, app, subject_id, anon_subject, key_version, platform, verified,
        app_version, language, os, mobile, screen, entry, server_origin, day, started_at, last_seen_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  // Прирост `sessions` — параметр, а не зашитая единица: серверная
  // псевдосессия, привязанная к игроку (analytics-kit v0.2.0, receiver.mjs
  // playerServerSession), не должна считаться настоящим заходом игрока — он
  // мог в этот день вовсе не открывать игру, только купить. Прирост 0 для
  // таких строк (server_origin = 1) оставляет счётчик заходов верным, при
  // этом сама строка subjects всё равно заводится/обновляется — first_day/
  // last_day ей всё равно нужны.
  //
  // Смотрим на `server_origin`, а не на `entry`: `entry` пишется из тела
  // запроса, и до этой правки признак доверия жил именно там — площадка
  // могла прислать ctx.entry = 'server' с валидной подписью и вычесть себя
  // из аудитории, оставшись в числителе событий. `server_origin` приёмник
  // выставляет сам и никогда не читает из запроса (см. схему в SCHEMA).
  const upsertSubject = db.prepare(
    `INSERT INTO subjects (app, subject_id, first_day, last_day, platform, sessions)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT (app, subject_id) DO UPDATE SET
       last_day = MAX(last_day, excluded.last_day),
       sessions = sessions + excluded.sessions`,
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
      try {
        db.exec('BEGIN');
        const result = insertSession.run(
          row.session_id, row.app, row.subject_id, row.anon_subject, row.key_version,
          row.platform, row.verified, row.app_version, row.language, row.os,
          row.mobile, row.screen, row.entry, row.server_origin ? 1 : 0,
          row.day, row.started_at, row.last_seen_at,
        );
        // Повтор той же строки сессии (тот же session_id) — не ошибка: у
        // площадки нет способа отличить потерянный ответ от необработанного
        // запроса, и клиент вправе повторить вызов. INSERT OR IGNORE уже не
        // задваивает саму запись в sessions, но subjects/activity/aliases —
        // производные от неё, и их обновление должно случиться ровно один раз
        // на session_id, а не на вызов, иначе счётчик sessions у игрока
        // раздуется на повтор, которого сам игрок не делал.
        if (result.changes === 0) {
          db.exec('COMMIT');
          return;
        }
        upsertSubject.run(row.app, row.subject_id, row.day, row.day, row.platform, row.server_origin ? 0 : 1);
        // markActivity — без исключения по server_origin: подневные счётчики в activity
        // ради этого и заводились (см. playerServerSession в receiver.mjs) —
        // покупка это тоже присутствие игрока в этот день, даже если он не
        // открывал саму игру. Цена решения: день, в который игрок только
        // купил, засчитается активным.
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

      try {
        db.exec('BEGIN');
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
