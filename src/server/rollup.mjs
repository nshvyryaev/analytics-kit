/**
 * Ночная свёртка и отсечка сырья.
 *
 * Свёртка узкая и общая: новая метрика — новая строка, а не новый столбец и не
 * миграция. Имя метрики склеивается из события и его исхода, потому что
 * интересен почти всегда именно исход: побед без брошенных уровней не бывает.
 *
 * Отсечка трогает только сырьё. `subjects`, `activity` и `daily` переживают её
 * намеренно: на них стоит ретеншен, и его глубина не должна зависеть от того,
 * сколько суток мы храним подробности.
 *
 * Подневные счётчики игрока (`levels_won`, `purchases`, `hints_bought`)
 * пишутся в `activity`, а не считаются напрямую из `events`: `activity`
 * устроена как «приложение × день × игрок» и переживает отсечку по
 * построению, а `events` — нет. Счётчик в `subjects` — это сумма по
 * `activity` за все дни, и он поэтому тоже не зависит от глубины отсечки.
 */

/** События, у которых исход важнее самого факта. */
const BY_OUTCOME = { level_end: 'outcome', ad_result: 'outcome', purchase_result: 'outcome' };

/**
 * Достаёт одно поле свойств события. В JS, а не в SQL/json_extract:
 * расширение есть не в каждой сборке SQLite, а строковый поиск подстроки в
 * сыром JSON (`LIKE '%"outcome":"solved"%'`) ловит совпадение и там, где
 * значение просто похоже на нужное, а не равно ему.
 */
function propField(props, field) {
  try {
    return JSON.parse(props ?? '{}')[field];
  } catch {
    return undefined;
  }
}

/** Исход события, если у события вообще есть исход. */
function outcomeOf(name, props) {
  const field = BY_OUTCOME[name];
  if (!field) return undefined;
  const value = propField(props, field);
  return typeof value === 'string' ? value : undefined;
}

