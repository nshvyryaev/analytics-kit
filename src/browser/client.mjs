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

const QUEUE_KEY = 'analytics.queue';

/** Отправка по умолчанию: маяк на выгрузке, иначе обычный запрос. */
function defaultSend(url, body, beacon) {
  if (beacon && typeof navigator !== 'undefined' && navigator.sendBeacon) {
    navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
    return Promise.resolve(null);
  }
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    keepalive: true,
  }).then((response) => (response.ok ? response.text() : null));
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
    // unref — только в Node (тестовый раннер, серверный SSR-прогон): висящий
    // таймер иначе держит процесс живым все 15 секунд. В браузере у числового
    // идентификатора таймера такого метода нет, поэтому опциональный вызов.
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
        seq = Number.isInteger(parsed.seq) ? parsed.seq : 0;
        queue = Array.isArray(parsed.queue) ? [...parsed.queue, ...queue] : queue;
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
    track('session_end', { ms: now() - startedAt, events: seq, reason });
    await flush(true);
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
