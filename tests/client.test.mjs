import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../src/browser/client.mjs';

function harness({ failSend = false } = {}) {
  const sent = [];
  const store = new Map();
  const storage = {
    get: async (key) => store.get(key) ?? null,
    set: async (key, value) => void store.set(key, value),
  };
  const send = async (url, body) => {
    if (failSend) throw new Error('сеть');
    sent.push({ url, body: JSON.parse(body) });
    if (url.endsWith('/session')) return JSON.stringify({ session_id: 'с1' });
    return null;
  };
  return { sent, store, storage, send };
}

const info = { anonId: 'а1', launch: { vk_user_id: '1' }, ctx: { language: 'ru' } };

test('события до открытия сессии не теряются', async () => {
  const h = harness();
  const client = createClient({ endpoint: '/v1/collect', app: 'word-chain', ...h });
  client.track('pause', { ms: 1 });
  await client.start(info);
  await client.flush();
  const batch = h.sent.find((r) => !r.url.endsWith('/session'));
  assert.equal(batch.body.e[0].n, 'pause');
  assert.equal(batch.body.s, 'с1');
});

test('флаш происходит сам по достижении порога', async () => {
  const h = harness();
  const client = createClient({ endpoint: '/v1/collect', app: 'word-chain', flushAt: 3, ...h });
  await client.start(info);
  client.track('pause', { ms: 1 });
  client.track('pause', { ms: 2 });
  client.track('pause', { ms: 3 });
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(h.sent.some((r) => !r.url.endsWith('/session') && r.body.e.length === 3));
});

test('порядковые номера растут и не повторяются', async () => {
  const h = harness();
  const client = createClient({ endpoint: '/v1/collect', app: 'word-chain', ...h });
  await client.start(info);
  client.track('pause', { ms: 1 });
  client.track('resume', { ms: 2 });
  await client.flush();
  const batch = h.sent.find((r) => !r.url.endsWith('/session'));
  assert.deepEqual(batch.body.e.map((e) => e.q), [1, 2]);
});

test('неотправленное сохраняется и уходит следующим запуском', async () => {
  const broken = harness({ failSend: true });
  const first = createClient({ endpoint: '/v1/collect', app: 'word-chain', ...broken });
  first.track('pause', { ms: 1 });
  await first.flush();
  assert.ok(broken.store.get('analytics_queue'));

  const ok = harness();
  ok.store = broken.store;
  ok.storage = {
    get: async (key) => broken.store.get(key) ?? null,
    set: async (key, value) => void broken.store.set(key, value),
  };
  const second = createClient({ endpoint: '/v1/collect', app: 'word-chain', ...ok });
  await second.start(info);
  await second.flush();
  const batch = ok.sent.find((r) => !r.url.endsWith('/session'));
  assert.equal(batch.body.e[0].n, 'pause');
});

test('переполнение очереди выбрасывает старые события', async () => {
  const h = harness();
  const client = createClient({
    endpoint: '/v1/collect', app: 'word-chain', flushAt: 10_000, maxQueue: 3, ...h,
  });
  await client.start(info);
  for (const ms of [1, 2, 3, 4]) client.track('pause', { ms });
  await client.flush();
  const batch = h.sent.find((r) => !r.url.endsWith('/session'));
  assert.deepEqual(batch.body.e.map((e) => e.p.ms), [2, 3, 4]);
});

test('падение отправки не бросает наружу', async () => {
  const h = harness({ failSend: true });
  const client = createClient({ endpoint: '/v1/collect', app: 'word-chain', ...h });
  await client.start(info);
  client.track('pause', { ms: 1 });
  await client.flush();
});

test('stop дописывает session_end', async () => {
  const h = harness();
  const client = createClient({ endpoint: '/v1/collect', app: 'word-chain', ...h });
  await client.start(info);
  await client.stop('pagehide');
  const batch = h.sent.find((r) => !r.url.endsWith('/session'));
  assert.equal(batch.body.e.at(-1).n, 'session_end');
});

