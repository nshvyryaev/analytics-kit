import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReceiver } from '../src/server/receiver.mjs';
import { createSqliteSink, openAnalyticsDb } from '../src/server/sinks/sqlite.mjs';
import { rollup } from '../src/server/rollup.mjs';

const KEY = 'ключ';
const AT = Date.UTC(2026, 9, 1, 12);
const DAY = '2026-10-01';

function setup() {
  const db = openAnalyticsDb(':memory:');
  const sink = createSqliteSink(db);
  const receiver = createReceiver({
    sink, key: KEY, apps: ['word-chain', 'image-uncovered'], now: () => AT,
    // Подписанный запуск — только у launch.signed; площадка из подписи.
    verify: (launch) => (launch.signed ? { ok: true, platform: launch.signed, playerId: '42' } : { ok: false }),
  });
  const open = (app, ctx, launch) =>
    receiver.session({ app, anon_id: `а-${Math.random()}`, ctx, launch }).body.session_id;
  const clientPlatform = (s) =>
    db.prepare('SELECT client_platform FROM sessions WHERE session_id = ?').get(s).client_platform;
  const daily = (app, platform, metric) =>
    db.prepare('SELECT value FROM daily WHERE app = ? AND day = ? AND platform = ? AND metric = ?')
      .get(app, DAY, platform, metric)?.value;
  return { db, open, clientPlatform, daily };
}

test('K-10: ctx.platform IU пишется в sessions.client_platform по перечислению', () => {
  const { db, open, clientPlatform } = setup();
  assert.equal(clientPlatform(open('image-uncovered', { platform: 'yandex' })), 'yandex');
  assert.equal(clientPlatform(open('image-uncovered', { platform: 'марс' })), null);
  assert.equal(clientPlatform(open('image-uncovered', {})), null);
  db.close();
});

test('K-10: у word-chain ctx.platform не пишется — приложения нет в SESSION_CTX', () => {
  const { db, open, clientPlatform } = setup();
  assert.equal(clientPlatform(open('word-chain', { platform: 'yandex' })), null);
  db.close();
});

test('K-10: гость Яндекса попадает в daily с platform = yandex', () => {
  const { db, open, daily } = setup();
  open('image-uncovered', { platform: 'yandex' });
  open('image-uncovered', { platform: 'yandex' });
  open('image-uncovered', {});
  rollup(db, DAY);
  assert.equal(daily('image-uncovered', 'yandex', 'dau'), 2);
  assert.equal(daily('image-uncovered', 'local', 'dau'), 1);
  db.close();
});

test('K-10: у удостоверённой сессии площадка — из подписи, client_platform не решает', () => {
  const { db, open, daily } = setup();
  open('image-uncovered', { platform: 'yandex' }, { signed: 'vk' });
  rollup(db, DAY);
  assert.equal(daily('image-uncovered', 'vk', 'dau'), 1);
  assert.equal(daily('image-uncovered', 'yandex', 'dau'), undefined);
  db.close();
});

test('K-10: у word-chain разбивка прежняя, даже если клиент прислал ctx.platform', () => {
  const { db, open, daily } = setup();
  open('word-chain', { platform: 'yandex' });
  rollup(db, DAY);
  assert.equal(daily('word-chain', 'local', 'dau'), 1);
  db.close();
});

test('K-10: миграция базы v0.2.8 добавляет sessions.client_platform', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kit-k10-'));
  const file = join(dir, 'old.db');
  const old = new DatabaseSync(file);
  // Таблица sessions в составе v0.2.8 — без client_platform.
  old.exec(`CREATE TABLE sessions (
    session_id TEXT PRIMARY KEY, app TEXT NOT NULL, subject_id TEXT NOT NULL, anon_subject TEXT NOT NULL,
    key_version INTEGER NOT NULL, platform TEXT NOT NULL, verified INTEGER NOT NULL, app_version TEXT,
    language TEXT, os TEXT, mobile INTEGER, screen TEXT, entry TEXT,
    server_origin INTEGER NOT NULL DEFAULT 0, day TEXT NOT NULL, started_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL, events INTEGER NOT NULL DEFAULT 0)`);
  old.exec(`INSERT INTO sessions (session_id, app, subject_id, anon_subject, key_version, platform, verified,
    day, started_at, last_seen_at) VALUES ('с0', 'word-chain', 'п', 'п', 1, 'local', 0, '${DAY}', 1, 1)`);
  old.close();

  const db = openAnalyticsDb(file);
  const columns = db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
  assert.ok(columns.includes('client_platform'));
  assert.equal(db.prepare("SELECT client_platform FROM sessions WHERE session_id = 'с0'").get().client_platform, null);
  rollup(db, DAY);
  assert.equal(db.prepare("SELECT platform FROM daily WHERE metric = 'dau'").get().platform, 'local');
  db.close();
  openAnalyticsDb(file).close();
  rmSync(dir, { recursive: true, force: true });
});
