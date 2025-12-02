/**
 * @fileoverview Simple DuckDB connection manager using @duckdb/node-api
 *
 * Each store instance gets its own connection. Uses the modern Promise-based API.
 */

import { type DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';

interface ConnectionInfo {
  instance: DuckDBInstance;
  connection: DuckDBConnection;
  encrypted: boolean;
}

const connections = new Set<ConnectionInfo>();

/**
 * Create a new connection for the given database path and optional encryption key
 * Each call creates a separate connection instance
 *
 * For unencrypted databases: opens the file directly
 * For encrypted databases: uses in-memory instance with ATTACH (required by DuckDB)
 */
export async function getConnection(dbPath: string, encryptionKey?: string): Promise<DuckDBConnection> {
  let instance: DuckDBInstance;
  let encrypted = false;

  if (encryptionKey) {
    // Encrypted: must use in-memory + ATTACH pattern
    instance = await DuckDBInstance.create(':memory:');
    encrypted = true;
  } else {
    // Unencrypted: open file directly for proper persistence
    instance = await DuckDBInstance.create(dbPath);
  }

  const connection = await instance.connect();

  if (encryptionKey) {
    // Attach the file database with encryption
    const attachCommand = `ATTACH '${dbPath}' AS store (ENCRYPTION_KEY '${encryptionKey}')`;
    await connection.run(attachCommand);
  }

  const connectionInfo: ConnectionInfo = {
    instance,
    connection,
    encrypted,
  };

  connections.add(connectionInfo);
  return connection;
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

      try {
        if (info.encrypted) {
          // For encrypted connections, checkpoint and detach the attached database
          await connection.run('CHECKPOINT store');
          await connection.run('DETACH store');
        } else {
          // For unencrypted connections, checkpoint the main database to flush data
          await connection.run('CHECKPOINT');
        }
      } catch {
        // Ignore cleanup errors
      }

      // Close the connection, then the instance to release file locks
      connection.closeSync();
      info.instance.closeSync();
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
        info.instance.closeSync();
      })()
    );
  }
  connections.clear();
  await Promise.all(closePromises);
}
