/**
 * DuckDB storage adapter for Keyv
 *
 * Native Keyv storage adapter using DuckDB as the backend with AES-256-GCM encryption support.
 * Provides SQL-optimized operations with atomic transactions and connection pooling.
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DuckDBConnection, DuckDBValue } from '@duckdb/node-api';
import type { KeyvStoreAdapter } from 'keyv';
import { getConnection, isEncryptedConnection, releaseConnection } from './connection-manager.ts';

/**
 * Configuration options for KeyvDuckDB store
 */
export interface KeyvDuckDBOptions {
  /** Path to the DuckDB database file. Default: ~/.keyv-duckdb/store.duckdb */
  path?: string;
  /** Table name for key-value storage. Default: 'keyv' */
  table?: string;
  /** Encryption key for AES-256-GCM encryption. If provided, encryption is automatically enabled. Recommended 32+ chars. */
  encryptionKey?: string;
  /** Maximum key size in characters. Default: 255 */
  keySize?: number;
  /** Dialect identifier for Keyv. Default: 'duckdb' */
  dialect?: string;
  /** URL/connection string for Keyv. Set to path by default */
  url?: string;
}

/**
 * DuckDB storage adapter for Keyv with native encryption support.
 *
 * Features:
 * - AES-256-GCM database encryption via DuckDB 1.4+
 * - SQL-optimized batch operations
 * - Atomic transactions for data consistency
 * - Connection pooling and automatic cleanup
 * - Full Keyv store interface compatibility
 *
 * @example
 * ```typescript
 * import Keyv from 'keyv';
 * import { KeyvDuckDB } from 'keyv-duckdb';
 *
 * const store = new Keyv({
 *   store: new KeyvDuckDB('./tokens.db', { encryptionKey: process.env.KEY })
 * });
 *
 * await store.set('key', { data: 'value' });
 * const value = await store.get('key');
 * ```
 */
export class KeyvDuckDB extends EventEmitter implements KeyvStoreAdapter {
  ttlSupport = false;
  namespace?: string;
  opts: KeyvDuckDBOptions;

  private dbFile: string;
  private table: string;
  private encryptionKey: string | undefined;
  private schemaInitialized = false;
  private disposed = false;
  private pendingOperations = 0;
  private connection: DuckDBConnection | undefined;
  private keySize: number | undefined;
  /** Promise chain for serializing database operations (DuckDB connections are single-threaded) */
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(uri?: string | KeyvDuckDBOptions, options?: Omit<KeyvDuckDBOptions, 'path'>) {
    super(); // Call EventEmitter constructor

    // Parse constructor arguments
    let opts: KeyvDuckDBOptions = {};
    if (typeof uri === 'string') {
      opts = { ...options, path: uri };
      this.dbFile = uri;
    } else if (uri && typeof uri === 'object') {
      opts = uri;
      this.dbFile = opts.path ?? path.join(os.homedir(), '.keyv-duckdb', 'store.duckdb');
    } else {
      this.dbFile = path.join(os.homedir(), '.keyv-duckdb', 'store.duckdb');
    }

    // Set dialect and url for Keyv iterator detection
    opts.dialect = opts.dialect ?? 'duckdb';
    opts.url = opts.url ?? this.dbFile;

    this.opts = opts;
    this.table = opts.table ?? 'keyv';
    this.encryptionKey = opts.encryptionKey;
    this.keySize = opts.keySize ?? undefined;
  }

  /**
   * Get the qualified table reference based on connection type
   * - Encrypted: uses attached database 'store.tableName'
   * - Unencrypted: uses direct database 'tableName'
   */
  private getTableRef(): string {
    if (this.connection && isEncryptedConnection(this.connection)) {
      return `store.${this.table}`;
    }
    return this.table;
  }

  /**
   * Track the start of an operation. Must be called synchronously at the start of each public method.
   * Throws if store is fully disposed. Operations started before dispose() is called will complete.
   */
  private beginOperation(): void {
    if (this.disposed) {
      throw new Error('KeyvDuckDB has been disposed and cannot be used');
    }
    this.pendingOperations++;
  }

  /**
   * Track the end of an operation.
   */
  private endOperation(): void {
    this.pendingOperations--;
  }

  /**
   * Get a ready-to-use database connection
   */
  private async getConnection(): Promise<DuckDBConnection> {
    if (this.connection) {
      return this.connection;
    }

    // Ensure directory exists
    await fs.mkdir(path.dirname(this.dbFile), { recursive: true });

    this.connection = await getConnection(this.dbFile, this.encryptionKey);

    // Initialize schema if not already done (queue to serialize with other operations)
    if (!this.schemaInitialized) {
      const tableRef = this.getTableRef();
      await this.queueOperation(() => this.connection?.run(`CREATE TABLE IF NOT EXISTS ${tableRef} (k TEXT PRIMARY KEY, v TEXT)`));
      this.schemaInitialized = true;
    }

    return this.connection;
  }

