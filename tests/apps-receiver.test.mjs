import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReceiver } from '../src/server/receiver.mjs';
import { createSqliteSink, openAnalyticsDb } from '../src/server/sinks/sqlite.mjs';
import { createClient } from '../src/browser/client.mjs';

const KEY = 'ключ';

function setup(apps) {
  const db = openAnalyticsDb(':memory:');
  const sink = createSqliteSink(db);
  const receiver = createReceiver({ sink, key: KEY, apps, verify: () => ({ ok: false }), now: () => 10_000 });
  const open = (app) => receiver.session({ app, anon_id: 'а1', ctx: {} }).body.session_id;
  const events = (s) => db.prepare('SELECT name, known, props FROM events WHERE session_id = ? ORDER BY seq').all(s);
  return { db, receiver, open, events };
}

const BOTH = ['word-chain', 'image-uncovered'];
const levelLoad = { q: 1, n: 'level_load', t: 10_000, p: { mode: 'campaign', level_id: 'c1-l1', source: 'bundled' } };

test('K-7: событие IU в сессии word-chain незнакомо', () => {
  const { db, receiver, open, events } = setup(BOTH);
  const s = open('word-chain');
  receiver.collect({ s, a: 'word-chain', sent_at: 10_000, e: [levelLoad] });
  assert.deepEqual(events(s).map((e) => [e.name, e.known]), [['level_load', 0]]);
  db.close();
});

test('K-7: событие IU в сессии IU проверяется словарём IU', () => {
  const { db, receiver, open, events } = setup(BOTH);
  const s = open('image-uncovered');
  receiver.collect({ s, a: 'image-uncovered', sent_at: 10_000, e: [levelLoad] });
  const [row] = events(s);
  assert.equal(row.known, 1);
  assert.deepEqual(JSON.parse(row.props), levelLoad.p);
  db.close();
});

test('K-7: пачка с `a`, не равным приложению сессии, отбрасывается', () => {
  const { db, receiver, open, events } = setup(BOTH);
  const s = open('word-chain');
  receiver.collect({ s, a: 'image-uncovered', sent_at: 10_000, e: [levelLoad] });
  assert.equal(events(s).length, 0);
  db.close();
});

test('K-7: `a` чужого приложения отбрасывает пачку', () => {
  const { db, receiver, open, events } = setup(BOTH);
  const s = open('word-chain');
  receiver.collect({ s, a: 'чужое', sent_at: 10_000, e: [{ q: 1, n: 'pause', t: 10_000, p: { ms: 1 } }] });
  assert.equal(events(s).length, 0);
  db.close();
});

test('K-7: старый клиент без `a` у одноприложенного сервера работает как раньше', () => {
  const wc = setup(['word-chain']);
  const s1 = wc.open('word-chain');
  wc.receiver.collect({ s: s1, sent_at: 10_000, e: [{ q: 1, n: 'level_start', t: 10_000, p: { mode: 'daily', length: 5 } }] });
  const [row] = wc.events(s1);
  assert.equal(row.known, 1);
  assert.deepEqual(JSON.parse(row.props), { mode: 'daily', length: 5 });
  wc.db.close();

  // Одноприложенный сервер IU — словарь IU без `a`.
  const iu = setup(['image-uncovered']);
  const s2 = iu.open('image-uncovered');
  iu.receiver.collect({ s: s2, sent_at: 10_000, e: [levelLoad] });
  assert.equal(iu.events(s2)[0].known, 1);
  iu.db.close();
});

test('K-7: без `a` у многоприложенного сервера — только общая часть', () => {
  const { db, receiver, open, events } = setup(BOTH);
  const s = open('image-uncovered');
  receiver.collect({
    s, sent_at: 10_000,
    e: [levelLoad, { q: 2, n: 'pause', t: 10_000, p: { ms: 1 } }],
  });
  assert.deepEqual(events(s).map((e) => [e.name, e.known]), [['level_load', 0], ['pause', 1]]);
  db.close();
});

test('K-7: track() проверяет событие словарём своего приложения', () => {
  const { db, receiver } = setup(BOTH);
  receiver.track('image-uncovered', 'score_rejected', { board: 'daily', reason: 'rate' });
  const row = db.prepare("SELECT known, props FROM events WHERE name = 'score_rejected'").get();
  assert.equal(row.known, 1);
  assert.deepEqual(JSON.parse(row.props), { board: 'daily', reason: 'rate' });
  db.close();
});

test('K-7: клиент называет своё приложение в каждой пачке', async () => {
  const sent = [];
  const send = async (url, body) => {
    sent.push({ url, body: JSON.parse(body) });
    return url.endsWith('/session') ? JSON.stringify({ session_id: 'с1' }) : null;
  };
  const store = new Map();
  const storage = { get: async (k) => store.get(k) ?? null, set: async (k, v) => void store.set(k, v) };
  const client = createClient({ endpoint: '/v1/collect', app: 'image-uncovered', send, storage });
  client.track('pause', { ms: 1 });
  await client.start({ anonId: 'а1', launch: {}, ctx: {} });
  await client.flush();
  const batch = sent.find((r) => !r.url.endsWith('/session'));
  assert.equal(batch.body.a, 'image-uncovered');
});

test('K-8: purchase_credited из /v1/collect пишется незнакомым, через track() — знакомым', () => {
  const { db, receiver, open, events } = setup(BOTH);
  const s = open('image-uncovered');
  receiver.collect({
    s, a: 'image-uncovered', sent_at: 10_000,
    e: [{ q: 1, n: 'purchase_credited', t: 10_000, p: { source: 'вымысел', item_id: 'life-1', repeat: false } }],
  });
  const [fromClient] = events(s);
  assert.equal(fromClient.known, 0);
  // Свойства не проверяются словарём: значение вне перечисления не выброшено.
  assert.equal(JSON.parse(fromClient.props).source, 'вымысел');

  receiver.track('image-uncovered', 'purchase_credited', { source: 'vk', item_id: 'life-1', repeat: false });
  const fromServer = db.prepare(
    "SELECT known FROM events WHERE name = 'purchase_credited' AND session_id != ?",
  ).get(s);
  assert.equal(fromServer.known, 1);
  db.close();
});

test('K-8: все серверные события от клиента — незнакомые, в любом приложении', () => {
  const { db, receiver, open, events } = setup(BOTH);
  for (const app of BOTH) {
    const s = open(app);
    receiver.collect({
      s, a: app, sent_at: 10_000,
      e: ['purchase_credited', 'payment_rejected', 'score_rejected'].map((n, i) => ({ q: i + 1, n, t: 10_000, p: {} })),
    });
    assert.deepEqual(events(s).map((e) => e.known), [0, 0, 0], app);
  }
  db.close();
});
