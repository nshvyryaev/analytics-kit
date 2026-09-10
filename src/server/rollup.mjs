/**
 * Ночная свёртка и отсечка сырья.
 *
 * Свёртка узкая и общая: новая метрика — новая строка, а не новый столбец и не
 * миграция. Имя метрики склеивается из события и его измерений (см.
 * DIMENSIONS ниже) — почти всегда это исход, а у событий уровня ещё и длина
 * слова: побед без брошенных уровней не бывает, а вопрос «на какой длине игра
 * ломается» — главный во всём треке, и без длины в имени метрики на него не
 * ответить после того, как сырьё отсечётся.
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

/** События, у которых исход важнее самого факта (для подневных счётчиков игрока). */
const BY_OUTCOME = { level_end: 'outcome', ad_result: 'outcome', purchase_result: 'outcome' };

/**
 * Измерения имени метрики — по событию, явный и короткий список полей, а не
 * рефлексия по всей схеме события из schema.mjs. У level_end кроме outcome и
 * length есть ещё moves, chain, rejects, hints, ms, streak — включи их сюда,
 * и метрика взорвалась бы по мощности (moves/chain вообще массивы
 * произвольной длины) либо просто перестала бы что-то агрегировать: строка
 * `daily` обязана оставаться редкой сводкой, а не сырьём под другим именем.
 * Длины слов у нас от трёх до восьми, исходов — единицы, так что
 * `level_end` × length × outcome даёт до полусотни строк в сутки на
 * (app, platform) — не взрыв. Расширять список — осознанное решение, а не
 * побочный эффект появления нового поля в словаре событий.
 */
const DIMENSIONS = {
  level_start: ['length'],
  level_end: ['outcome', 'length'],
  ad_result: ['outcome'],
  purchase_result: ['outcome'],
};

/**
 * Достаёт одно поле уже распарсенных свойств события. Свойства парсятся один
 * раз на строку сырья (см. основной цикл rollup) и передаются сюда готовым
 * объектом — вызывающих мест несколько (имя метрики, исход для activity), и
 * повторный JSON.parse одного и того же props на каждое из них не нужен.
 */
