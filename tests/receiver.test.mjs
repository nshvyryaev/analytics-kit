import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReceiver } from '../src/server/receiver.mjs';
import { createSqliteSink, openAnalyticsDb } from '../src/server/sinks/sqlite.mjs';

const KEY = 'ключ';
const APPS = ['word-chain'];

function setup(verify = () => ({ ok: false })) {
  const db = openAnalyticsDb(':memory:');
  const sink = createSqliteSink(db);
  const receiver = createReceiver({ sink, key: KEY, apps: APPS, verify, now: () => 10_000 });
  return { db, receiver };
}

const ctx = { app_version: 'abc', language: 'ru', os: 'android', mobile: true, screen: 'sm', entry: 'direct' };

test('подписанный запуск даёт удостоверенную сессию площадки', () => {
  const { db, receiver } = setup(() => ({ ok: true, platform: 'vk', playerId: '42' }));
  const out = receiver.session({ app: 'word-chain', anon_id: 'а1', launch: {}, ctx });
  assert.equal(out.status, 200);
  const row = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(out.body.session_id);
  assert.equal(row.verified, 1);
  assert.equal(row.platform, 'vk');
  db.close();
});

test('без подписи сессия заводится, но помечается неудостоверенной', () => {
  const { db, receiver } = setup();
  const out = receiver.session({ app: 'word-chain', anon_id: 'а1', launch: {}, ctx });
  const row = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(out.body.session_id);
  assert.equal(row.verified, 0);
  assert.equal(row.platform, 'local');
  assert.equal(row.subject_id, row.anon_subject);
  db.close();
});

test('чужой ключ приложения отвергается', () => {
  const { db, receiver } = setup();
  assert.equal(receiver.session({ app: 'чужое', anon_id: 'а1', ctx }).status, 400);
  db.close();
});

test('сессия без анонимного идентификатора отвергается', () => {
  const { db, receiver } = setup();
  assert.equal(receiver.session({ app: 'word-chain', ctx }).status, 400);
  db.close();
});

test('часы клиента поправляются на разницу с сервером', () => {
  const { db, receiver } = setup();
  const { body } = receiver.session({ app: 'word-chain', anon_id: 'а1', ctx });
  // Клиент отстал на 5000 мс: отправил в 5000, у нас 10000.
  receiver.collect({ s: body.session_id, sent_at: 5000, e: [{ q: 1, n: 'pause', t: 4000, p: { ms: 1 } }] });
  const row = db.prepare('SELECT ts FROM events WHERE session_id = ?').get(body.session_id);
  assert.equal(row.ts, 9000);
  db.close();
});

test('незнакомое событие принимается с пометкой', () => {
  const { db, receiver } = setup();
  const { body } = receiver.session({ app: 'word-chain', anon_id: 'а1', ctx });
  receiver.collect({ s: body.session_id, sent_at: 10_000, e: [{ q: 1, n: 'выдумка', t: 10_000 }] });
  const row = db.prepare('SELECT known FROM events WHERE session_id = ?').get(body.session_id);
  assert.equal(row.known, 0);
  db.close();
});

test('пачка длиннее предела обрезается, а не роняет приём', () => {
  const { db, receiver } = setup();
  const { body } = receiver.session({ app: 'word-chain', anon_id: 'а1', ctx });
  const e = Array.from({ length: 250 }, (_, i) => ({ q: i + 1, n: 'pause', t: 10_000, p: { ms: 1 } }));
  assert.equal(receiver.collect({ s: body.session_id, sent_at: 10_000, e }).status, 204);
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM events').get();
  assert.equal(n, 100);
  db.close();
});

test('лимит на сессию режется по остатку бюджета, а не по факту его достижения', () => {
  const { db, receiver } = setup();
  const { body } = receiver.session({ app: 'word-chain', anon_id: 'а1', ctx });
  let q = 0;
  const send = (count) => {
    const e = Array.from({ length: count }, () => {
      q += 1;
      return { q, n: 'pause', t: 10_000, p: { ms: 1 } };
    });
    return receiver.collect({ s: body.session_id, sent_at: 10_000, e });
  };
  for (let i = 0; i < 49; i += 1) send(100); // seen = 4900
  send(50); // seen = 4950, остаток бюджета — 50
  send(100); // пачка больше остатка: должно записаться только 50, а не 100
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM events').get();
  assert.equal(n, 5000);
  db.close();
});

test('неизвестная сессия не роняет приём', () => {
  const { db, receiver } = setup();
  assert.equal(receiver.collect({ s: 'нет-такой', sent_at: 10_000, e: [] }).status, 204);
  db.close();
});

test('серверное событие пишется без клиентской сессии', () => {
  const { db, receiver } = setup();
  receiver.track('word-chain', 'purchase_credited', { source: 'vk', hints: 5 });
  const row = db.prepare("SELECT * FROM events WHERE name = 'purchase_credited'").get();
  assert.ok(row);
  const session = db.prepare('SELECT platform FROM sessions WHERE session_id = ?').get(row.session_id);
  assert.equal(session.platform, 'server');
  db.close();
});