  /**
   * Queue an operation to run serially (DuckDB connections are single-threaded)
   */
  private queueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    // Update queue to track completion (ignore result value, only track timing)
    this.operationQueue = result.then(
      () => {},
      () => {}
    );
    return result;
  }

  /**
   * Run a SQL statement with optional parameters
   */
  private async run(sql: string, params: Record<string, DuckDBValue> = {}): Promise<void> {
    const conn = await this.getConnection();
    await this.queueOperation(() => conn.run(sql, params));
  }

  /**
   * Run a SQL query and return all rows as objects
   */
  private async all<R = Record<string, unknown>>(sql: string, params: Record<string, DuckDBValue> = {}): Promise<R[]> {
    const conn = await this.getConnection();
    return this.queueOperation(async () => {
      const result = await conn.runAndReadAll(sql, params);
      return result.getRowObjects() as R[];
    });
  }

  /**
   * Validate key parameter
   */
  private validateKey(key: string): void {
    if (!key || key.length === 0) {
      throw new Error('key required');
    }
    if (this.keySize && key.length > this.keySize) {
      throw new Error(`key length ${key.length} exceeds maximum ${this.keySize}`);
    }
  }

  /**
   * Get a value by key from the store.
   */
  async get<Value>(key: string): Promise<Value | undefined> {
    this.beginOperation();
    try {
      this.validateKey(key);
      await this.getConnection(); // Ensure connection exists for getTableRef
      const rows = await this.all<{ v: string }>(`SELECT v FROM ${this.getTableRef()} WHERE k = $key`, { key });
      return rows[0]?.v as Value | undefined;
    } finally {
      this.endOperation();
    }
  }

  /**
   * Get multiple values by their keys efficiently using SQL IN clause.
   * KeyvStoreAdapter interface: getMany?<Value>(keys: string[]): Promise<Array<StoredData<Value | undefined>>>
   */
  async getMany<Value>(keys: string[]): Promise<Array<Value | undefined>> {
    if (!Array.isArray(keys)) throw new Error('keys must be an array');
    if (keys.length === 0) return [];
    this.beginOperation();
    try {
      await this.getConnection(); // Ensure connection exists for getTableRef
      const placeholders = keys.map((_, i) => `$k${i}`).join(',');
      const params: Record<string, string> = {};
      keys.forEach((k, i) => {
        params[`k${i}`] = k;
      });
      const rows = await this.all<{ k: string; v: string }>(`SELECT k, v FROM ${this.getTableRef()} WHERE k IN (${placeholders})`, params);
      const resultMap = new Map(rows.map((r) => [r.k, r.v]));
      return keys.map((key) => resultMap.get(key) as Value | undefined);
    } finally {
      this.endOperation();
    }
  }

  /**
   * Store a value with the given key.
   * KeyvStoreAdapter interface: set(key: string, value: any, ttl?: number): any
   */
  // biome-ignore lint/suspicious/noExplicitAny: KeyvStoreAdapter interface uses any
  async set(key: string, value: any, _ttl?: number): Promise<boolean> {
    this.beginOperation();
    try {
      this.validateKey(key);
      await this.getConnection(); // Ensure connection exists for getTableRef
      // Store value as-is; Keyv handles serialization
      const stored = typeof value === 'string' ? value : JSON.stringify(value);
      await this.run(`INSERT OR REPLACE INTO ${this.getTableRef()} (k, v) VALUES ($key, $value)`, { key, value: stored });
      return true;
    } finally {
      this.endOperation();
    }
  }

  /**
   * Store multiple key-value pairs efficiently.
   * KeyvStoreAdapter interface: setMany?(values: Array<{ key: string; value: any; ttl?: number }>): Promise<void>
   */
  // biome-ignore lint/suspicious/noExplicitAny: KeyvStoreAdapter interface uses any
  async setMany(entries: Array<{ key: string; value: any; ttl?: number }>): Promise<void> {
    if (!Array.isArray(entries)) throw new Error('entries must be an array');
    if (entries.length === 0) return;
    this.beginOperation();
    try {
      for (const entry of entries) this.validateKey(entry.key);
      await this.getConnection(); // Ensure connection exists for getTableRef
      const placeholders = entries.map((_, i) => `($k${i}, $v${i})`).join(',');
      const params: Record<string, string> = {};
      entries.forEach((entry, i) => {
        params[`k${i}`] = entry.key;
        params[`v${i}`] = typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value);
      });
      await this.run(`INSERT OR REPLACE INTO ${this.getTableRef()} (k, v) VALUES ${placeholders}`, params);
    } finally {
      this.endOperation();
    }
  }

  /**
   * Remove a value by key from the store.
   * @returns true if the key existed, false otherwise
   */
  async delete(key: string): Promise<boolean> {
    this.beginOperation();
    try {
      this.validateKey(key);
      await this.getConnection(); // Ensure connection exists for getTableRef
      const rows = await this.all<{ count: bigint }>(`SELECT COUNT(*) as count FROM ${this.getTableRef()} WHERE k = $key`, { key });
      const existed = (rows[0]?.count ?? 0n) > 0n;
      if (existed) {
        await this.run(`DELETE FROM ${this.getTableRef()} WHERE k = $key`, { key });
      }
      return existed;
    } finally {
      this.endOperation();
    }
  }

  /**
   * Remove multiple keys efficiently using SQL IN clause.
   * @returns true if all keys were deleted successfully
   */
  async deleteMany(keys: string[]): Promise<boolean> {
    if (!Array.isArray(keys)) throw new Error('keys must be an array');
    if (keys.length === 0) return true;
    this.beginOperation();
    try {
      for (const key of keys) this.validateKey(key);
      await this.getConnection(); // Ensure connection exists for getTableRef
      const placeholders = keys.map((_, i) => `$k${i}`).join(',');
      const params: Record<string, string> = {};
      keys.forEach((k, i) => {
        params[`k${i}`] = k;
      });
      await this.run(`DELETE FROM ${this.getTableRef()} WHERE k IN (${placeholders})`, params);
      return true;
    } finally {
      this.endOperation();
    }
  }

  /**
   * Check if a key exists in the store.
   */
  async has(key: string): Promise<boolean> {
    this.beginOperation();
    try {
      this.validateKey(key);
      await this.getConnection(); // Ensure connection exists for getTableRef
      const rows = await this.all<{ count: bigint }>(`SELECT COUNT(*) as count FROM ${this.getTableRef()} WHERE k = $key`, { key });
      return (rows[0]?.count ?? 0n) > 0n;
    } finally {
      this.endOperation();
    }
  }

  /**
   * Check if multiple keys exist in the store.
   */
  async hasMany(keys: string[]): Promise<boolean[]> {
    if (!Array.isArray(keys)) throw new Error('keys must be an array');
    if (keys.length === 0) return [];
    this.beginOperation();
    try {
      for (const key of keys) this.validateKey(key);
      await this.getConnection(); // Ensure connection exists for getTableRef
      const placeholders = keys.map((_, i) => `$k${i}`).join(',');
      const params: Record<string, string> = {};
      keys.forEach((k, i) => {
        params[`k${i}`] = k;
      });
      const rows = await this.all<{ k: string }>(`SELECT k FROM ${this.getTableRef()} WHERE k IN (${placeholders})`, params);
      const existsSet = new Set(rows.map((r) => r.k));
      return keys.map((key) => existsSet.has(key));
    } finally {
      this.endOperation();
    }
  }

  /**
   * Remove all stored values from the store.
   * Respects namespace filtering if namespace is set.
   */
  async clear(): Promise<void> {
    this.beginOperation();
    try {
      await this.getConnection(); // Ensure connection exists for getTableRef
      if (this.namespace) {
        // Clear only keys matching the namespace
        await this.run(`DELETE FROM ${this.getTableRef()} WHERE k LIKE $pattern`, { pattern: `${this.namespace}:%` });
      } else {
        // Clear all keys
        await this.run(`DELETE FROM ${this.getTableRef()}`);
      }
    } finally {
      this.endOperation();
    }
  }

  /**
   * Iterate through all keys in the store.
   * Respects namespace filtering if namespace parameter or instance namespace is set.
   * KeyvStoreAdapter interface: iterator?<Value>(namespace?: string): AsyncGenerator<Array<string | Awaited<Value> | undefined>, void>
   */
  async *iterator<Value>(namespace?: string): AsyncGenerator<[string, Value], void> {
    this.beginOperation();
    try {
      await this.getConnection(); // Ensure connection exists for getTableRef
      const ns = namespace ?? this.namespace;

      if (ns) {
        // Filter by namespace
        const pattern = `${ns}:%`;
        const rows = await this.all<{ k: string; v: string }>(`SELECT k, v FROM ${this.getTableRef()} WHERE k LIKE $pattern ORDER BY k`, { pattern });
        for (const row of rows) {
          yield [row.k, row.v as Value];
        }
      } else {
        // Return all keys
        const rows = await this.all<{ k: string; v: string }>(`SELECT k, v FROM ${this.getTableRef()} ORDER BY k`);
        for (const row of rows) {
          yield [row.k, row.v as Value];
        }
      }
    } finally {
      this.endOperation();
    }
  }

  /**
   * Close the database connection.
   */
  async disconnect(): Promise<void> {
    await this.dispose();
  }

  /**
   * Dispose of this store instance and release its connection.
   * After calling dispose(), this store instance cannot be used.
   * Returns a promise that resolves when the connection is fully closed.
   * Waits for any pending operations to complete before disposing.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return; // Already disposed

    // Wait for pending operations to complete
    while (this.pendingOperations > 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    this.disposed = true;
    if (this.connection) {
      await releaseConnection(this.connection);
      this.connection = undefined;
    }
  }

  /**
   * Modern disposal pattern using Symbol.asyncDispose (Node.js 20+)
   * Enables using this store with `await using` declarations for automatic cleanup
   */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }

  /**
   * Check if this store instance has been disposed
   */
  get isDisposed(): boolean {
    return this.disposed;
  }
}
