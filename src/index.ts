/**
 * Main entry point for keyv-duckdb package
 *
 * DuckDB storage adapter for Keyv with AES-256-GCM encryption support.
 * Provides a native Keyv store implementation with SQL-optimized operations.
 */

export { closeAllConnections, getConnectionCount, isEncryptedConnection } from './connection-manager.ts';
export type { KeyvDuckDBOptions } from './keyv-duckdb.ts';
export { KeyvDuckDB, KeyvDuckDB as default } from './keyv-duckdb.ts';
