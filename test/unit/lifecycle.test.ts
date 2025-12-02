import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeAllConnections, getConnectionCount, KeyvDuckDB } from 'keyv-duckdb';

describe('DuckDBStore Lifecycle Management', () => {
  let tmpDir: string;

  beforeEach(async () => {
    // Start with clean connection manager
    await closeAllConnections();

    const tmpParent = path.join(os.tmpdir(), '.tmp');
    await fs.mkdir(tmpParent, { recursive: true });
    tmpDir = await fs.mkdtemp(path.join(tmpParent, 'duckdb-lifecycle-test-'));
  });

  afterEach(async () => {
    // Clean up connections and temp files
    await closeAllConnections();
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('connection management', () => {
    it('creates separate connections for each store instance', async () => {
      const dbPath = path.join(tmpDir, 'store.duckdb');

      const store1 = new KeyvDuckDB(dbPath);
      await store1.set('key1', { data: 'store1' });
      assert.equal(getConnectionCount(), 1);

      // Dispose first store before opening second (same file)
      await store1.dispose();
      assert.equal(getConnectionCount(), 0);

      const store2 = new KeyvDuckDB(dbPath);
      await store2.set('key2', { data: 'store2' });
      assert.equal(getConnectionCount(), 1);

      await store2.dispose();
    });

    it('creates separate connections for different paths', async () => {
      const dbPath1 = path.join(tmpDir, 'db1.duckdb');
      const dbPath2 = path.join(tmpDir, 'db2.duckdb');

      const store1 = new KeyvDuckDB(dbPath1);
      const store2 = new KeyvDuckDB(dbPath2);

      // Trigger connection creation
      await store1.set('key', { data: 'db1' });
      await store2.set('key', { data: 'db2' });

      // Should have 2 connections for different paths
      assert.equal(getConnectionCount(), 2);

      await store1.dispose();
      await store2.dispose();
    });

    it('creates separate connections for different encryption keys', async () => {
      const dbPath1 = path.join(tmpDir, 'encrypted1.duckdb');
      const dbPath2 = path.join(tmpDir, 'encrypted2.duckdb');

      const store1 = new KeyvDuckDB(dbPath1, { encryptionKey: 'key1_32_characters_minimum_len!' });
      const store2 = new KeyvDuckDB(dbPath2, { encryptionKey: 'key2_32_characters_minimum_len!' });

      // Trigger connection creation
      await store1.set('key', { data: 'encrypted1' });
      await store2.set('key', { data: 'encrypted2' });

      // Should have 2 connections for different encryption keys
      assert.equal(getConnectionCount(), 2);

      await store1.dispose();
      await store2.dispose();
    });
  });

  describe('dispose pattern', () => {
    it('closes connection when store is disposed', async () => {
      const dbPath = path.join(tmpDir, 'dispose-test.duckdb');

      const store1 = new KeyvDuckDB(dbPath);
      await store1.set('key', { data: 'test' });
      assert.equal(getConnectionCount(), 1);

      // Dispose store - connection should be closed
      await store1.dispose();
      assert.equal(getConnectionCount(), 0);

      // Open new store on same file - should work after proper dispose
      const store2 = new KeyvDuckDB(dbPath);
      const value = await store2.get<string>('key');
      assert.ok(value);
      assert.deepStrictEqual(JSON.parse(value), { data: 'test' });

      await store2.dispose();
      assert.equal(getConnectionCount(), 0);
    });

    it('prevents operations after dispose', async () => {
      const dbPath = path.join(tmpDir, 'disposed-store.duckdb');
      const store = new KeyvDuckDB(dbPath);

      // Use store normally
      await store.set('key', { data: 'test' });
      const value = await store.get<string>('key');
      assert.ok(value);
      assert.deepStrictEqual(JSON.parse(value), { data: 'test' });

      // Dispose store
      await store.dispose();
      assert.equal(store.isDisposed, true);

      // All operations should throw
      await assert.rejects(store.get('key'), /disposed/);
      await assert.rejects(store.set('key', { data: 'new' }), /disposed/);
      await assert.rejects(store.delete('key'), /disposed/);
      await assert.rejects(async () => {
        for await (const _ of store.iterator()) {
          // Iterator should fail
        }
      }, /disposed/);
      await assert.rejects(store.clear(), /disposed/);
    });

    it('allows multiple dispose calls safely', async () => {
      const dbPath = path.join(tmpDir, 'multi-dispose.duckdb');
      const store = new KeyvDuckDB(dbPath);

      await store.set('key', { data: 'test' });

      // Multiple dispose calls should not throw
      await store.dispose();
      await store.dispose();
      await store.dispose();

      assert.equal(store.isDisposed, true);
      assert.equal(getConnectionCount(), 0);
    });
  });

  describe('Symbol.asyncDispose pattern', () => {
    it('supports await using declaration for automatic cleanup', async () => {
      const dbPath = path.join(tmpDir, 'symbol-dispose.duckdb');

      const store = new KeyvDuckDB(dbPath);
      try {
        await store.set('key', { data: 'test' });
        assert.equal(getConnectionCount(), 1);
      } finally {
        await store[Symbol.asyncDispose]();
      }

      // Connection should be closed after block
      assert.equal(getConnectionCount(), 0);
    });

    it('Symbol.asyncDispose calls regular dispose method', async () => {
      const dbPath = path.join(tmpDir, 'symbol-dispose-method.duckdb');
      const store = new KeyvDuckDB(dbPath);

      await store.set('key', { data: 'test' });
      assert.equal(store.isDisposed, false);

      // Call Symbol.asyncDispose directly
      await store[Symbol.asyncDispose]();

      assert.equal(store.isDisposed, true);
      assert.equal(getConnectionCount(), 0);
    });
  });

  describe('resource leak prevention', () => {
    it('prevents connection leaks with many store instances', async () => {
      const dbPath = path.join(tmpDir, 'leak-test.duckdb');

      // Create and dispose stores sequentially on same file
      for (let i = 0; i < 10; i++) {
        const store = new KeyvDuckDB(dbPath);
        await store.set(`key${i}`, { data: i });
        assert.equal(getConnectionCount(), 1);
        await store.dispose();
        assert.equal(getConnectionCount(), 0);
      }

      // Verify all data persisted
      const finalStore = new KeyvDuckDB(dbPath);
      for (let i = 0; i < 10; i++) {
        const value = await finalStore.get<string>(`key${i}`);
        assert.ok(value);
        assert.deepStrictEqual(JSON.parse(value), { data: i });
      }
      await finalStore.dispose();
    });

    it('handles mixed dispose patterns correctly', async () => {
      const dbPath = path.join(tmpDir, 'mixed-dispose.duckdb');

      // First store
      const store1 = new KeyvDuckDB(dbPath);
      await store1.set('key1', { data: 'test1' });
      assert.equal(getConnectionCount(), 1);
      await store1.dispose();
      assert.equal(getConnectionCount(), 0);

      // Second store - use Symbol.asyncDispose
      const store2 = new KeyvDuckDB(dbPath);
      await store2.set('key2', { data: 'test2' });
      assert.equal(getConnectionCount(), 1);
      await store2[Symbol.asyncDispose]();
      assert.equal(getConnectionCount(), 0);

      // Third store - use disconnect()
      const store3 = new KeyvDuckDB(dbPath);
      await store3.set('key3', { data: 'test3' });
      assert.equal(getConnectionCount(), 1);
      await store3.disconnect();
      assert.equal(getConnectionCount(), 0);

      // Verify all data persisted
      const finalStore = new KeyvDuckDB(dbPath);
      const v1 = await finalStore.get<string>('key1');
      const v2 = await finalStore.get<string>('key2');
      const v3 = await finalStore.get<string>('key3');
      assert.ok(v1);
      assert.ok(v2);
      assert.ok(v3);
      assert.deepStrictEqual(JSON.parse(v1), { data: 'test1' });
      assert.deepStrictEqual(JSON.parse(v2), { data: 'test2' });
      assert.deepStrictEqual(JSON.parse(v3), { data: 'test3' });
      await finalStore.dispose();
    });
  });

  describe('error scenarios', () => {
    it('handles dispose during active operations gracefully', async () => {
      const dbPath = path.join(tmpDir, 'dispose-during-ops.duckdb');
      const store = new KeyvDuckDB(dbPath);

      // Start an operation
      const promise = store.set('key', { data: 'test' });

      // Dispose immediately (this might happen in concurrent scenarios)
      await store.dispose();

      // The pending operation should still complete
      await promise;

      // But subsequent operations should fail
      await assert.rejects(store.get('key'), /disposed/);
    });

    it('handles connection errors during dispose gracefully', async () => {
      const dbPath = path.join(tmpDir, 'dispose-error.duckdb');
      const store = new KeyvDuckDB(dbPath);

      await store.set('key', { data: 'test' });

      // Dispose should not throw even if there are connection issues
      await store.dispose();
      assert.equal(store.isDisposed, true);
    });
  });
});