function outcomeOf(name, parsedProps) {
  const field = BY_OUTCOME[name];
  if (!field) return undefined;
  const value = parsedProps[field];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Имя метрики: событие плюс значения его измерений по порядку. Измерение,
 * которого нет в присланных свойствах (клиент мог не заполнить поле),
 * пропускается, а не подставляется заглушкой — так `level_end` без length
 * всё равно попадёт в `level_end:solved`, а не потеряется вовсе.
 */
function metricName(name, parsedProps) {
  const fields = DIMENSIONS[name];
  if (!fields) return name;
  const parts = [name];
  for (const field of fields) {
    const value = parsedProps[field];
    if (value !== undefined && value !== null) parts.push(String(value));
  }
  return parts.join(':');
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

    // Единый проход по сырым событиям дня — вместо трёх отдельных запросов
    // (метрики по известным, счётчик незнакомых, подневные счётчики игрока),
    // каждый из которых заново читал ту же таблицу. У level_end и
    // word_rejected свойства почти уникальны на каждое событие (moves, chain,
    // ms и т.п.), так что прежний `GROUP BY ..., e.props` в SQL ничего не
    // склеивал — он лишь заставлял SQLite вернуть по строке на каждое
    // событие дня (плюс сортировку для самой группировки), то есть то же
    // самое, что и без GROUP BY, но дороже. Возвращаться к нему нельзя: он не
    // уменьшает объём, который едет в JS, а только маскирует это тем, что
    // выглядит как агрегация. `.iterate()` вместо `.all()` отдаёт строки по
    // одной прямо из курсора SQLite, не собирая их в массив заранее — в
    // памяти в любой момент лежит одна строка сырья плюс уже свёрнутые итоги
    // (totals/unknownTotals/perSubject), а не весь день целиком. При тысяче
    // игроков в день это была разница между парой строк и ~75 МБ, приезжающими
    // в память ДВАЖДЫ (по разу на прежний `counted` и `perDay`) — на машине
    // с 1967 МБ, где рядом ещё один процесс, так делать нельзя.
    const rows = db.prepare(
      `SELECT s.app AS app, s.platform AS platform, s.subject_id AS subject_id,
              e.name AS name, e.props AS props, e.known AS known
       FROM events e JOIN sessions s ON s.session_id = e.session_id
       WHERE e.day = ?`,
    ).iterate(day);

    // Составной ключ Map — JSON.stringify массива частей, а не склейка со
    // строковым разделителем. У склейки нет безопасного разделителя: печатный
    // символ (пробел, двоеточие) может встретиться в самих данных и молча
    // срезать хвост ключа при разборе, а непечатаемый control-символ уже
    // однажды попал в этот файл буквальным байтом вместо escape-последовательности
    // в исходнике. JSON.stringify/JSON.parse однозначны по построению и не
    // нуждаются ни в том, ни в другом — не возвращать это к склейке.
    const totals = new Map();
    // Незнакомые события — общий счётчик с фиксированным именем, а не свои
    // метрики по (name, props): их имя и форма не из словаря, доверять им как
    // источнику имени метрики нельзя. Заодно по этой метрике видно, что
    // клиент разъехался со словарём событий.
    const unknownTotals = new Map();
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

    for (const row of rows) {
      if (!row.known) {
        // Без фильтра по known клиент мог бы прислать незнакомое событие с
        // именем, буквально равным составному ключу метрики (например,
        // "level_end:solved"), и подделать деловую метрику, ни разу не пройдя
        // валидацию словаря — поэтому незнакомые события идут в свой счётчик,
        // а не смешиваются с totals.
        const key = JSON.stringify([row.app, row.platform]);
        unknownTotals.set(key, (unknownTotals.get(key) ?? 0) + 1);
        continue;
      }

      // Парсим props ровно один раз на строку сырья и переиспользуем
      // результат для имени метрики и для подневных счётчиков игрока ниже —
      // вместо того чтобы, как раньше, разбирать один и тот же JSON заново на
      // каждый отдельный запрос.
      let parsed;
      try {
        parsed = JSON.parse(row.props ?? '{}');
      } catch {
        parsed = {};
      }

      const metric = metricName(row.name, parsed);
      const key = JSON.stringify([row.app, row.platform, metric]);
      totals.set(key, (totals.get(key) ?? 0) + 1);

      // Подневные счётчики игрока считаются по событиям именно этого дня и
      // ниже ПЕРЕЗАПИСЫВАЮТ строку activity (а не прибавляют к ней) —
      // перезапись даёт идемпотентность даром: повторный вызов свёртки того
      // же дня кладёт то же самое число ещё раз, а не удваивает его.
      if (row.name === 'level_end') {
        const entry = bucketOf(row.app, row.subject_id);
        if (outcomeOf('level_end', parsed) === 'solved') entry.levels_won += 1;
      } else if (row.name === 'purchase_result') {
        const entry = bucketOf(row.app, row.subject_id);
        if (outcomeOf('purchase_result', parsed) === 'purchased') entry.purchases += 1;
      } else if (row.name === 'purchase_credited') {
        // purchase_credited: подарочные и повторные начисления тоже несут
        // hints — источник не важен, важно сколько подсказок реально упало
        // игроку в кошелёк.
        const entry = bucketOf(row.app, row.subject_id);
        const hints = parsed.hints;
        if (Number.isInteger(hints)) entry.hints_bought += hints;
      }
    }

    for (const [key, value] of totals) {
      const [app, platform, metric] = JSON.parse(key);
      put.run(app, day, platform, metric, value);
      written += 1;
    }
    for (const [key, value] of unknownTotals) {
      const [app, platform] = JSON.parse(key);
      put.run(app, day, platform, 'events_unknown', value);
      written += 1;
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
