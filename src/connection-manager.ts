/**
 * @fileoverview Simple DuckDB connection manager with process exit handling
 *
 * Each store instance gets its own connection. Connections are automatically
 * cleaned up on process exit using signal-exit.
 */

import DuckDB from 'duckdb';
import { onExit } from 'signal-exit';

interface ConnectionInfo {
  connection: DuckDB.Connection;
  database: DuckDB.Database;
}

const connections = new Set<ConnectionInfo>();

// Setup automatic cleanup on process exit
onExit(() => {
  closeAllConnections();
});

/**
 * Create a new connection for the given database path and optional encryption key
 * Each call creates a separate connection instance
 */
export async function getConnection(dbPath: string, encryptionKey?: string): Promise<DuckDB.Connection> {
  const database = new DuckDB.Database(':memory:');
  const connection = database.connect();

  // Attach the file database
  const attachCommand = encryptionKey ? `ATTACH '${dbPath}' AS store (ENCRYPTION_KEY '${encryptionKey}')` : `ATTACH '${dbPath}' AS store`;

  await new Promise<void>((resolve, reject) => {
    connection.run(attachCommand, (err: Error | null) => (err ? reject(err) : resolve()));
  });

  const connectionInfo: ConnectionInfo = {
    connection,
    database,
  };

  connections.add(connectionInfo);
  return connection;
}

/**
 * Remove and close a specific connection
 * Should be called when a store instance is disposed
 */
export function releaseConnection(connection: DuckDB.Connection): void {
  for (const info of connections) {
    if (info.connection === connection) {
      info.connection.close();
      info.database.close();
      connections.delete(info);
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
export function closeAllConnections(): void {
  for (const info of connections) {
    info.connection.close();
    info.database.close();
  }
  connections.clear();
}
