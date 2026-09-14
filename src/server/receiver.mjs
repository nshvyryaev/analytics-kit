/**
 * Приёмник событий.
 *
 * Идентификатор игрока не ездит в событиях вовсе: клиент всё равно не может
 * его доказать, а принимать на слово нельзя — тогда кто угодно нальёт событий
 * от чужого имени. Поэтому личность устанавливается один раз, при открытии
 * сессии, по подписи параметров запуска, а дальше ездит только наш случайный
 * `session_id`.
 *
 * Проверку подписи приёмник не делает сам: она своя у каждой площадки, а
 * пакету положено не знать про ВКонтакте ничего. Функция `verify` внедряется
 * снаружи.
 *
 * У сервера тоже бывают события без клиента: начисление после платёжного
 * колбэка, отказ по несошедшейся подписи. Для них `track()` заводит
 * псевдосессию — общую на приложение (личность неизвестна) или, если вызывающий
 * код знает игрока (площадка + id из уже проверенного платёжного уведомления),
 * привязанную к нему псевдосессию на день, псевдонимизированную так же, как у
 * клиента.
 */
import { randomBytes } from 'node:crypto';

import { validate } from '../schema.mjs';
import { anonSubject, playerSubject } from './identity.mjs';

const MAX_BATCH = 100;
const MAX_SESSION_EVENTS = 5000;
// Приёмник читает данные из открытой сети: без потолка на число ключей в
// `counts` поток запросов со случайным `s` рос бы Map неограниченно — это
// OOM в процессе, который держит платежи.
const MAX_COUNTS_ENTRIES = 10_000;

const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
const token = () => randomBytes(16).toString('base64url');
const bounded = (value, max) => (typeof value === 'string' ? value.slice(0, max) : null);

/**
 * `entry` (точка входа: прямой запуск, шаринг, ежедневный челлендж) —
 * описательное поле, а не признак доверия: оно пишется из тела запроса
 * (`ctx.entry`), значит клиент им управляет. Список допустимых значений —
 * перечисление, как и у любого другого поля из сети: мусор в описательном
 * поле не нужен, даже когда он ни на что не влияет.
 */
const ENTRY_VALUES = ['direct', 'shared', 'daily'];
const normalizedEntry = (value) => (ENTRY_VALUES.includes(value) ? value : null);

