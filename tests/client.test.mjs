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
  assert.ok(broken.store.get('analytics.queue'));

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
