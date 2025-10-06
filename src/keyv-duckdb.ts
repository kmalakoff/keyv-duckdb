/**
 * @fileoverview DuckDB storage adapter for Keyv
 *
 * Native Keyv storage adapter using DuckDB as the backend with AES-256-GCM encryption support.
 * Provides SQL-optimized operations with atomic transactions and connection pooling.
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type DuckDB from 'duckdb';
import type { KeyvStoreAdapter } from 'keyv';
import { getConnection, releaseConnection } from './connection-manager.ts';

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
  private connection: DuckDB.Connection | undefined;
  private keySize: number | undefined;

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
   * Get a ready-to-use database connection
   */
  private async getConnection(): Promise<DuckDB.Connection> {
    if (this.disposed) {
      throw new Error('KeyvDuckDB has been disposed and cannot be used');
    }

    if (this.connection) {
      return this.connection;
    }

    // Ensure directory exists
    await fs.mkdir(path.dirname(this.dbFile), { recursive: true });

    this.connection = await getConnection(this.dbFile, this.encryptionKey);

    // Initialize schema if not already done
    if (!this.schemaInitialized) {
      await new Promise<void>((resolve, reject) => {
        this.connection?.run(`CREATE TABLE IF NOT EXISTS store.${this.table} (k TEXT PRIMARY KEY, v TEXT)`, (err: Error | null) => (err ? reject(err) : resolve()));
      });
      this.schemaInitialized = true;
    }

    return this.connection;
  }

  /**
   * Parameterized run helper
   */
  private async run(sql: string, params: any[] = []): Promise<void> {
    const conn = await this.getConnection();
    return new Promise((resolve, reject) => {
      // duckdb.run signature: run(sql, ...params, callback)
      (conn as any).run(sql, ...params, (err: Error | null) => (err ? reject(err) : resolve()));
    });
  }

  /**
   * Parameterized all helper
   */
  private async all<R = unknown>(sql: string, params: any[] = []): Promise<R[]> {
    const conn = await this.getConnection();
    return new Promise((resolve, reject) => {
      (conn as any).all(sql, ...params, (err: Error | null, rows?: unknown[]) => (err ? reject(err) : resolve((rows as R[]) ?? [])));
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
  async get(key: string): Promise<any> {
    this.validateKey(key);
    const rows = await this.all<{ v: string }>(`SELECT v FROM store.${this.table} WHERE k = ?`, [key]);
    return rows[0]?.v;
  }

  /**
   * Get multiple values by their keys efficiently using SQL IN clause.
   */
  async getMany(keys: string[]): Promise<any[]> {
    if (!Array.isArray(keys)) throw new Error('keys must be an array');
    if (keys.length === 0) return [];
    const placeholders = keys.map(() => '?').join(',');
    const rows = await this.all<{ k: string; v: string }>(`SELECT k, v FROM store.${this.table} WHERE k IN (${placeholders})`, keys);
    const resultMap = new Map(rows.map((r) => [r.k, r.v]));
    return keys.map((key) => resultMap.get(key));
  }

  /**
   * Store a value with the given key.
   * @param ttl Time-to-live in milliseconds (optional, handled by Keyv layer)
   */
  async set(key: string, value: any, _ttl?: number): Promise<boolean> {
    this.validateKey(key);
    // Store value as-is; Keyv handles serialization
    const stored = typeof value === 'string' ? value : JSON.stringify(value);
    await this.run(`INSERT OR REPLACE INTO store.${this.table} (k, v) VALUES (?, ?)`, [key, stored]);
    return true;
  }

  /**
   * Store multiple key-value pairs efficiently.
   */
  async setMany(entries: Array<{ key: string; value: any; ttl?: number }>): Promise<void> {
    if (!Array.isArray(entries)) throw new Error('entries must be an array');
    if (entries.length === 0) return;
    for (const entry of entries) this.validateKey(entry.key);
    const placeholders = entries.map(() => '(?, ?)').join(',');
    const params: any[] = [];
    for (const entry of entries) {
      params.push(entry.key);
      params.push(typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value));
    }
    await this.run(`INSERT OR REPLACE INTO store.${this.table} (k, v) VALUES ${placeholders}`, params);
  }

  /**
   * Remove a value by key from the store.
   * @returns true if the key existed, false otherwise
   */
  async delete(key: string): Promise<boolean> {
    this.validateKey(key);
    const rows = await this.all<{ count: number }>(`SELECT COUNT(*) as count FROM store.${this.table} WHERE k = ?`, [key]);
    const existed = (rows[0]?.count ?? 0) > 0;
    if (existed) {
      await this.run(`DELETE FROM store.${this.table} WHERE k = ?`, [key]);
    }
    return existed;
  }

  /**
   * Remove multiple keys efficiently using SQL IN clause.
   * @returns true if all keys were deleted successfully
   */
  async deleteMany(keys: string[]): Promise<boolean> {
    if (!Array.isArray(keys)) throw new Error('keys must be an array');
    if (keys.length === 0) return true;
    for (const key of keys) this.validateKey(key);
    const placeholders = keys.map(() => '?').join(',');
    await this.run(`DELETE FROM store.${this.table} WHERE k IN (${placeholders})`, keys);
    return true;
  }

  /**
   * Check if a key exists in the store.
   */
  async has(key: string): Promise<boolean> {
    this.validateKey(key);
    const rows = await this.all<{ count: number }>(`SELECT COUNT(*) as count FROM store.${this.table} WHERE k = ?`, [key]);
    return (rows[0]?.count ?? 0) > 0;
  }

  /**
   * Check if multiple keys exist in the store.
   */
  async hasMany(keys: string[]): Promise<boolean[]> {
    if (!Array.isArray(keys)) throw new Error('keys must be an array');
    if (keys.length === 0) return [];
    for (const key of keys) this.validateKey(key);
    const placeholders = keys.map(() => '?').join(',');
    const rows = await this.all<{ k: string }>(`SELECT k FROM store.${this.table} WHERE k IN (${placeholders})`, keys);
    const existsSet = new Set(rows.map((r) => r.k));
    return keys.map((key) => existsSet.has(key));
  }

  /**
   * Remove all stored values from the store.
   * Respects namespace filtering if namespace is set.
   */
  async clear(): Promise<void> {
    if (this.namespace) {
      // Clear only keys matching the namespace
      await this.run(`DELETE FROM store.${this.table} WHERE k LIKE ?`, [`${this.namespace}:%`]);
    } else {
      // Clear all keys
      await this.run(`DELETE FROM store.${this.table}`);
    }
  }

  /**
   * Iterate through all keys in the store.
   * Respects namespace filtering if namespace parameter or instance namespace is set.
   */
  async *iterator(namespace?: string): AsyncGenerator<[string, any]> {
    const ns = namespace ?? this.namespace;

    if (ns) {
      // Filter by namespace
      const pattern = `${ns}:%`;
      const sql = `SELECT k, v FROM store.${this.table} WHERE k LIKE ? ORDER BY k`;
      const rows = await this.all<{ k: string; v: string }>(sql, [pattern]);
      for (const row of rows) {
        yield [row.k, row.v];
      }
    } else {
      // Return all keys
      const rows = await this.all<{ k: string; v: string }>(`SELECT k, v FROM store.${this.table} ORDER BY k`);
      for (const row of rows) {
        yield [row.k, row.v];
      }
    }
  }

  /**
   * Close the database connection.
   */
  async disconnect(): Promise<void> {
    this.dispose();
  }

  /**
   * Dispose of this store instance and release its connection.
   * After calling dispose(), this store instance cannot be used.
   */
  dispose(): void {
    if (this.disposed) {
      return; // Already disposed
    }

    this.disposed = true;
    if (this.connection) {
      releaseConnection(this.connection);
      this.connection = undefined;
    }
  }

  /**
   * Modern disposal pattern using Symbol.dispose (Node.js 20+)
   * Enables using this store with `using` declarations for automatic cleanup
   */
  [Symbol.dispose](): void {
    this.dispose();
  }

  /**
   * Check if this store instance has been disposed
   */
  get isDisposed(): boolean {
    return this.disposed;
  }
}
