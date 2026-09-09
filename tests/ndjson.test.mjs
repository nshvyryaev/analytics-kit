import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNdjsonSink } from '../src/server/sinks/ndjson.mjs';

test('сессия и события дописываются строками', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ndjson-'));
  const file = join(dir, 'out.ndjson');
  const sink = createNdjsonSink(file);
  sink.session({ session_id: 'с1', app: 'word-chain' });
  sink.events([{ session_id: 'с1', seq: 1, name: 'pause' }]);
  sink.close();

  const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].kind, 'session');
  assert.equal(lines[1].kind, 'event');
  assert.equal(lines[1].name, 'pause');
  rmSync(dir, { recursive: true, force: true });
});

test('пустая пачка ничего не пишет', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ndjson-'));
  const file = join(dir, 'out.ndjson');
  const sink = createNdjsonSink(file);
  assert.equal(sink.events([]), 0);
  sink.close();
  assert.equal(readFileSync(file, 'utf8'), '');
  rmSync(dir, { recursive: true, force: true });
});
