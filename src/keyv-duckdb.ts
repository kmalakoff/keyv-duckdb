/**
 * DuckDB storage adapter for Keyv
 *
 * Native Keyv storage adapter using DuckDB as the backend with AES-256-GCM encryption support.
 * Provides SQL-optimized operations with atomic transactions and connection pooling.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DuckDBConnection, DuckDBValue } from '@duckdb/node-api';
import { Hookified } from 'hookified';
import { type KeyvStorageAdapter, type KeyvStorageCapability, type KeyvStorageEntry, keyvStorageCapability } from 'keyv';
import { getConnection, isEncryptedConnection, releaseConnection, runSetupOnce } from './connection-manager.ts';

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
  /** Namespace, stored in the `namespace` column. Keyv sets it on the store when you pass `namespace` to `new Keyv`. Default: none (the empty namespace). */
  namespace?: string;
}

const RECOGNISED_OPTIONS = ['path', 'table', 'encryptionKey', 'keySize', 'namespace'];

function checkOptions(options: object): void {
  const unknown = Object.keys(options).filter((name) => !RECOGNISED_OPTIONS.includes(name));
  if (unknown.length > 0) throw new Error(`KeyvDuckDB: unrecognised option${unknown.length > 1 ? 's' : ''} ${unknown.map((name) => `'${name}'`).join(', ')}. Recognised options: ${RECOGNISED_OPTIONS.join(', ')}`);
}

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

const UPSERT_CONFLICT = ' ON CONFLICT (key, namespace) DO UPDATE SET value = excluded.value, expires = excluded.expires';

