/**
 * Транспорт событий в браузере.
 *
 * Три правила, из которых растёт всё остальное.
 *
 * Первое: наружу не бросаем никогда. Аналитика, уронившая игру, хуже
 * отсутствующей, поэтому каждая точка входа обёрнута, а ошибки молчат.
 *
 * Второе: неотправленное переживает закрытие. Вебвью ВКонтакте и Яндекса
 * закрываются без предупреждения, и без сохранения очереди теряется хвост
 * каждой сессии — то есть ровно выход из игры, половина того, ради чего всё
 * затевается.
 *
 * Третье: отправка внедряется. По умолчанию это sendBeacon и fetch, но в
 * тестах — подстановка, иначе транспорт проверяется только браузером.
 */

// Подчёркивание, а не точка: ключ уходит в VKWebAppStorageSet/Get площадки
// ВКонтакте, а та принимает в ключах только латиницу, цифры и подчёркивание.
// Точка отклоняется площадкой, PlatformStorage откатывается на голый
// localStorage — и именно эта очередь, хвост каждой сессии, тогда теряется
// первой при закрытии вебвью. Не «красивее», а обязательное ограничение.
const QUEUE_KEY = 'analytics_queue';

/**
 * Отправка по умолчанию: маяк на выгрузке, иначе обычный запрос.
 *
 * Оба пути бросают при отказе, а не возвращают `null`: `null` — законный
 * успешный ответ (у маяка ответа нет вовсе), и только бросок даёт flush()
 * отличить «ответа нет» от «не удалось» и вернуть пачку в очередь.
 */
function defaultSend(url, body, beacon) {
  if (beacon && typeof navigator !== 'undefined' && navigator.sendBeacon) {
    // false — очередь браузера переполнена или тело слишком велико.
    if (!navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }))) {
      throw new Error('sendBeacon отклонил пачку');
    }
    return Promise.resolve(null);
  }
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    keepalive: true,
  }).then((response) => {
    if (!response.ok) throw new Error(`ответ ${response.status}`);
    return response.text();
  });
}

export function createClient({
  endpoint,
  app,
  storage,
  send = defaultSend,
  now = Date.now,
  flushAt = 20,
  flushMs = 15000,
  maxQueue = 200,
}) {
  let sessionId = null;
  let seq = 0;
  let queue = [];
  let timer = null;
  let startedAt = now();

  const persist = () => {
    // Сохраняем и номер: иначе после восстановления очереди номера начнутся
    // сначала, и приёмник сочтёт события повтором уже записанных. Обёрнуто
    // целиком: JSON.stringify тоже может бросить (например, на цикличных
    // props), а сохранение не должно уронить вызывающую точку входа.
    try {
      void Promise.resolve(storage.set(QUEUE_KEY, JSON.stringify({ seq, queue }))).catch(() => {});
    } catch {
      // Испорченные данные в очереди — не повод падать сохранением.
    }
  };

  const arm = () => {
    if (timer !== null || typeof setTimeout !== 'function') return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, flushMs);
    // unref нужен только в Node: иначе висящий таймер держит процесс живым
    // все 15 секунд. У браузерного идентификатора метода нет — вызов через ?.
    timer.unref?.();
  };

  async function flush(beacon = false) {
    if (queue.length === 0) return;
    // Без сессии отправлять некуда, но копить можно: сессия откроется через
    // мгновение, а события до неё — это как раз загрузка, самое интересное.
    if (!sessionId) {
      persist();
      return;
    }
    // Очередь сейчас сольётся — отложенный флаш по таймеру больше не нужен,
    // иначе сработает вхолостую: лишнее пробуждение в вебвью не бесплатно.
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    const batch = queue;
    queue = [];
    try {
      await send(endpoint, JSON.stringify({ s: sessionId, sent_at: now(), e: batch }), beacon);
      persist();
    } catch {
      // Возвращаем в голову очереди: порядок важнее свежести, номера сквозные.
      queue = [...batch, ...queue].slice(-maxQueue);
      persist();
    }
  }

  async function start(info) {
    try {
      const saved = await storage.get(QUEUE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        // То, что накопилось до start() (например, событие готовности),
        // лежит в queue с номерами, назначенными от нуля — они пересекутся
        // с восстановленными и создадут дубликат (session_id, seq), который
        // приёмник молча отбросит через INSERT OR IGNORE. Откладываем эти
        // события в сторону и перенумеровываем ниже, после того как счётчик
        // встанет на восстановленное значение.
        const early = queue;
        queue = Array.isArray(parsed.queue) ? parsed.queue : [];
        // Счётчик и очередь сохраняются вместе, но запись могла пройти не
        // полностью (испорченное хранилище, обрыв, очередь от прежней
        // версии клиента) — доверять их согласованности нельзя. Если
        // сохранённый seq меньше, чем максимальный номер, реально лежащий
        // в очереди, перенумерация ранних ниже назначит уже занятый номер
        // и создаст ровно ту коллизию, которую эта перенумерация чинит.
        // Поэтому берём больший из двух.
        const savedSeq = Number.isInteger(parsed.seq) ? parsed.seq : 0;
        const maxQueued = queue.reduce(
          (max, event) => (Number.isInteger(event.q) && event.q > max ? event.q : max),
          0,
        );
        seq = Math.max(savedSeq, maxQueued);
        // Восстановленным номера не трогаем: они уже могли уйти на сервер
        // прошлым запуском и сейчас служат защитой от задвоения — сменить
        // номер значит превратить повтор пачки в новое событие для приёмника.
        // Ранним номер меняем: они ещё нигде не были, старый номер годится
        // только для памяти этого запуска и гарантированно конфликтует с
        // восстановленным диапазоном.
        for (const event of early) queue.push({ ...event, q: (seq += 1) });
        // Обрезаем сразу после слияния: иначе очередь у потолка плюс события
        // до start() превысят maxQueue, и flush() уйдёт пачкой целиком.
        queue = queue.slice(-maxQueue);
      }
    } catch {
      // Испорченное хранилище — не повод не собирать дальше.
    }

    try {
      const answer = await send(
        `${endpoint}/session`,
        JSON.stringify({ app, anon_id: info.anonId, launch: info.launch, ctx: info.ctx }),
        false,
      );
      sessionId = answer ? JSON.parse(answer).session_id ?? null : null;
    } catch {
      sessionId = null;
    }
    startedAt = now();
    await flush();
  }

  function track(name, props) {
    try {
      seq += 1;
      queue.push({ q: seq, n: name, t: now(), ...(props ? { p: props } : {}) });
      if (queue.length > maxQueue) queue = queue.slice(-maxQueue);
      if (queue.length >= flushAt) void flush();
      else arm();
    } catch {
      // Некуда положить — значит это событие не будет собрано. Игре всё равно.
    }
  }

  async function stop(reason) {
    // `now() - startedAt` — вне try самого track(), поэтому оборачиваем
    // целиком: stop() зовут на pagehide без обработчика, падать нельзя.
    try {
      track('session_end', { ms: now() - startedAt, events: seq, reason });
      await flush(true);
    } catch {
      // Последний маяк перед закрытием — падать нельзя ни при каких условиях.
    }
  }

  return {
    start,
    track,
    flush: () => flush(false),
    stop,
    get sessionId() {
      return sessionId;
    },
  };
}