export function createReceiver({
  sink, key, keyVersion = 1, apps, verify, now = Date.now,
}) {
  const allowed = new Set(apps);
  // Счётчик событий на сессию держится в памяти: он нужен только чтобы
  // остановить поток, а после перезапуска поток и так начнётся заново.
  const counts = new Map();
  // Счётчики серверных псевдосессий (общей и по игрокам) — ОТДЕЛЬНАЯ карта, а
  // не запись в `counts` вместе с клиентскими. Причина: `counts` вытесняет
  // старейшую запись по переполнению `MAX_COUNTS_ENTRIES`, а порядок
  // вытеснения у `Map` — порядок вставки. Серверная псевдосессия заводится
  // ПЕРВОЙ в жизни процесса (до первого клиентского запроса) — значит именно
  // она вытесняется первой, как только поток клиентских сессий наберёт
  // потолок. После вытеснения её счётчик в `counts` исчезает, track() снова
  // начинает нумерацию `seq` с единицы, а `INSERT OR IGNORE` по ключу
  // (session_id, seq) в sqlite.mjs молча отбрасывает все начисления и отказы,
  // чей номер уже занят прежними, — теряется ровно столько событий, сколько
  // их было до вытеснения. Серверных псевдосессий в сутки — единицы (общая
  // плюс по одной на купившего игрока), так что отдельная карта для них не
  // нуждается в потолке по размеру вовсе — ей просто неоткуда раздуться от
  // потока чужих запросов. Но жить вечным процессом ей тоже нельзя: без
  // чистки по дате за год набегут сотни устаревших дневных ключей. Чистим их
  // сами при каждом обращении (см. pruneServerState) — сессии всё равно
  // ключуются по дню и назавтра уже не переиспользуются, так что держать
  // вчерашние записи незачем.
  const serverSessions = new Map(); // cacheKey -> { id, day }
  const serverCounts = new Map(); // session_id -> seq

  /**
   * Пишет счётчик событий сессии, вытесняя старейшую запись при переполнении
   * потолка. `Map` хранит ключи в порядке вставки, поэтому вытеснение —
   * первый ключ итератора. Вытеснение лишь обнуляет накопленный бюджет для
   * давней сессии — это приемлемо: счётчик защищает от потока запросов, а не
   * ведёт точный учёт.
   */
  function bumpCount(id, value) {
    if (!counts.has(id) && counts.size >= MAX_COUNTS_ENTRIES) {
      counts.delete(counts.keys().next().value);
    }
    counts.set(id, value);
  }

  /** Убирает из карты серверных псевдосессий всё, что не сегодня. */
  function pruneServerState(today) {
    for (const [cacheKey, entry] of serverSessions) {
      if (entry.day !== today) {
        serverSessions.delete(cacheKey);
        serverCounts.delete(entry.id);
      }
    }
  }

  /**
   * Заводит (или переиспользует из кэша) серверную псевдосессию по ключу
   * `cacheKey` на день `day`, вызывая `buildRow(id)` для первой записи.
   * Общая точка для «общей» серверной сессии на приложение и «привязанной»
   * на игрока — обе живут по одному правилу: одна сессия на ключ в сутки.
   */
  function ensureServerSession(cacheKey, day, buildRow) {
    pruneServerState(day);
    const cached = serverSessions.get(cacheKey);
    if (cached) return cached.id;
    const id = token();
    try {
      sink.session(buildRow(id));
    } catch (error) {
      // Как и с клиентскими событиями: сбой хранилища не должен ронять
      // процесс, который держит платежи. Без записанной сессии писать
      // событие в неё нельзя — track() ниже это учитывает.
      console.error('[аналитика] серверная сессия не создана', error);
      return null;
    }
    serverSessions.set(cacheKey, { id, day });
    return id;
  }

  function serverSession(app) {
    const at = now();
    const day = dayKey(at);
    return ensureServerSession(`${app}#${day}`, day, (id) => ({
      session_id: id, app, subject_id: 'server', anon_subject: 'server',
      key_version: keyVersion, platform: 'server', verified: 1,
      app_version: null, language: null, os: null, mobile: null, screen: null,
      // 'server' здесь — просто пояснение для человека, читающего сырьё
      // глазами; признак, от которого зависит подсчёт аудитории, —
      // `server_origin` ниже, не это поле (см. комментарий в sqlite.mjs).
      entry: 'server', server_origin: 1, day, started_at: at, last_seen_at: at,
    }));
  }

  /**
   * Серверная псевдосессия, привязанная к конкретному игроку за этот день —
   * та же логика псевдонимизации, что и у клиентской сессии (playerSubject),
   * чтобы событие легло на настоящего игрока, а не на общего «server».
   * Покупок мало, поэтому «сессия на покупающего игрока в сутки» приемлема
   * по объёму — это не поток, который нужно вытеснять.
   */
  function playerServerSession(app, platform, playerId) {
    const at = now();
    const day = dayKey(at);
    const subjectId = playerSubject(platform, playerId, key);
    return ensureServerSession(`${app}#${day}#${subjectId}`, day, (id) => ({
      session_id: id, app, subject_id: subjectId, anon_subject: subjectId,
      key_version: keyVersion, platform, verified: 1,
      app_version: null, language: null, os: null, mobile: null, screen: null,
      entry: 'server', server_origin: 1, day, started_at: at, last_seen_at: at,
    }));
  }

  return {
    session(body) {
      const app = bounded(body?.app, 64);
      const anonId = bounded(body?.anon_id, 64);
      if (!app || !allowed.has(app)) return { status: 400, body: { error: 'app' } };
      if (!anonId) return { status: 400, body: { error: 'anon_id' } };

      const checked = (body.launch && verify(body.launch)) || { ok: false };
      const anon = anonSubject(anonId, key);
      // platform приходит из verify(), а verify сам разбирает недоверенный
      // body.launch — как и всякую строку из тела запроса, её ограничиваем
      // длиной. Если verify вернул ok:true с нестроковой платформой, это его
      // баг, а не подписанный запуск: понижаем до неудостоверённой сессии,
      // а не роняем обработку разыменованием null внутри playerSubject().
      const verifiedPlatform = checked.ok ? bounded(checked.platform, 16) : null;
      const ok = checked.ok && verifiedPlatform !== null;
      const platform = ok ? verifiedPlatform : 'local';
      const subjectId = ok ? playerSubject(platform, checked.playerId, key) : anon;

      const ctx = body.ctx ?? {};
      const at = now();
      const id = token();
      try {
        sink.session({
          session_id: id, app, subject_id: subjectId, anon_subject: anon,
          key_version: keyVersion, platform, verified: ok ? 1 : 0,
          app_version: bounded(ctx.app_version, 40),
          language: bounded(ctx.language, 8),
          os: bounded(ctx.os, 16),
          mobile: ctx.mobile ? 1 : 0,
          screen: bounded(ctx.screen, 4),
          entry: normalizedEntry(ctx.entry),
          // Этот путь — единственный, где сессию заводит клиентский запрос,
          // и `server_origin` здесь всегда 0 буквально: не переменная,
          // которая могла бы случайно унаследовать что-то из `ctx`, а
          // константа. Из тела запроса это поле не читается вообще —
          // серверное происхождение ставят только serverSession() и
          // playerServerSession() ниже, сами, без участия сети.
          server_origin: 0,
          day: dayKey(at), started_at: at, last_seen_at: at,
        });
      } catch (error) {
        // Сбой хранилища — тоже точка отказа, а не только собственно приём
        // событий. Клиент переживёт 503: оставит session_id пустым и
        // продолжит копить события в очереди, не роняя процесс с платежами.
        console.error('[аналитика] сессия не записана', error);
        return { status: 503, body: { error: 'store' } };
      }
      return { status: 200, body: { session_id: id } };
    },

    collect(body) {
      // Приём отвечает успехом почти всегда. Ошибка заставила бы клиент
      // повторять пачку вечно, а ценность одной пачки этого не стоит.
      const sessionId = bounded(body?.s, 40);
      const list = Array.isArray(body?.e) ? body.e : [];
      if (!sessionId || list.length === 0) return { status: 204 };

      const seen = counts.get(sessionId) ?? 0;
      // Остаток бюджета, а не просто факт достижения потолка: проверка
      // «seen >= MAX_SESSION_EVENTS» пропустила бы пачку из 100 событий
      // целиком при seen = 4980, дав 5080 записей вместо 5000.
      const budget = MAX_SESSION_EVENTS - seen;
      if (budget <= 0) return { status: 204 };

      const receivedAt = now();
      // Часы на мобильных врут регулярно. Без поправки событие с телефона с
      // неверной датой попадёт в чужой день и испортит суточный срез.
      const sentAt = Number.isFinite(body?.sent_at) ? body.sent_at : receivedAt;
      const skew = receivedAt - sentAt;

      const rows = [];
      for (const item of list.slice(0, Math.min(MAX_BATCH, budget))) {
        const name = bounded(item?.n, 64);
        const seq = Number.isInteger(item?.q) ? item.q : null;
        if (!name || seq === null) continue;
        const clientTs = Number.isFinite(item?.t) ? item.t : sentAt;
        const { known, props } = validate(name, item?.p);
        rows.push({
          session_id: sessionId, seq, name,
          ts: clientTs + skew, received_at: receivedAt, day: dayKey(clientTs + skew),
          props: JSON.stringify(props), known: known ? 1 : 0,
        });
      }

      try {
        const written = sink.events(rows);
        // Писать счётчик только когда реально что-то записано: для чужой
        // (несуществующей) сессии sink.events возвращает 0, и если бы Map
        // всё равно заводила запись, поток запросов со случайным `s` растил
        // бы её неограниченно — не имея настоящей сессии, ни один такой ключ
        // никогда бы не переиспользовался и не удалялся сам.
        if (written > 0) bumpCount(sessionId, seen + written);
      } catch (error) {
        // Упавшая пачка теряется и остаётся в журнале. Процесс, который
        // принимает деньги, не должен падать из-за статистики.
        console.error('[аналитика] пачка не записана', error);
      }
      return { status: 204 };
    },

    /**
     * Событие, о котором знает только сервер: начисление, отказ по подписи.
     *
     * Необязательный четвёртый параметр `identity` — `{ platform, playerId }`
     * — привязывает событие к настоящему игроку (например,
     * `purchase_credited`, чтобы `hints_bought` в свёртке считался на живого
     * игрока, а не на фиктивного «server»: rollup.mjs берёт подневные
     * счётчики по `subject_id` сессии, и без привязки все покупки лежали на
     * одном псевдонимном игроке). Когда `identity` не передан или неполон
     * (нет платформы или id) — поведение прежнее, общая псевдосессия
     * `subject_id = 'server'`: так и остаётся `payment_rejected` — по
     * несошедшейся подписи сервер не знает, какой игрок стоит за запросом.
     */
    track(app, name, props, identity) {
      if (!allowed.has(app)) return;
      const platform = typeof identity?.platform === 'string' && identity.platform
        ? bounded(identity.platform, 16)
        : null;
      const playerId = typeof identity?.playerId === 'string' || typeof identity?.playerId === 'number'
        ? String(identity.playerId)
        : null;
      const id = platform && playerId
        ? playerServerSession(app, platform, playerId)
        : serverSession(app);
      if (!id) return;
      const at = now();
      const { known, props: clean } = validate(name, props);
      const seq = (serverCounts.get(id) ?? 0) + 1;
      serverCounts.set(id, seq);
      try {
        sink.events([{
          session_id: id, seq, name, ts: at, received_at: at,
          day: dayKey(at), props: JSON.stringify(clean), known: known ? 1 : 0,
        }]);
      } catch (error) {
        console.error('[аналитика] серверное событие не записано', error);
      }
    },
  };
}
