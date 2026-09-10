import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReceiver } from '../src/server/receiver.mjs';
import { createSqliteSink, openAnalyticsDb } from '../src/server/sinks/sqlite.mjs';
import { playerSubject } from '../src/server/identity.mjs';

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

test('серверная псевдосессия заводится заново на следующий день', () => {
  // Без суточного ключа одна серверная сессия копит события месяцами и
  // никогда не отсекается prune()-ом (см. rollup.test.mjs). Здесь проверяем
  // именно ключевание кэша: на новый день — новый session_id.
  let clock = Date.parse('2026-09-09T12:00:00Z');
  const db = openAnalyticsDb(':memory:');
  const sink = createSqliteSink(db);
  const receiver = createReceiver({ sink, key: KEY, apps: APPS, verify: () => ({ ok: false }), now: () => clock });

  receiver.track('word-chain', 'purchase_credited', { source: 'vk', hints: 5 });
  const first = db.prepare("SELECT session_id, day FROM sessions WHERE platform = 'server'").all();
  assert.equal(first.length, 1);
  assert.equal(first[0].day, '2026-09-09');

  // Второе событие в тот же день переиспользует ту же сессию.
  receiver.track('word-chain', 'purchase_credited', { source: 'vk', hints: 5 });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE platform = 'server'").get().n, 1);

  clock = Date.parse('2026-09-10T00:30:00Z');
  receiver.track('word-chain', 'purchase_credited', { source: 'vk', hints: 5 });
  const all = db.prepare("SELECT session_id, day FROM sessions WHERE platform = 'server' ORDER BY day").all();
  assert.equal(all.length, 2);
  assert.equal(all[1].day, '2026-09-10');
  assert.notEqual(all[0].session_id, all[1].session_id);
  db.close();
});

test('серверные счётчики не делят карту с клиентскими: поток клиентских сессий не топит серверное событие', () => {
  // Регрессия I3: до фикса счётчик серверной псевдосессии жил в общей карте
  // `counts` вместе с клиентскими. Карта вытесняет самую старую запись по
  // переполнению потолка (MAX_COUNTS_ENTRIES = 10 000), а серверная
  // псевдосессия заводится ПЕРВОЙ в жизни процесса — значит вытеснялась
  // первой. После вытеснения её seq в track() снова начинался с 1, и
  // `INSERT OR IGNORE` по (session_id, seq) в sqlite.mjs тихо отбрасывал
  // второе серверное событие как повтор первого.
  const { db, receiver } = setup();

  receiver.track('word-chain', 'purchase_credited', { source: 'vk', hints: 5 });

  for (let i = 0; i < 10_000; i += 1) {
    const { body } = receiver.session({ app: 'word-chain', anon_id: `а${i}`, ctx });
    receiver.collect({ s: body.session_id, sent_at: 10_000, e: [{ q: 1, n: 'pause', t: 10_000, p: { ms: 1 } }] });
  }

  receiver.track('word-chain', 'purchase_credited', { source: 'vk', hints: 5 });
  const rows = db.prepare(
    "SELECT e.seq AS seq FROM events e JOIN sessions s ON s.session_id = e.session_id WHERE s.platform = 'server' ORDER BY e.seq",
  ).all();
  assert.deepEqual(rows.map((row) => row.seq), [1, 2]);
  db.close();
});

test('событие с привязкой к игроку ложится в его сессию, а не в общую "server"', () => {
  const { db, receiver } = setup();
  receiver.track('word-chain', 'purchase_credited', { source: 'vk', item_id: 'hints-10', hints: 10 }, { platform: 'vk', playerId: '42' });

  const row = db.prepare("SELECT session_id FROM events WHERE name = 'purchase_credited'").get();
  const session = db.prepare('SELECT subject_id, anon_subject, platform FROM sessions WHERE session_id = ?').get(row.session_id);
  assert.notEqual(session.subject_id, 'server');
  assert.equal(session.platform, 'vk');
  // Тот же игрок псевдонимизируется той же функцией, что и клиентские сессии.
  assert.equal(session.subject_id, playerSubject('vk', '42', KEY));
  assert.equal(session.anon_subject, session.subject_id);
  db.close();
});

test('тот же игрок в тот же день переиспользует свою серверную сессию', () => {
  const { db, receiver } = setup();
  const identity = { platform: 'vk', playerId: '42' };
  receiver.track('word-chain', 'purchase_credited', { source: 'vk', hints: 10 }, identity);
  receiver.track('word-chain', 'purchase_credited', { source: 'vk', hints: 5 }, identity);

  const sessions = db.prepare("SELECT session_id FROM sessions WHERE platform = 'vk'").all();
  assert.equal(sessions.length, 1);
  const events = db.prepare('SELECT seq FROM events WHERE session_id = ? ORDER BY seq').all(sessions[0].session_id);
  assert.deepEqual(events.map((e) => e.seq), [1, 2]);
  db.close();
});

test('разные игроки в один день получают разные серверные сессии', () => {
  const { db, receiver } = setup();
  receiver.track('word-chain', 'purchase_credited', { source: 'vk', hints: 10 }, { platform: 'vk', playerId: '1' });
  receiver.track('word-chain', 'purchase_credited', { source: 'vk', hints: 10 }, { platform: 'vk', playerId: '2' });

  const subjects = db.prepare("SELECT DISTINCT subject_id FROM sessions WHERE platform = 'vk'").all();
  assert.equal(subjects.length, 2);
  db.close();
});

test('событие без привязки по-прежнему идёт на общую серверную псевдосессию', () => {
  const { db, receiver } = setup();
  receiver.track('word-chain', 'payment_rejected', { source: 'vk', reason: 'bad_signature' });
  const row = db.prepare("SELECT subject_id, platform FROM sessions WHERE platform = 'server'").get();
  assert.ok(row);
  assert.equal(row.subject_id, 'server');
  db.close();
});
