import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { closeAllConnections, getConnectionCount } from '../../src/connection-manager.ts';
import { KeyvDuckDB } from '../../src/keyv-duckdb.ts';

describe('DuckDBStore Lifecycle Management', () => {
  let tmpDir: string;

  beforeEach(async () => {
    // Start with clean connection manager
    closeAllConnections();

    const tmpParent = path.join(os.tmpdir(), '.tmp');
    await fs.mkdir(tmpParent, { recursive: true });
    tmpDir = await fs.mkdtemp(path.join(tmpParent, 'duckdb-lifecycle-test-'));
  });

  afterEach(async () => {
    // Clean up connections and temp files
    closeAllConnections();
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('connection management', () => {
    it('creates separate connections for each store instance', async () => {
      const dbPath = path.join(tmpDir, 'shared.duckdb');

      const store1 = new KeyvDuckDB(dbPath);
      const store2 = new KeyvDuckDB(dbPath);

      // Trigger connection creation
      await store1.set('key1', { data: 'store1' });
      await store2.set('key2', { data: 'store2' });

      // Each store gets its own connection
      assert.equal(getConnectionCount(), 2);

      store1.dispose();
      store2.dispose();
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

      store1.dispose();
      store2.dispose();
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

      store1.dispose();
      store2.dispose();
    });
  });

  describe('dispose pattern', () => {
    it('closes connection when store is disposed', async () => {
      const dbPath = path.join(tmpDir, 'dispose-test.duckdb');

      const store1 = new KeyvDuckDB(dbPath);
      const store2 = new KeyvDuckDB(dbPath);

      // Create connections
      await store1.set('key', { data: 'test' });
      await store2.get('key');

      assert.equal(getConnectionCount(), 2);

      // Dispose first store - its connection should be closed
      store1.dispose();
      assert.equal(getConnectionCount(), 1);

      // Dispose second store - its connection should be closed
      store2.dispose();
      assert.equal(getConnectionCount(), 0);
    });

    it('prevents operations after dispose', async () => {
      const dbPath = path.join(tmpDir, 'disposed-store.duckdb');
      const store = new KeyvDuckDB(dbPath);

      // Use store normally
      await store.set('key', { data: 'test' });
      assert.deepStrictEqual(JSON.parse(await store.get('key')), { data: 'test' });

      // Dispose store
      store.dispose();
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
      store.dispose();
      store.dispose();
      store.dispose();

      assert.equal(store.isDisposed, true);
      assert.equal(getConnectionCount(), 0);
    });
  });

  describe('Symbol.dispose pattern', () => {
    it('supports using declaration for automatic cleanup', async () => {
      const dbPath = path.join(tmpDir, 'symbol-dispose.duckdb');

      {
        using store = new KeyvDuckDB(dbPath);
        await store.set('key', { data: 'test' });
        assert.equal(getConnectionCount(), 1);
        // store is automatically disposed when exiting this block
      }

      // Connection should be closed after using block
      assert.equal(getConnectionCount(), 0);
    });

    it('Symbol.dispose calls regular dispose method', async () => {
      const dbPath = path.join(tmpDir, 'symbol-dispose-method.duckdb');
      const store = new KeyvDuckDB(dbPath);

      await store.set('key', { data: 'test' });
      assert.equal(store.isDisposed, false);

      // Call Symbol.dispose directly
      store[Symbol.dispose]();

      assert.equal(store.isDisposed, true);
      assert.equal(getConnectionCount(), 0);
    });
  });

  describe('resource leak prevention', () => {
    it('prevents connection leaks with many store instances', async () => {
      const dbPath = path.join(tmpDir, 'leak-test.duckdb');
      const stores: KeyvDuckDB[] = [];

      // Create many stores
      for (let i = 0; i < 10; i++) {
        const store = new KeyvDuckDB(dbPath);
        await store.set(`key${i}`, { data: i });
        stores.push(store);
      }

      // Each store gets its own connection
      assert.equal(getConnectionCount(), 10);

      // Dispose all stores
      for (const store of stores) {
        store.dispose();
      }

      // All connections should be closed
      assert.equal(getConnectionCount(), 0);
    });

    it('handles mixed dispose patterns correctly', async () => {
      const dbPath = path.join(tmpDir, 'mixed-dispose.duckdb');

      const store1 = new KeyvDuckDB(dbPath);
      const store2 = new KeyvDuckDB(dbPath);
      const store3 = new KeyvDuckDB(dbPath);

      // Ensure all stores trigger connection creation
      await store1.set('key1', { data: 'test1' });
      await store2.set('key2', { data: 'test2' });
      await store3.set('key3', { data: 'test3' });

      assert.equal(getConnectionCount(), 3);

      // Dispose using different patterns
      store1.dispose(); // Explicit dispose
      store2[Symbol.dispose](); // Symbol.dispose

      // Each store's connection should be closed
      assert.equal(getConnectionCount(), 1);

      // Dispose last store
      store3.dispose();

      // Now all connections should be closed
      assert.equal(getConnectionCount(), 0);
    });
  });

  describe('error scenarios', () => {
    it('handles dispose during active operations gracefully', async () => {
      const dbPath = path.join(tmpDir, 'dispose-during-ops.duckdb');
      const store = new KeyvDuckDB(dbPath);

      // Start an operation
      const promise = store.set('key', { data: 'test' });

      // Dispose immediately (this might happen in concurrent scenarios)
      store.dispose();

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
      store.dispose();
      assert.equal(store.isDisposed, true);
    });
  });
});