export function rollup(db, day) {
  const put = db.prepare(
    `INSERT INTO daily (app, day, platform, metric, value) VALUES (?,?,?,?,?)
     ON CONFLICT (app, day, platform, metric) DO UPDATE SET value = excluded.value`,
  );

  try {
    db.exec('BEGIN');
    let written = 0;

    // DAU — по игрокам, не по сессиям: один игрок с тремя сессиями за день
    // должен дать dau = 1, а не 3. Сессии считаются отдельной метрикой рядом.
    const audience = db.prepare(
      `SELECT s.app AS app, s.platform AS platform,
              COUNT(DISTINCT s.subject_id) AS dau, COUNT(*) AS sessions
       FROM sessions s WHERE s.day = ? GROUP BY s.app, s.platform`,
    ).all(day);
    for (const row of audience) {
      put.run(row.app, day, row.platform, 'dau', row.dau);
      put.run(row.app, day, row.platform, 'sessions', row.sessions);
      written += 2;
    }

    // Метрики по (событие, исход) — только по известным событиям. Имя
    // метрики склеивается из e.name и исхода, и без фильтра `known = 1`
    // клиент мог бы прислать незнакомое событие с именем, буквально равным
    // составному ключу (например, "level_end:solved"), и подделать деловую
    // метрику, ни разу не пройдя валидацию словаря. Незнакомые события не
    // теряются — они считаются одним общим счётчиком ниже.
    const counted = db.prepare(
      `SELECT s.app AS app, s.platform AS platform, e.name AS name,
              e.props AS props, COUNT(*) AS n
       FROM events e JOIN sessions s ON s.session_id = e.session_id
       WHERE e.day = ? AND e.known = 1
       GROUP BY s.app, s.platform, e.name, e.props`,
    ).all(day);

    // Составной ключ Map — JSON.stringify массива частей, а не склейка со
    // строковым разделителем. У склейки нет безопасного разделителя: печатный
    // символ (пробел, двоеточие) может встретиться в самих данных и молча
    // срезать хвост ключа при разборе, а непечатаемый control-символ уже
    // однажды попал в этот файл буквальным байтом вместо escape-последовательности
    // в исходнике. JSON.stringify/JSON.parse однозначны по построению и не
    // нуждаются ни в том, ни в другом — не возвращать это к склейке.
    const totals = new Map();
    for (const row of counted) {
      const outcome = outcomeOf(row.name, row.props);
      const metric = outcome ? `${row.name}:${outcome}` : row.name;
      const key = JSON.stringify([row.app, row.platform, metric]);
      totals.set(key, (totals.get(key) ?? 0) + row.n);
    }
    for (const [key, value] of totals) {
      const [app, platform, metric] = JSON.parse(key);
      put.run(app, day, platform, metric, value);
      written += 1;
    }

    // Незнакомые события — общий счётчик с фиксированным именем, а не свои
    // метрики по (name, props): их имя и форма не из словаря, доверять им как
    // источнику имени метрики нельзя. Заодно по этой метрике видно, что
    // клиент разъехался со словарём событий.
    const unknown = db.prepare(
      `SELECT s.app AS app, s.platform AS platform, COUNT(*) AS n
       FROM events e JOIN sessions s ON s.session_id = e.session_id
       WHERE e.day = ? AND e.known = 0
       GROUP BY s.app, s.platform`,
    ).all(day);
    for (const row of unknown) {
      put.run(row.app, day, row.platform, 'events_unknown', row.n);
      written += 1;
    }

    // Подневные счётчики игрока считаются по событиям именно этого дня и
    // ПЕРЕЗАПИСЫВАЮТ строку activity (а не прибавляют к ней) — перезапись
    // даёт идемпотентность даром: повторный вызов свёртки того же дня кладёт
    // то же самое число ещё раз, а не удваивает его.
    const perDay = db.prepare(
      `SELECT s.app AS app, s.subject_id AS subject_id, e.name AS name, e.props AS props
       FROM events e JOIN sessions s ON s.session_id = e.session_id
       WHERE e.day = ? AND e.name IN ('level_end', 'purchase_result', 'purchase_credited')`,
    ).all(day);

    const perSubject = new Map();
    const bucketOf = (app, subjectId) => {
      const key = JSON.stringify([app, subjectId]);
      let entry = perSubject.get(key);
      if (!entry) {
        entry = { levels_won: 0, purchases: 0, hints_bought: 0 };
        perSubject.set(key, entry);
      }
      return entry;
    };
    for (const row of perDay) {
      const entry = bucketOf(row.app, row.subject_id);
      if (row.name === 'level_end') {
        if (outcomeOf('level_end', row.props) === 'solved') entry.levels_won += 1;
      } else if (row.name === 'purchase_result') {
        if (outcomeOf('purchase_result', row.props) === 'purchased') entry.purchases += 1;
      } else {
        // purchase_credited: подарочные и повторные начисления тоже несут
        // hints — источник не важен, важно сколько подсказок реально упало
        // игроку в кошелёк.
        const hints = propField(row.props, 'hints');
        if (Number.isInteger(hints)) entry.hints_bought += hints;
      }
    }

    // Пишем во все строки activity за день, у которых сегодня была
    // активность, а не только в те, где нашлись эти три типа событий: если у
    // игрока вчера была победа, а сегодня только сессия без событий, сегодняшняя
    // строка обязана обнулиться, иначе повторный вызов свёртки за вчера-с-опозданием
    // не пересчитает её обратно в 0.
    const activeToday = db.prepare(
      'SELECT app, subject_id FROM activity WHERE day = ?',
    ).all(day);

    const setDaily = db.prepare(
      `UPDATE activity SET levels_won = ?, purchases = ?, hints_bought = ?
       WHERE app = ? AND day = ? AND subject_id = ?`,
    );
    for (const row of activeToday) {
      const entry = perSubject.get(JSON.stringify([row.app, row.subject_id]))
        ?? { levels_won: 0, purchases: 0, hints_bought: 0 };
      setDaily.run(entry.levels_won, entry.purchases, entry.hints_bought, row.app, day, row.subject_id);
    }

    // subjects — пожизненная сумма по activity. activity живёт вечно и не
    // страдает от отсечки events/sessions, поэтому и эта сумма от неё не
    // зависит, сколько бы сырья мы ни выбросили.
    db.prepare(
      `UPDATE subjects SET
         levels_won = (SELECT COALESCE(SUM(levels_won), 0) FROM activity a
                       WHERE a.app = subjects.app AND a.subject_id = subjects.subject_id),
         purchases = (SELECT COALESCE(SUM(purchases), 0) FROM activity a
                      WHERE a.app = subjects.app AND a.subject_id = subjects.subject_id),
         hints_bought = (SELECT COALESCE(SUM(hints_bought), 0) FROM activity a
                         WHERE a.app = subjects.app AND a.subject_id = subjects.subject_id)
       WHERE EXISTS (
         SELECT 1 FROM activity a
         WHERE a.app = subjects.app AND a.subject_id = subjects.subject_id AND a.day = ?
       )`,
    ).run(day);

    db.exec('COMMIT');
    return written;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function prune(db, { before }) {
  try {
    db.exec('BEGIN');
    // Сначала events, потом sessions: у events внешний ключ на sessions, и
    // при foreign_keys = ON удаление сессии раньше её событий упадёт.
    const events = db.prepare('DELETE FROM events WHERE day < ?').run(before).changes;
    // Сессию нельзя удалять просто по дате её начала. `sessions.day` — день,
    // когда сессия ОТКРЫЛАСЬ, а не когда она в последний раз писала события:
    // серверная псевдосессия (до этой правки) заводилась раз на процесс и
    // копила события месяцами, а обычная клиентская сессия может писать
    // события ещё какое-то время после полуночи, уже в следующий день. Если
    // у такой сессии day старше границы, а событие свежее — WHERE day < ?
    // выберет сессию на удаление, хотя у неё остались события, которые
    // отсечка выше не тронула (у них day >= before). Итог — либо падение на
    // внешнем ключе (foreign_keys = ON), либо (без него) осиротевшие
    // события без родителя. Поэтому удаляем только сессии, у которых после
    // отсечки событий не осталось вовсе: долгоживущая сессия проживёт ровно
    // до тех пор, пока не отсекутся последние её события.
    const sessions = db.prepare(
      `DELETE FROM sessions WHERE day < ? AND NOT EXISTS (
         SELECT 1 FROM events WHERE events.session_id = sessions.session_id
       )`,
    ).run(before).changes;
    db.exec('COMMIT');
    return { events, sessions };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
