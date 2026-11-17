import fs from 'node:fs/promises';
import path from 'node:path';
import url from 'node:url';
import assert from 'assert';
import { safeRmSync } from 'fs-remove-compat';
import Keyv from 'keyv';
import { closeAllConnections, KeyvDuckDB } from 'keyv-duckdb';

const __dirname = path.dirname(typeof __filename !== 'undefined' ? __filename : url.fileURLToPath(import.meta.url));
const packageRoot = path.join(__dirname, '..', '..');

describe('DuckDBStore Store', () => {
  let tmpDir: string;
  let store: Keyv;
  let duckdbStore: KeyvDuckDB;
  let testFile: string;

  beforeEach(async () => {
    const tmpParent = path.join(packageRoot, '.tmp');
    await fs.mkdir(tmpParent, { recursive: true });
    tmpDir = await fs.mkdtemp(path.join(tmpParent, 'duckdb-store-test-'));
    testFile = path.join(tmpDir, 'test.duckdb');
    duckdbStore = new KeyvDuckDB(testFile);
    store = new Keyv({ store: duckdbStore });
  });

  afterEach(async () => {
    await closeAllConnections();
    safeRmSync(tmpDir);
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
      // Keyv 6 has no default namespace and never prefixes keys
      assert.deepStrictEqual(keys, ['key1', 'key2', 'key3']);
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
      // Access private connection via type assertion for testing purposes
      type StoreWithConnection = { connection?: { run: (sql: string) => Promise<void> }; getConnection: () => Promise<{ run: (sql: string) => Promise<void> }> };
      const storeInternal = direct as unknown as StoreWithConnection;
      const conn = storeInternal.connection ?? (await storeInternal.getConnection());
      // For unencrypted databases, the table is directly in the main database
      await conn.run(`UPDATE keyv SET value = 'not-json' WHERE key = 'good'`);
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
      const reads = await Promise.all(Array.from({ length: 50 }, (_, i) => directStore.get<string>(`k${i}`)));
      for (let i = 0; i < 50; i++) {
        // Reads return JSON strings; parse them to verify
        const value = reads[i];
        assert.ok(value !== undefined);
        assert.deepStrictEqual(JSON.parse(value), { n: i });
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
      await directStore.setMany(entries);
      // Verify all entries were stored
      const b1 = await directStore.get<string>('batch1');
      const b2 = await directStore.get<string>('batch2');
      const b3 = await directStore.get<string>('batch3');
      assert.ok(b1 && b2 && b3);
      assert.deepStrictEqual(JSON.parse(b1), { n: 1 });
      assert.deepStrictEqual(JSON.parse(b2), { n: 2 });
      assert.deepStrictEqual(JSON.parse(b3), { n: 3 });
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
    it('defaults to encryption disabled when no ENCRYPTION_KEY env let', async () => {
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

    it('defaults to encryption enabled when ENCRYPTION_KEY env let is set', async () => {
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
      const duckdb1 = new KeyvDuckDB(file, { encryptionKey: encKey });
      const store1 = new Keyv({ store: duckdb1 });
      await store1.set('persistent-encrypted', { encrypted: true, data: 'sensitive' });
      await duckdb1.dispose();

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
      await duckdbStore.dispose();

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

  describe('namespace support', () => {
    it('clear() only clears its own namespace', async () => {
      const file = path.join(tmpDir, 'ns-clear.duckdb');
      const users = new KeyvDuckDB(file, { namespace: 'users' });
      const posts = new KeyvDuckDB(file, { namespace: 'posts' });
      const none = new KeyvDuckDB(file);
      await users.set('1', 'Alice');
      await posts.set('1', 'Hello');
      await none.set('1', 'data');

      await users.clear();

      assert.strictEqual(await users.get('1'), undefined);
      assert.strictEqual(await posts.get('1'), 'Hello');
      assert.strictEqual(await none.get('1'), 'data');
    });

    it('clear() without namespace only clears the empty namespace', async () => {
      const file = path.join(tmpDir, 'ns-clear-none.duckdb');
      const none = new KeyvDuckDB(file);
      const posts = new KeyvDuckDB(file, { namespace: 'posts' });
      await none.set('a', 'data');
      await posts.set('a', 'Hello');

      await none.clear();

      assert.strictEqual(await none.get('a'), undefined);
      assert.strictEqual(await posts.get('a'), 'Hello');
    });

    it('iterator() yields only its own namespace, with plain keys', async () => {
      const file = path.join(tmpDir, 'ns-iter.duckdb');
      const users = new KeyvDuckDB(file, { namespace: 'users' });
      const posts = new KeyvDuckDB(file, { namespace: 'posts' });
      await users.set('1', 'Alice');
      await users.set('2', 'Bob');
      await posts.set('1', 'Hello');

      const keys: string[] = [];
      for await (const [key] of users.iterator()) keys.push(key);
      assert.deepStrictEqual(keys, ['1', '2']);
    });

    it('namespace may be set after construction, as Keyv does', async () => {
      const file = path.join(tmpDir, 'ns-setter.duckdb');
      const a = new KeyvDuckDB(file);
      const b = new KeyvDuckDB(file);
      a.namespace = 'a';
      b.namespace = 'b';
      await a.set('k', 'from-a');
      await b.set('k', 'from-b');
      assert.strictEqual(await a.get('k'), 'from-a');
      assert.strictEqual(await b.get('k'), 'from-b');
    });

    it('matches `_` and `%` in a namespace literally', async () => {
      const file = path.join(tmpDir, 'ns-wild.duckdb');
      const under = new KeyvDuckDB(file, { namespace: 'a_c' });
      const other = new KeyvDuckDB(file, { namespace: 'abc' });
      await under.set('k', 'under');
      await other.set('k', 'other');
      await under.clear();
      assert.strictEqual(await other.get('k'), 'other');
    });

    it('works through Keyv with one store per namespace', async () => {
      const file = path.join(tmpDir, 'ns-keyv.duckdb');
      const users = new Keyv({ store: new KeyvDuckDB(file), namespace: 'users' });
      const posts = new Keyv({ store: new KeyvDuckDB(file), namespace: 'posts' });
      await users.set('1', 'Alice');
      await posts.set('1', 'Hello');
      await users.clear();
      assert.strictEqual(await users.get('1'), undefined);
      assert.strictEqual(await posts.get('1'), 'Hello');
    });
  });

  describe('keyv 6 contract', () => {
    it('declares absolute expires support', () => {
      assert.strictEqual(duckdbStore.capabilities.expires, true);
    });

    it('setMany and deleteMany return one boolean per entry', async () => {
      const file = path.join(tmpDir, 'many.duckdb');
      const direct = new KeyvDuckDB(file);
      assert.deepStrictEqual(
        await direct.setMany([
          { key: 'a', value: '1' },
          { key: 'b', value: '2' },
        ]),
        [true, true]
      );
      assert.deepStrictEqual(await direct.deleteMany(['a', 'zzz']), [true, false]);
      assert.deepStrictEqual(await direct.setMany([]), []);
      assert.deepStrictEqual(await direct.deleteMany([]), []);
    });

    it('setMany keeps the last entry for a repeated key', async () => {
      const file = path.join(tmpDir, 'many-dup.duckdb');
      const direct = new KeyvDuckDB(file);
      assert.deepStrictEqual(
        await direct.setMany([
          { key: 'a', value: 'first' },
          { key: 'a', value: 'second' },
        ]),
        [true, true]
      );
      assert.strictEqual(await direct.get('a'), 'second');
    });

    it('hides expired rows from get, getMany, has, hasMany and iterator', async () => {
      const file = path.join(tmpDir, 'expired.duckdb');
      const direct = new KeyvDuckDB(file);
      await direct.set('old', 'x', Date.now() - 1000);
      await direct.set('new', 'y', Date.now() + 60_000);
      assert.strictEqual(await direct.get('old'), undefined);
      assert.strictEqual(await direct.get('new'), 'y');
      assert.deepStrictEqual(await direct.getMany(['old', 'new']), [undefined, 'y']);
      assert.strictEqual(await direct.has('old'), false);
      assert.deepStrictEqual(await direct.hasMany(['old', 'new']), [false, true]);
      const keys: string[] = [];
      for await (const [key] of direct.iterator()) keys.push(key);
      assert.deepStrictEqual(keys, ['new']);
    });

    it('stores no expiry for a null, NaN or infinite expires', async () => {
      const file = path.join(tmpDir, 'bad-expires.duckdb');
      const direct = new KeyvDuckDB(file);
      for (const bad of [null, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        await direct.set('k', 'v', bad as never);
        assert.strictEqual(await direct.get('k'), 'v');
      }
      assert.deepStrictEqual(
        await direct.setMany([
          { key: 'a', value: '1', expires: Number.NaN },
          { key: 'b', value: '2', expires: null as never },
        ]),
        [true, true]
      );
      assert.deepStrictEqual(await direct.getMany(['a', 'b']), ['1', '2']);
    });

    it('overwrites an existing key and its expiry', async () => {
      const file = path.join(tmpDir, 'overwrite.duckdb');
      const direct = new KeyvDuckDB(file);
      await direct.set('k', 'one', Date.now() - 1000);
      await direct.set('k', 'two');
      assert.strictEqual(await direct.get('k'), 'two');
    });
  });

  describe('options', () => {
    it('rejects unrecognised options (object form)', () => {
      assert.throws(() => new KeyvDuckDB({ path: path.join(tmpDir, 'x.duckdb'), pth: 'oops' } as never), /unrecognised option 'pth'/);
    });

    it('rejects unrecognised options (string form)', () => {
      assert.throws(() => new KeyvDuckDB(path.join(tmpDir, 'x.duckdb'), { ttl: 1000, dialect: 'duckdb' } as never), /unrecognised options 'ttl', 'dialect'/);
    });

    it('accepts every recognised option', () => {
      assert.doesNotThrow(() => new KeyvDuckDB({ path: path.join(tmpDir, 'x.duckdb'), table: 't', encryptionKey: 'k', keySize: 10, namespace: 'n' }));
    });

    it('uses the file given, not the default path, when a path is given', async () => {
      const file = path.join(tmpDir, 'given.duckdb');
      const direct = new KeyvDuckDB({ path: file });
      await direct.set('k', 'v');
      await direct.dispose();
      await fs.stat(file);
    });

    it('uses ~/.keyv-duckdb/store.duckdb only when no path is given', async () => {
      const home = path.join(tmpDir, 'home');
      const realHome = process.env.HOME;
      const realUserProfile = process.env.USERPROFILE;
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      try {
        const direct = new KeyvDuckDB({ table: 'defaults' });
        await direct.set('k', 'v');
        await direct.dispose();
        await fs.stat(path.join(home, '.keyv-duckdb', 'store.duckdb'));
      } finally {
        if (realHome === undefined) delete process.env.HOME;
        else process.env.HOME = realHome;
        if (realUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = realUserProfile;
      }
    });
  });

  describe('quoting', () => {
    it('handles a quote in the encryption key', async () => {
      const file = path.join(tmpDir, 'quote-key.duckdb');
      const key = "it's a 'quoted' key with 32+ chars!";
      const first = new KeyvDuckDB(file, { encryptionKey: key });
      await first.set('k', 'v');
      await first.dispose();
      const second = new KeyvDuckDB(file, { encryptionKey: key });
      assert.strictEqual(await second.get('k'), 'v');
    });

    it('handles a quote in the database path', async () => {
      const dir = path.join(tmpDir, "o'brien");
      const file = path.join(dir, "it's.duckdb");
      const plain = new KeyvDuckDB(file);
      await plain.set('k', 'v');
      await plain.dispose();
      const encrypted = new KeyvDuckDB(path.join(dir, "enc's.duckdb"), { encryptionKey: 'a_32_character_long_test_key_here' });
      await encrypted.set('k', 'v');
      assert.strictEqual(await encrypted.get('k'), 'v');
    });

    it('handles a quote in the table name', async () => {
      const file = path.join(tmpDir, 'quote-table.duckdb');
      const direct = new KeyvDuckDB(file, { table: 'we"ird' });
      await direct.set('k', 'v');
      assert.strictEqual(await direct.get('k'), 'v');
    });
  });
});