test('восстановленная очередь обрезается по maxQueue вместе с натреканным до старта', async () => {
  const h = harness();
  // Сохранённая с прошлого запуска очередь уже у потолка.
  h.store.set('analytics_queue', JSON.stringify({
    seq: 3,
    queue: [
      { q: 1, n: 'a', t: 1 },
      { q: 2, n: 'b', t: 2 },
      { q: 3, n: 'c', t: 3 },
    ],
  }));
  const client = createClient({ endpoint: '/v1/collect', app: 'word-chain', maxQueue: 3, ...h });
  // Событие до старта — законное накопление, но вместе с восстановленными
  // тремя оно превышает потолок в 3.
  client.track('до-старта', { ms: 0 });
  await client.start(info);
  await client.flush();
  const batch = h.sent.find((r) => !r.url.endsWith('/session'));
  assert.equal(batch.body.e.length, 3);
  // Вытесняются самые старые — из сохранённой очереди, а не свежее событие.
  assert.deepEqual(batch.body.e.map((e) => e.n), ['b', 'c', 'до-старта']);
});

test('раннее событие до start() перенумеровывается и не задваивает seq восстановленных', async () => {
  const h = harness();
  // Сохранённая с прошлого запуска очередь — например, прошлый запуск не
  // открыл сессию (сбор был выключен, сервер не ответил, сеть упала) и
  // весь хвост так и остался несожранным.
  h.store.set('analytics_queue', JSON.stringify({
    seq: 3,
    queue: [
      { q: 1, n: 'level_start', t: 1 },
      { q: 2, n: 'level_end', t: 2 },
      { q: 3, n: 'session_end', t: 3 },
    ],
  }));
  const client = createClient({ endpoint: '/v1/collect', app: 'word-chain', ...h });
  // До start() — например, событие готовности игры.
  client.track('app_ready', { ms: 0 });
  await client.start(info);
  await client.flush();
  const batch = h.sent.find((r) => !r.url.endsWith('/session'));
  const seqs = batch.body.e.map((e) => e.q);
  // Номера не повторяются — иначе INSERT OR IGNORE на приёмнике молча
  // отбросит второе событие с тем же (session_id, seq).
  assert.equal(new Set(seqs).size, seqs.length);
  // Раннее событие никуда не делось.
  assert.ok(batch.body.e.some((e) => e.n === 'app_ready'));
  // Восстановленные события сохранили свои прежние номера — их защита от
  // задвоения не сломана перенумерацией.
  assert.deepEqual(
    batch.body.e.filter((e) => e.n !== 'app_ready').map((e) => e.q),
    [1, 2, 3],
  );
  // Раннее событие получило номер, продолжающий восстановленный счётчик.
  assert.equal(batch.body.e.find((e) => e.n === 'app_ready').q, 4);
});

/**
 * Пути по умолчанию (`sendBeacon`/`fetch` без подстановки `send`) — то
 * единственное, что реально работает в бою: все остальные тесты подставляют
 * свой `send` и не видят дыр именно здесь. Подменяем `navigator` и `fetch`
 * через `Object.defineProperty`, а не присваиванием: у Node глобальный
 * `navigator` — геттер без сеттера, и `globalThis.navigator = ...` в ESM
 * (строгий режим) молча бросает TypeError. Восстанавливаем оба глобальных
 * объекта в `finally`, чтобы подмена не протекла в соседние тесты даже при
 * падении текущего.
 */
function stubGlobals({ navigator: nav, fetch: fetchImpl }) {
  const originals = {
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    fetch: Object.getOwnPropertyDescriptor(globalThis, 'fetch'),
  };
  Object.defineProperty(globalThis, 'navigator', {
    value: nav, configurable: true, enumerable: true, writable: true,
  });
  Object.defineProperty(globalThis, 'fetch', {
    value: fetchImpl, configurable: true, enumerable: true, writable: true,
  });
  return () => {
    Object.defineProperty(globalThis, 'navigator', originals.navigator);
    Object.defineProperty(globalThis, 'fetch', originals.fetch);
  };
}

