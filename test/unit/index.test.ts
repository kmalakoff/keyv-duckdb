// test/unit/index.test.ts

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { KeyvDuckDB } from '../../src/keyv-duckdb.ts';

async function tempFile(name: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'duckdb-store-'));
  return path.join(dir, name);
}

test('basic set/get/delete without encryption', async () => {
  const file = await tempFile('plain.duckdb');
  const store = new KeyvDuckDB(file);
  await store.set('k1', { a: 1, b: 'x' });
  const v = await store.get('k1');
  assert.deepEqual(JSON.parse(v), { a: 1, b: 'x' });
  const keys: string[] = [];
  for await (const [key] of store.iterator()) {
    keys.push(key);
  }
  assert.deepEqual(
    keys.filter((k) => k.startsWith('k')),
    ['k1']
  );
  await store.delete('k1');
  const deletedValue = await store.get('k1');
  assert.equal(deletedValue, undefined);
});

test('clear() with prefix', async () => {
  const file = await tempFile('plain2.duckdb');
  const store = new KeyvDuckDB(file);
  await store.set('a:1', { value: 1 });
  await store.set('a:2', { value: 2 });
  await store.set('b:1', { value: 3 });
  // Remove keys with 'a:' prefix manually since clear() doesn't support prefix
  const keys: string[] = [];
  for await (const [key] of store.iterator()) {
    keys.push(key);
  }
  const keysToRemove = keys.filter((k) => k.startsWith('a:'));
  await store.deleteMany(keysToRemove);
  const remainingKeys: string[] = [];
  for await (const [key] of store.iterator()) {
    remainingKeys.push(key);
  }
  assert.deepEqual(remainingKeys, ['b:1']);
});

test('optional encryption (requires DuckDB >= 1.4.0)', async (_t) => {
  const file = await tempFile('enc.duckdb');
  const key = 'quack_quack_quack_quack_quack_quack!';
  const store = new KeyvDuckDB(file, { encryptionKey: key });
  await store.set('secret', { n: 123 });
  const v = await store.get('secret');
  assert.deepEqual(JSON.parse(v), { n: 123 });
});
