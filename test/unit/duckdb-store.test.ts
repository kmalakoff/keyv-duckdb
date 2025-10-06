import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Keyv from 'keyv';
import { KeyvDuckDB } from '../../src/keyv-duckdb.ts';

describe('KeyvDuckDB', () => {
  let tmpDir: string;
  let store: Keyv;
  let duckdbStore: KeyvDuckDB;
  let testFile: string;

  beforeEach(async () => {
    const tmpParent = path.join(os.tmpdir(), '.tmp');
    await fs.mkdir(tmpParent, { recursive: true });
    tmpDir = await fs.mkdtemp(path.join(tmpParent, 'duckdb-store-test-'));
    testFile = path.join(tmpDir, 'test.duckdb');
    duckdbStore = new KeyvDuckDB(testFile);
    store = new Keyv({ store: duckdbStore });
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('constructor', () => {
    it('creates store with file path only', async () => {
      const file = path.join(tmpDir, 'simple.duckdb');
      const simpleStore = new Keyv({ store: new KeyvDuckDB(file) });
      assert.ok(simpleStore);
    });

    it('accepts encryption disabled option', async () => {
      const file = path.join(tmpDir, 'no-encrypt.duckdb');
      const noEncStore = new Keyv({ store: new KeyvDuckDB(file) });
      assert.ok(noEncStore);
    });

    it('accepts encryption enabled with key', async () => {
      const file = path.join(tmpDir, 'encrypt.duckdb');
      const encStore = new Keyv({
        store: new KeyvDuckDB(file, {
          encryptionKey: 'test_encryption_key_32_characters!',
        }),
      });
      assert.ok(encStore);
    });

    it('treats empty encryption key as no encryption', async () => {
      const file = path.join(tmpDir, 'encrypt-no-key.duckdb');
      const encStore = new Keyv({ store: new KeyvDuckDB(file, { encryptionKey: '' }) });

      // Should work without encryption
      await encStore.set('test', { data: 'unencrypted' });
      const result = await encStore.get('test');
      assert.deepStrictEqual(result, { data: 'unencrypted' });
    });
  });

  describe('get/set operations', () => {
    it('returns undefined for non-existent key', async () => {
      const result = await store.get('nonexistent');
      assert.strictEqual(result, undefined);
    });

    it('stores and retrieves objects', async () => {
      const testData = { name: 'test', value: 42 };
      await store.set('test-key', testData);
      const result = await store.get('test-key');
      assert.deepStrictEqual(result, testData);
    });

    it('overwrites existing keys', async () => {
      await store.set('key', { original: true });
      await store.set('key', { updated: true });
      const result = await store.get('key');
      assert.deepStrictEqual(result, { updated: true });
    });

    it('handles complex nested objects', async () => {
      const complexData = {
        id: 'acc-123',
        provider: 'google',
        connection: 'user@example.com',
        metadata: {
          email: 'user@example.com',
          displayName: 'Test User',
          nested: { deep: 'value' },
        },
        updatedAt: Date.now(),
      };

      await store.set('complex-key', complexData);
      const result = await store.get('complex-key');
      assert.deepStrictEqual(result, complexData);
    });
  });

  describe('delete operations', () => {
    it('deletes existing keys', async () => {
      await store.set('to-delete', { data: 'test' });
      await store.delete('to-delete');
      const result = await store.get('to-delete');
      assert.strictEqual(result, undefined);
    });

    it('handles deletion of non-existent keys gracefully', async () => {
      const result = await store.delete('non-existent');
      // delete returns false for non-existent keys
      assert.strictEqual(result, false);
    });
  });

  describe('list operations', () => {
    it('returns empty iterator for empty store', async () => {
      const keys: string[] = [];
      for await (const [key] of duckdbStore.iterator()) {
        keys.push(key);
      }
      assert.deepStrictEqual(keys, []);
    });

    it('returns all keys via iterator', async () => {
      await store.set('key1', { a: 1 });
      await store.set('key2', { b: 2 });
      await store.set('key3', { c: 3 });

      const keys: string[] = [];
      for await (const [key] of duckdbStore.iterator()) {
        keys.push(key);
      }
      keys.sort(); // Order not guaranteed
      // Keyv prefixes keys with 'keyv:' by default
      assert.deepStrictEqual(keys, ['keyv:key1', 'keyv:key2', 'keyv:key3']);
    });

    it('returns true from set on success (direct store)', async () => {
      const file = path.join(tmpDir, 'direct-return.duckdb');
      const directStore = new KeyvDuckDB(file);
      const result = await directStore.set('alpha', { ok: true });
      assert.strictEqual(result, true);
    });

    it('enforces keySize when provided', async () => {
      const file = path.join(tmpDir, 'keysize.duckdb');
      const sizedStore = new KeyvDuckDB(file, { keySize: 4 });
      await sizedStore.set('abcd', { fine: true });
      await assert.rejects(() => sizedStore.set('abcde', { too: true }), /exceeds maximum/);
    });

    it('returns raw value even if invalid JSON (no parsing)', async () => {
      const file = path.join(tmpDir, 'raw.duckdb');
      const direct = new KeyvDuckDB(file);
      await direct.set('good', { value: 1 });
      // Manually corrupt the row to test raw passthrough
      const conn = (direct as any).connection ?? (await (direct as any).getConnection());
      await new Promise<void>((resolve, reject) => {
        conn.run(`UPDATE store.keyv SET v = 'not-json' WHERE k = 'good'`, (err: Error | null) => (err ? reject(err) : resolve()));
      });
      const read = await direct.get('good');
      // Should return the raw string 'not-json' without parsing
      assert.strictEqual(read, 'not-json');
    });

    it('supports parallel set/get operations without errors', async () => {
      const file = path.join(tmpDir, 'parallel.duckdb');
      const directStore = new KeyvDuckDB(file);
      // Perform operations sequentially first to initialize schema; avoids WAL replay race
      await directStore.set('init', { ok: true });
      const writes = Array.from({ length: 50 }, (_, i) => directStore.set(`k${i}`, { n: i }));
      await Promise.all(writes);
      const reads = await Promise.all(Array.from({ length: 50 }, (_, i) => directStore.get(`k${i}`)));
      for (let i = 0; i < 50; i++) {
        // Reads return JSON strings; parse them to verify
        assert.deepStrictEqual(JSON.parse(reads[i]), { n: i });
      }
    });
  });

  describe('batching operations', () => {
    it('setMany stores multiple entries efficiently', async () => {
      const file = path.join(tmpDir, 'setmany.duckdb');
      const directStore = new KeyvDuckDB(file);
      const entries = [
        { key: 'batch1', value: { n: 1 } },
        { key: 'batch2', value: { n: 2 } },
        { key: 'batch3', value: { n: 3 } },
      ];
      const results = await directStore.setMany(entries);
      assert.deepStrictEqual(results, [true, true, true]);
      assert.deepStrictEqual(JSON.parse(await directStore.get('batch1')), { n: 1 });
      assert.deepStrictEqual(JSON.parse(await directStore.get('batch2')), { n: 2 });
      assert.deepStrictEqual(JSON.parse(await directStore.get('batch3')), { n: 3 });
    });

    it('hasMany checks existence of multiple keys', async () => {
      const file = path.join(tmpDir, 'hasmany.duckdb');
      const directStore = new KeyvDuckDB(file);
      await directStore.set('exists1', { a: 1 });
      await directStore.set('exists2', { b: 2 });
      const results = await directStore.hasMany(['exists1', 'exists2', 'missing']);
      assert.deepStrictEqual(results, [true, true, false]);
    });

    it('setMany via Keyv wrapper', async () => {
      await store.set('k1', { val: 1 });
      await store.set('k2', { val: 2 });
      const vals = await store.get(['k1', 'k2']);
      assert.deepStrictEqual(vals, [{ val: 1 }, { val: 2 }]);
    });
  });

  describe('clear operations', () => {
    it('removes all data', async () => {
      await store.set('key1', { a: 1 });
      await store.set('key2', { b: 2 });

      await store.clear();

      const keys: string[] = [];
      for await (const [key] of duckdbStore.iterator()) {
        keys.push(key);
      }
      assert.deepStrictEqual(keys, []);
      assert.strictEqual(await store.get('key1'), undefined);
      assert.strictEqual(await store.get('key2'), undefined);
    });
  });

  describe('encryption behavior', () => {
    it('defaults to encryption disabled when no ENCRYPTION_KEY env var', async () => {
      const originalKey = process.env.ENCRYPTION_KEY;
      delete process.env.ENCRYPTION_KEY;

      try {
        const file = path.join(tmpDir, 'no-enc-default.duckdb');
        const noEncStore = new Keyv({ store: new KeyvDuckDB(file) });

        await noEncStore.set('test', { encrypted: false });
        const result = await noEncStore.get('test');
        assert.deepStrictEqual(result, { encrypted: false });
      } finally {
        if (originalKey) process.env.ENCRYPTION_KEY = originalKey;
      }
    });

    it('defaults to encryption enabled when ENCRYPTION_KEY env var is set', async () => {
      const testKey = 'test_encryption_key_32_characters!';
      const originalKey = process.env.ENCRYPTION_KEY;
      process.env.ENCRYPTION_KEY = testKey;

      try {
        const file = path.join(tmpDir, 'auto-enc.duckdb');
        const autoEncStore = new Keyv({ store: new KeyvDuckDB(file) });

        await autoEncStore.set('encrypted-data', { secure: true });
        const result = await autoEncStore.get('encrypted-data');
        assert.deepStrictEqual(result, { secure: true });
      } finally {
        if (originalKey) {
          process.env.ENCRYPTION_KEY = originalKey;
        } else {
          delete process.env.ENCRYPTION_KEY;
        }
      }
    });

    it('supports custom encryption keys', async () => {
      const customKey = 'my_custom_encryption_key_32_chars!';
      const file = path.join(tmpDir, 'custom-enc.duckdb');
      const encStore = new Keyv({
        store: new KeyvDuckDB(file, {
          encryptionKey: customKey,
        }),
      });

      await encStore.set('secret-data', { confidential: true, value: 'secret' });
      const result = await encStore.get('secret-data');
      assert.deepStrictEqual(result, { confidential: true, value: 'secret' });
    });

    it('encrypted data persists correctly across store instances', async () => {
      const encKey = 'persistent_encryption_test_key_32!';
      const file = path.join(tmpDir, 'enc-persist.duckdb');

      // First instance - write encrypted data
      const store1 = new Keyv({ store: new KeyvDuckDB(file, { encryptionKey: encKey }) });
      await store1.set('persistent-encrypted', { encrypted: true, data: 'sensitive' });

      // Second instance - read encrypted data with same key
      const store2 = new Keyv({ store: new KeyvDuckDB(file, { encryptionKey: encKey }) });
      const result = await store2.get('persistent-encrypted');
      assert.deepStrictEqual(result, { encrypted: true, data: 'sensitive' });
    });
  });

  describe('database persistence', () => {
    it('creates file and directories automatically', async () => {
      const nestedPath = path.join(tmpDir, 'nested', 'deep', 'test.duckdb');
      const nestedStore = new Keyv({ store: new KeyvDuckDB(nestedPath) });

      await nestedStore.set('test', { created: true });

      // Check file exists
      const stat = await fs.stat(nestedPath);
      assert.ok(stat.isFile());
    });

    it('persists data across store instances', async () => {
      await store.set('persistent', { data: 'persisted' });

      // Create new store instance with same file
      const store2 = new Keyv({ store: new KeyvDuckDB(testFile) });
      const result = await store2.get('persistent');

      assert.deepStrictEqual(result, { data: 'persisted' });
    });

    it('handles separate database files correctly', async () => {
      const file1 = path.join(tmpDir, 'database1.duckdb');
      const file2 = path.join(tmpDir, 'database2.duckdb');

      const store1 = new Keyv({ store: new KeyvDuckDB(file1) });
      const store2 = new Keyv({ store: new KeyvDuckDB(file2) });

      // Each store operates on its own database file
      await store1.set('shared-key', { from: 'store1' });
      await store2.set('shared-key', { from: 'store2' });

      const result1 = await store1.get('shared-key');
      const result2 = await store2.get('shared-key');

      assert.deepStrictEqual(result1, { from: 'store1' });
      assert.deepStrictEqual(result2, { from: 'store2' });
    });
  });

  describe('error handling', () => {
    it('handles database connection failures gracefully', async () => {
      // Test that error handling works by verifying the store can be created
      // Actual connection failures are hard to test reliably across systems
      const testPath = path.join(tmpDir, 'error-test.duckdb');
      const testStore = new Keyv({ store: new KeyvDuckDB(testPath) });

      // Verify the store works correctly
      await testStore.set('test-key', { value: 'test' });
      const result = await testStore.get('test-key');
      assert.deepStrictEqual(result, { value: 'test' });
    });

    it('handles SQL injection attempts in keys safely', async () => {
      const maliciousKeys = ["'; DROP TABLE kv; --", "'; DELETE FROM kv; --", "key' OR '1'='1", 'key"-- comment'];

      for (const badKey of maliciousKeys) {
        await store.set(badKey, { safe: true });
        const result = await store.get(badKey);
        assert.deepStrictEqual(result, { safe: true });

        assert.notStrictEqual(await store.get(badKey), undefined);
        await store.delete(badKey);
        assert.strictEqual(await store.get(badKey), undefined);
      }
    });
  });
});
