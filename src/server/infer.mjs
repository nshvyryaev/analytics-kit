/**
 * Вывод потерянных концов (K-12).
 *
 * Клиент шлёт конец попытки сам (выход в меню, `pagehide`), но вебвью могут
 * убить без `pagehide` — и тогда старт остаётся без конца навсегда, а воронка
 * «начал → закончил» врёт. Ночное обслуживание зовёт `inferEnds`: для каждого
 * старта старше `olderThan`, у которого нет конца с тем же ключом попытки ни в
 * одной сессии того же анонима, дописывается конец с полями из профиля
 * (`outcome: 'abandoned', inferred: true`).
 *
 * Дописанная строка лежит в сессии старта с `seq = −seq старта`: клиентские
 * номера положительны, поэтому ключ `(session_id, seq)` с ними не
 * пересекается, а повторный прогон упирается в тот же ключ и ничего не
 * задваивает (`INSERT OR IGNORE`). Если настоящий конец пришёл позже (хвост
 * очереди через несколько дней, в другой сессии), следующий прогон
 * дописанное удаляет — в отчётах пара по ключу одна.
 *
 * `ts` дописанного — последняя активность сессии после старта, `ms` — от
 * старта до неё. Счётчик `sessions.events` дописанное не двигает: он считает
 * то, что прислал клиент.
 */
import { dictionary, validate } from '../schema.mjs';
import { profileOf } from './rollup.mjs';

const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Значение поля из props; ключ попытки — только примитив (строка или целое). */
function keyOf(props, fields) {
  const parts = [];
  for (const field of fields) {
    const value = props[field];
    if (typeof value !== 'string' && !Number.isInteger(value)) return null;
    parts.push(value);
  }
  return parts;
}

const parse = (text) => {
  try {
    const value = JSON.parse(text ?? '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
};

export function inferEnds(db, { app, olderThan, now = Date.now() }) {
  const pairs = profileOf(app).ends;
  const result = { inferred: 0, removed: 0 };
  if (pairs.length === 0) return result;

  const endShape = (name) => dictionary(app)[name] ?? {};
  const lastActivity = db.prepare(
    'SELECT MAX(ts) AS ts FROM events WHERE session_id = ? AND seq > 0 AND ts >= ?',
  );
  const insert = db.prepare(
    `INSERT OR IGNORE INTO events (session_id, seq, name, ts, received_at, day, props, known, dropped)
     VALUES (?,?,?,?,?,?,?,1,NULL)`,
  );
  const remove = db.prepare('DELETE FROM events WHERE session_id = ? AND seq = ?');

  try {
    db.exec('BEGIN');
    for (const pair of pairs) {
      const rowsOf = (name) => db.prepare(
        `SELECT e.session_id AS session_id, e.seq AS seq, e.ts AS ts, e.props AS props,
                s.anon_subject AS anon
         FROM events e JOIN sessions s ON s.session_id = e.session_id
         WHERE s.app = ? AND e.name = ? AND e.known = 1`,
      ).iterate(app, name);

      // Настоящие концы (seq > 0) и дописанные ранее (seq < 0) — за один проход.
      const ended = new Set();
      const inferredRows = [];
      for (const row of rowsOf(pair.end)) {
        const key = keyOf(parse(row.props), pair.key);
        if (!key) continue;
        const id = JSON.stringify([row.anon, ...key]);
        if (row.seq > 0) ended.add(id);
        else inferredRows.push({ id, session_id: row.session_id, seq: row.seq });
      }

      for (const row of inferredRows) {
        if (ended.has(row.id)) result.removed += remove.run(row.session_id, row.seq).changes;
      }

      // Кандидаты собираются до записи: писать в events, пока по ней открыт
      // курсор, — неопределённый порядок обхода. Без конца остаются единицы
      // процентов стартов, так что массив мал, а сами старты идут потоком.
      const orphans = [];
      for (const row of rowsOf(pair.start)) {
        if (row.seq <= 0 || row.ts >= olderThan) continue;
        const started = parse(row.props);
        const key = keyOf(started, pair.key);
        if (!key || ended.has(JSON.stringify([row.anon, ...key]))) continue;
        orphans.push({ ...row, started });
      }

      const shape = endShape(pair.end);
      for (const { started, ...row } of orphans) {
        const last = lastActivity.get(row.session_id, row.ts).ts ?? row.ts;
        const props = {};
        for (const field of Object.keys(started)) {
          if (Object.hasOwn(shape, field)) props[field] = started[field];
        }
        Object.assign(props, pair.set);
        if (Object.hasOwn(shape, 'ms')) props.ms = last - row.ts;
        const { props: clean } = validate(pair.end, props, app);
        result.inferred += insert.run(
          row.session_id, -row.seq, pair.end, last, now, dayKey(last), JSON.stringify(clean),
        ).changes;
      }
    }
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
