# Changelog

All notable changes to this project will be documented here.

## [0.2.0] - 2026-11-16

**Back up your database file before upgrading.** The first time 0.2.0 opens a file written by 0.1.x it converts the table to a new layout, and the conversion cannot be undone. Opening it with 0.1.x afterwards fails.

### Changed

- Requires Keyv 6 (`keyv` peer `^6.1.0`) and Node.js 22.19.0 or newer.
- Uses DuckDB 2 (`@duckdb/node-api` 2.0). A database file created by 0.2.0 cannot be opened by 0.1.x or DuckDB 1.x.
- The table now has the `@keyv/sqlite` 6.1.0 layout: `key`, `value`, `namespace` (default empty), `expires`, unique on `(key, namespace)`. A 0.1.x table is converted on first open, in one transaction: `namespace:key` is split at the first colon, so what Keyv 5 stored as `keyv:<key>` becomes namespace `keyv`. `expires` is filled from the expiry stored in the Keyv 5 value. An interrupted conversion is finished on the next open. Plain and encrypted files are both converted.
- Keyv 6 has no default namespace. To read data written through Keyv 5's default, pass `namespace: 'keyv'` to `new Keyv`.
- Implements the Keyv 6 storage contract: expiry is stored per row and expired entries are not returned, `setMany` and `deleteMany` return one boolean per entry, and `iterator()` takes no argument.
- `clear()` and `iterator()` act on this store's namespace only. Use one `KeyvDuckDB` per namespace: Keyv 6 sets the namespace on the store, so one store cannot serve two namespaces.
- The constructor throws on an option it does not recognise, instead of ignoring it. Recognised: `path`, `table`, `encryptionKey`, `keySize`, `namespace`. The default path `~/.keyv-duckdb/store.duckdb` applies only when no path is given.

### Removed

- `opts`, `ttlSupport`, and the `dialect` and `url` options.

### Fixed

- Two `KeyvDuckDB` instances on the same file no longer lose each other's writes.
- An encryption key, database path or table name containing a quote no longer breaks opening the database.
- A namespace containing `_` or `%` no longer matches other namespaces.

### Notes

- Data written through `duckdb://` URLs by keyv-registry 2.x sits in `~/.keyv-duckdb/store.duckdb`, because that release ignored the path in the URL. It is not moved or converted by this package.

## Earlier releases (0.1.x)

Kept as written; the headings below are not versions.

### Phase 2 - Standard Adapter Compliance

- EventEmitter inheritance for proper error event handling
- KeyvStoreAdapter interface implementation for type safety
- ttlSupport property (set to false - Keyv handles TTL)
- namespace property for Keyv namespace support
- Namespace filtering in clear() method
- Namespace filtering in iterator() method
- Full compatibility with official Keyv adapter patterns

### Phase 1 - Core Implementation

- Initial DuckDB storage adapter for Keyv
- AES-256-GCM database-level encryption support via DuckDB
- Batch operations: `setMany`, `getMany`, `hasMany`, `deleteMany`
- Iterator support
- Connection pooling and automatic cleanup
- Multi-version Node.js compatibility (16, 18, 20, 22, 24)
- Comprehensive test suite including compatibility tests
- TypeScript support with full type definitions
- Parameterized SQL queries for security
- Proper Keyv adapter semantics (no double serialization)
- Configurable table names and key sizes
- Persistent file-based storage
- disconnect() method for cleanup

### Developer Experience

- Biome formatting and linting
- Automated typecheck in build process
- Multi-version compatibility testing via `nvu`
- Comprehensive documentation and research notes
