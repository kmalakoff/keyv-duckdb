/**
 * @fileoverview Simple DuckDB connection manager using @duckdb/node-api
 *
 * One DuckDB instance per database file, shared and reference-counted; each store gets its own connection.
 */

import path from 'node:path';
import { type DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';

interface SharedInstance {
  instance: DuckDBInstance;
  encrypted: boolean;
  /** The key the file was opened with; later stores must present the same one. Never put it in a message. */
  encryptionKey: string | undefined;
  refs: number;
  /** Set once the last store released it; resolves when the instance is fully closed. */
  closing?: Promise<void>;
  /** One-time setup (schema creation or conversion) per key, shared by every connection to this file. */
  setups: Map<string, Promise<void>>;
}

interface ConnectionInfo {
  shared: SharedInstance;
  sharedKey: string;
  connection: DuckDBConnection;
  encrypted: boolean;
}

const connections = new Set<ConnectionInfo>();
/** One DuckDB instance per database file: two instances on one file each checkpoint their own view and lose the other's writes. */
const instances = new Map<string, Promise<SharedInstance>>();

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function openShared(dbPath: string, encryptionKey?: string): Promise<SharedInstance> {
  if (!encryptionKey) return { instance: await DuckDBInstance.create(dbPath), encrypted: false, encryptionKey: undefined, refs: 0, setups: new Map() };
  const instance = await DuckDBInstance.create(':memory:');
  const setup = await instance.connect();
  await setup.run(`ATTACH ${quote(dbPath)} AS store (ENCRYPTION_KEY ${quote(encryptionKey)})`);
  setup.closeSync();
  return { instance, encrypted: true, encryptionKey, refs: 0, setups: new Map() };
}

/**
 * Create a new connection for the given database path and optional encryption key
 * Each call creates a separate connection instance
 *
 * For unencrypted databases: opens the file directly
 * For encrypted databases: uses in-memory instance with ATTACH (required by DuckDB)
 */
export async function getConnection(dbPath: string, encryptionKey?: string): Promise<DuckDBConnection> {
  const sharedKey = dbPath === ':memory:' ? `:memory:#${Math.random()}` : path.resolve(dbPath);
  let shared: SharedInstance;
  for (;;) {
    let pending = instances.get(sharedKey);
    if (!pending) {
      pending = openShared(dbPath, encryptionKey);
      instances.set(sharedKey, pending);
      pending.catch(() => instances.delete(sharedKey));
    }
    shared = await pending;
    if (!shared.closing) break;
    await shared.closing; // the last store is still closing this file: wait, then open it afresh
  }
  if (shared.encrypted !== !!encryptionKey) throw new Error(`${dbPath} is already open ${shared.encrypted ? 'with' : 'without'} an encryption key`);
  if (shared.encryptionKey !== (encryptionKey || undefined)) throw new Error(`${dbPath} is already open with a different encryption key`);
  shared.refs++;
  const connection = await shared.instance.connect();
  const encrypted = shared.encrypted;
  const connectionInfo: ConnectionInfo = { shared, sharedKey, connection, encrypted };

  connections.add(connectionInfo);
  return connection;
}

/**
 * Run `setup` once per database file and key, no matter how many stores share the file.
 * Concurrent callers wait for the first; a failed setup is forgotten so the next caller retries.
 */
export async function runSetupOnce(connection: DuckDBConnection, key: string, setup: () => Promise<void>): Promise<void> {
  for (const info of connections) {
    if (info.connection !== connection) continue;
    let pending = info.shared.setups.get(key);
    if (!pending) {
      pending = setup();
      info.shared.setups.set(key, pending);
      pending.catch(() => info.shared.setups.delete(key));
    }
    return pending;
  }
  return setup();
}

/**
 * Check if a connection is using encryption (and thus the ATTACH pattern)
 */
export function isEncryptedConnection(connection: DuckDBConnection): boolean {
  for (const info of connections) {
    if (info.connection === connection) {
      return info.encrypted;
    }
  }
  return false;
}

/**
 * Remove and close a specific connection
 * Should be called when a store instance is disposed
 * Returns a promise that resolves when the connection is fully closed
 */
export async function releaseConnection(connection: DuckDBConnection): Promise<void> {
  for (const info of connections) {
    if (info.connection === connection) {
      connections.delete(info);

      const shared = info.shared;
      if (--shared.refs > 0) {
        connection.closeSync();
        return;
      }
      // Last store: checkpoint and close. The map entry stays until the instance is closed, so a store opening the file meanwhile waits for it.
      shared.closing = (async () => {
        try {
          if (info.encrypted) {
            await connection.run('CHECKPOINT store');
            await connection.run('DETACH store');
          } else {
            await connection.run('CHECKPOINT');
          }
        } catch {
          // Ignore cleanup errors
        }
        connection.closeSync();
        shared.instance.closeSync();
        instances.delete(info.sharedKey);
      })();
      await shared.closing;
      return;
    }
  }
}

/**
 * Get current connection count for testing/debugging
 */
export function getConnectionCount(): number {
  return connections.size;
}

/**
 * Force close all connections (for testing/cleanup)
 * WARNING: This will break any active stores using these connections
 */
export async function closeAllConnections(): Promise<void> {
  const closePromises: Promise<void>[] = [];
  for (const info of connections) {
    closePromises.push(
      (async () => {
        try {
          if (info.encrypted) {
            await info.connection.run('CHECKPOINT store');
            await info.connection.run('DETACH store');
          } else {
            await info.connection.run('CHECKPOINT');
          }
        } catch {
          // Ignore cleanup errors
        }
        info.connection.closeSync();
        info.shared.instance.closeSync();
      })()
    );
  }
  connections.clear();
  instances.clear();
  await Promise.all(closePromises);
}
