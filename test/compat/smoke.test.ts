// test/compat/smoke.test.ts
// Minimal compatibility test for multi-version Node testing via nvu

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Keyv from 'keyv';
import { KeyvDuckDB } from '../../src/keyv-duckdb.ts';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keyv-duckdb-compat-'));
const dbFile = path.join(tmpDir, 'smoke.duckdb');

try {
  // Test 1: Basic Keyv-wrapped set/get
  const store = new Keyv({ store: new KeyvDuckDB(dbFile) });
  await store.set('test-key', { value: 42, text: 'hello' });
  const result = await store.get('test-key');
  assert.deepStrictEqual(result, { value: 42, text: 'hello' }, 'Keyv-wrapped get/set failed');

  // Test 2: Direct adapter usage (returns JSON string)
  const direct = new KeyvDuckDB(dbFile);
  await direct.set('direct-key', { n: 100 });
  const directResult = await direct.get('direct-key');
  assert.deepStrictEqual(JSON.parse(directResult), { n: 100 }, 'Direct adapter get/set failed');

  // Test 3: Batching
  await direct.setMany([
    { key: 'batch1', value: { a: 1 } },
    { key: 'batch2', value: { b: 2 } },
  ]);
  const hasResults = await direct.hasMany(['batch1', 'batch2', 'missing']);
  assert.deepStrictEqual(hasResults, [true, true, false], 'hasMany failed');

  // Test 4: Delete
  await store.set('to-delete', { temp: true });
  const deleted = await store.delete('to-delete');
  assert.strictEqual(deleted, true, 'Delete failed');
  assert.strictEqual(await store.get('to-delete'), undefined, 'Deleted key still exists');

  console.log('✓ All compatibility tests passed');
} catch (err) {
  console.error('✗ Compatibility test failed:', err);
  process.exit(1);
} finally {
  // Cleanup
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}