test('дефолтный sendBeacon: false не теряет пачку, возвращает её в очередь', async () => {
  const store = new Map();
  const storage = {
    get: async (key) => store.get(key) ?? null,
    set: async (key, value) => void store.set(key, value),
  };
  let beaconCalls = 0;
  const restore = stubGlobals({
    navigator: { sendBeacon: () => { beaconCalls += 1; return false; } },
    fetch: async (url) => {
      // Открытие сессии всегда идёт с beacon=false — через fetch.
      assert.ok(url.endsWith('/session'));
      return { ok: true, text: async () => JSON.stringify({ session_id: 'с1' }) };
    },
  });
  try {
    const client = createClient({ endpoint: '/v1/collect', app: 'word-chain', storage });
    await client.start(info);
    client.track('pause', { ms: 1 });
    await client.stop('pagehide'); // stop() шлёт через маяк (beacon=true)
    assert.equal(beaconCalls, 1);
    const saved = JSON.parse(store.get('analytics_queue'));
    // Пачка (pause + session_end) вернулась в очередь, а не потерялась.
    assert.deepEqual(saved.queue.map((e) => e.n), ['pause', 'session_end']);
  } finally {
    restore();
  }
});

test('дефолтный fetch: ответ не-2xx не теряет пачку, возвращает её в очередь', async () => {
  const store = new Map();
  const storage = {
    get: async (key) => store.get(key) ?? null,
    set: async (key, value) => void store.set(key, value),
  };
  let fetchCalls = 0;
  const restore = stubGlobals({
    navigator: undefined, // без sendBeacon — гарантированно проверяем именно fetch
    fetch: async (url) => {
      fetchCalls += 1;
      if (url.endsWith('/session')) {
        return { ok: true, text: async () => JSON.stringify({ session_id: 'с1' }) };
      }
      return { ok: false, status: 500, text: async () => 'бэкенд лёг' };
    },
  });
  try {
    const client = createClient({ endpoint: '/v1/collect', app: 'word-chain', storage });
    await client.start(info);
    client.track('pause', { ms: 1 });
    await client.flush();
    assert.equal(fetchCalls, 2); // /session + неудачная попытка пачки
    const saved = JSON.parse(store.get('analytics_queue'));
    assert.deepEqual(saved.queue.map((e) => e.n), ['pause']);
  } finally {
    restore();
  }
});

test('дефолтные sendBeacon и fetch на успехе очищают очередь как обычно', async () => {
  const store = new Map();
  const storage = {
    get: async (key) => store.get(key) ?? null,
    set: async (key, value) => void store.set(key, value),
  };
  let beaconBody = null;
  const restore = stubGlobals({
    navigator: { sendBeacon: (url, blob) => { beaconBody = blob; return true; } },
    fetch: async (url) => {
      if (url.endsWith('/session')) {
        return { ok: true, text: async () => JSON.stringify({ session_id: 'с1' }) };
      }
      return { ok: true, text: async () => null };
    },
  });
  try {
    const client = createClient({ endpoint: '/v1/collect', app: 'word-chain', storage });
    await client.start(info);
    client.track('pause', { ms: 1 });
    // Обычный flush — через fetch (beacon=false).
    await client.flush();
    let saved = JSON.parse(store.get('analytics_queue'));
    assert.deepEqual(saved.queue, []);

    // stop() — через sendBeacon (beacon=true), тоже должен очистить очередь.
    await client.stop('pagehide');
    assert.ok(beaconBody);
    saved = JSON.parse(store.get('analytics_queue'));
    assert.deepEqual(saved.queue, []);
  } finally {
    restore();
  }
});