function toExpires(expires: number | null | undefined): bigint | null {
  return typeof expires === 'number' && Number.isFinite(expires) ? BigInt(Math.ceil(expires)) : null;
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
export class KeyvDuckDB extends Hookified implements KeyvStorageAdapter {
  namespace?: string;

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
    super({ throwOnEmptyListeners: false });

    // Parse constructor arguments; the default path applies only when no path is given
    let opts: KeyvDuckDBOptions = {};
    if (typeof uri === 'string') {
      if (options) checkOptions(options);
      opts = { ...options, path: uri };
    } else if (uri && typeof uri === 'object') {
      checkOptions(uri);
      opts = uri;
    }
    this.dbFile = opts.path ?? path.join(os.homedir(), '.keyv-duckdb', 'store.duckdb');

    this.namespace = opts.namespace;
    this.table = opts.table ?? 'keyv';
    this.encryptionKey = opts.encryptionKey;
    this.keySize = opts.keySize ?? undefined;
  }

  /** v6 contract: Keyv passes absolute `expires` and uses this adapter directly (no KeyvBridgeAdapter). */
  get capabilities(): KeyvStorageCapability {
    return keyvStorageCapability(this);
  }

  /** Value of the `namespace` column for this store: the empty string when no namespace is set. */
  private ns(): string {
    return this.namespace ?? '';
  }

  /**
   * Get the qualified table reference based on connection type
   * - Encrypted: uses attached database 'store.tableName'
   * - Unencrypted: uses direct database 'tableName'
   */
  private getTableRef(): string {
    if (this.connection && isEncryptedConnection(this.connection)) {
      return `store.${quoteIdentifier(this.table)}`;
    }
    return quoteIdentifier(this.table);
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

  /** Qualified, quoted table reference, after making sure the connection and schema are ready. */
  private async tableRef(): Promise<string> {
    await this.getConnection();
    return this.getTableRef();
  }

  /** Placeholders `$k0,$k1,...` and their parameters for a list of keys. */
  private keyParams(keys: string[]): { placeholders: string; params: Record<string, DuckDBValue> } {
    const params: Record<string, DuckDBValue> = {};
    keys.forEach((key, i) => {
      params[`k${i}`] = key;
    });
    return { placeholders: keys.map((_, i) => `$k${i}`).join(','), params };
  }

  private upsertSql(tableRef: string): string {
    return `INSERT INTO ${tableRef} (key, value, namespace, expires)`;
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

    // Create or convert the table once per file, serialized with other operations on this connection
    if (!this.schemaInitialized) {
      const conn = this.connection;
      await this.queueOperation(() => runSetupOnce(conn, `schema:${this.table}`, () => this.ensureSchema(conn)));
      this.schemaInitialized = true;
    }

    return this.connection;
  }

  /**
   * Create the table, or convert a 0.1.x table (`k`, `v`, no `namespace` column) to the @keyv/sqlite 6.1.0 layout.
   * Mirrors @keyv/sqlite `ensureSchema` (dist/index.mjs:752-765): recover a leftover `_migration_old` table, create when missing, convert when `namespace` is absent.
   */
  private async ensureSchema(conn: DuckDBConnection): Promise<void> {
    const encrypted = isEncryptedConnection(conn);
    const columnsOf = async (table: string): Promise<string[]> => {
      const catalog = encrypted ? 'store' : (await conn.runAndReadAll('SELECT current_database() AS db')).getRowObjects()[0]?.db;
      const rows = (await conn.runAndReadAll('SELECT column_name FROM duckdb_columns() WHERE database_name = $db AND schema_name = $schema AND table_name = $table', { db: catalog as string, schema: 'main', table })).getRowObjects();
      return rows.map((r) => r.column_name as string);
    };
    const prefix = encrypted ? 'store.' : '';
    const current = this.getTableRef();
    const oldName = `${this.table}_migration_old`;
    const old = `${prefix}${quoteIdentifier(oldName)}`;
    const createTable = `CREATE TABLE IF NOT EXISTS ${current} (key TEXT NOT NULL, value TEXT, namespace TEXT NOT NULL DEFAULT '', expires BIGINT DEFAULT NULL, UNIQUE (key, namespace))`;
    // @keyv/sqlite getLegacyMigrationInsertSql (dist/index.mjs:824-831): split `namespace:key` on the first colon (no colon means the empty namespace) and read `expires` from the keyv 5 JSON envelope
    const copyLegacy = `INSERT OR IGNORE INTO ${current} (key, value, namespace, expires) SELECT CASE WHEN instr(k, ':') > 0 THEN substr(k, instr(k, ':') + 1) ELSE k END, v, CASE WHEN instr(k, ':') > 0 THEN substr(k, 1, instr(k, ':') - 1) ELSE '' END, CASE WHEN json_valid(v) THEN TRY_CAST(json_extract_string(v, '$.expires') AS BIGINT) END FROM ${old}`;
    // @keyv/sqlite runInTransaction (dist/index.mjs:803-812)
    const inTransaction = async (work: () => Promise<void>): Promise<void> => {
      await conn.run('BEGIN TRANSACTION');
      try {
        await work();
        await conn.run('COMMIT');
      } catch (error) {
        await conn.run('ROLLBACK').catch(() => undefined);
        throw error;
      }
    };

    // @keyv/sqlite recoverIncompleteMigration (dist/index.mjs:774-783)
    const oldColumns = await columnsOf(oldName);
    if (oldColumns.includes('k') && oldColumns.includes('v')) {
      await inTransaction(async () => {
        await conn.run(createTable);
        await conn.run(copyLegacy);
        await conn.run(`DROP TABLE ${old}`);
      });
    }

    const columns = await columnsOf(this.table);
    if (columns.length === 0) {
      await conn.run(createTable);
      return;
    }
    if (!columns.includes('namespace')) {
      if (!columns.includes('k') || !columns.includes('v')) throw new Error(`KeyvDuckDB: table '${this.table}' is neither a keyv-duckdb 0.1.x table (k, v) nor a 0.2 table (key, value, namespace, expires)`);
      // @keyv/sqlite migrateLegacySchema (dist/index.mjs:791-801)
      await inTransaction(async () => {
        await conn.run(`ALTER TABLE ${current} RENAME TO ${quoteIdentifier(oldName)}`);
        await conn.run(createTable);
        await conn.run(copyLegacy);
        await conn.run(`DROP TABLE ${old}`);
      });
      return;
    }
    if (!columns.includes('expires')) await conn.run(`ALTER TABLE ${current} ADD COLUMN expires BIGINT DEFAULT NULL`);
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
      const rows = await this.all<{ value: string }>(`SELECT value FROM ${await this.tableRef()} WHERE key = $key AND namespace = $ns AND (expires IS NULL OR expires > $now)`, { key, ns: this.ns(), now: Date.now() });
      return rows[0]?.value as Value | undefined;
    } finally {
      this.endOperation();
    }
  }

  /**
   * Get multiple values by their keys efficiently using SQL IN clause.
   */
  async getMany<Value>(keys: string[]): Promise<Array<Value | undefined>> {
    if (!Array.isArray(keys)) throw new Error('keys must be an array');
    if (keys.length === 0) return [];
    this.beginOperation();
    try {
      const { placeholders, params } = this.keyParams(keys);
      const rows = await this.all<{ key: string; value: string }>(`SELECT key, value FROM ${await this.tableRef()} WHERE key IN (${placeholders}) AND namespace = $ns AND (expires IS NULL OR expires > $now)`, { ...params, ns: this.ns(), now: Date.now() });
      const resultMap = new Map(rows.map((r) => [r.key, r.value]));
      return keys.map((key) => resultMap.get(key) as Value | undefined);
    } finally {
      this.endOperation();
    }
  }

  /**
   * Store a value with the given key.
   * @param expires absolute expiry, Unix ms; undefined means none
   */
  async set(key: string, value: unknown, expires?: number): Promise<boolean> {
    this.beginOperation();
    try {
      this.validateKey(key);
      // Store value as-is; Keyv handles serialization
      const stored = typeof value === 'string' ? value : JSON.stringify(value);
      await this.run(`${this.upsertSql(await this.tableRef())} VALUES ($key, $value, $ns, $expires)${UPSERT_CONFLICT}`, { key, value: stored, ns: this.ns(), expires: toExpires(expires) });
      return true;
    } finally {
      this.endOperation();
    }
  }

  /**
   * Store multiple key-value pairs efficiently.
   * One statement, so all entries succeed or none do. A key listed twice keeps its last entry.
   */
  async setMany<Value>(entries: KeyvStorageEntry<Value>[]): Promise<boolean[]> {
    if (!Array.isArray(entries)) throw new Error('entries must be an array');
    if (entries.length === 0) return [];
    this.beginOperation();
    try {
      for (const entry of entries) this.validateKey(entry.key);
      const last = new Map<string, KeyvStorageEntry<Value>>();
      for (const entry of entries) last.set(entry.key, entry);
      const unique = [...last.values()];
      const placeholders = unique.map((_, i) => `($k${i}, $v${i}, $ns, $e${i})`).join(',');
      const params: Record<string, DuckDBValue> = { ns: this.ns() };
      unique.forEach((entry, i) => {
        params[`k${i}`] = entry.key;
        params[`v${i}`] = typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value);
        params[`e${i}`] = toExpires(entry.expires);
      });
      await this.run(`${this.upsertSql(await this.tableRef())} VALUES ${placeholders}${UPSERT_CONFLICT}`, params);
      return entries.map(() => true);
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
      const rows = await this.all<{ key: string }>(`DELETE FROM ${await this.tableRef()} WHERE key = $key AND namespace = $ns RETURNING key`, { key, ns: this.ns() });
      return rows.length > 0;
    } finally {
      this.endOperation();
    }
  }

  /**
   * Remove multiple keys efficiently using SQL IN clause.
   * @returns per key, whether it existed
   */
  async deleteMany(keys: string[]): Promise<boolean[]> {
    if (!Array.isArray(keys)) throw new Error('keys must be an array');
    if (keys.length === 0) return [];
    this.beginOperation();
    try {
      for (const key of keys) this.validateKey(key);
      const { placeholders, params } = this.keyParams(keys);
      const rows = await this.all<{ key: string }>(`DELETE FROM ${await this.tableRef()} WHERE key IN (${placeholders}) AND namespace = $ns RETURNING key`, { ...params, ns: this.ns() });
      const deleted = new Set(rows.map((r) => r.key));
      return keys.map((key) => deleted.has(key));
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
      const rows = await this.all<{ count: bigint }>(`SELECT COUNT(*) as count FROM ${await this.tableRef()} WHERE key = $key AND namespace = $ns AND (expires IS NULL OR expires > $now)`, { key, ns: this.ns(), now: Date.now() });
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
      const { placeholders, params } = this.keyParams(keys);
      const rows = await this.all<{ key: string }>(`SELECT key FROM ${await this.tableRef()} WHERE key IN (${placeholders}) AND namespace = $ns AND (expires IS NULL OR expires > $now)`, { ...params, ns: this.ns(), now: Date.now() });
      const existsSet = new Set(rows.map((r) => r.key));
      return keys.map((key) => existsSet.has(key));
    } finally {
      this.endOperation();
    }
  }

  /**
   * Remove all values in this store's namespace (the empty namespace when none is set).
   */
  async clear(): Promise<void> {
    this.beginOperation();
    try {
      await this.run(`DELETE FROM ${await this.tableRef()} WHERE namespace = $ns`, { ns: this.ns() });
    } finally {
      this.endOperation();
    }
  }

  /**
   * Iterate this namespace's unexpired entries.
   */
  async *iterator<Value>(): AsyncGenerator<[string, Value], void> {
    this.beginOperation();
    try {
      const rows = await this.all<{ key: string; value: string }>(`SELECT key, value FROM ${await this.tableRef()} WHERE namespace = $ns AND (expires IS NULL OR expires > $now) ORDER BY key`, { ns: this.ns(), now: Date.now() });
      for (const row of rows) {
        yield [row.key, row.value as Value];
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
