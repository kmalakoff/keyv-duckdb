# keyv-duckdb

A local DuckDB storage adapter for [Keyv](https://keyv.org), with optional database encryption.

[![npm](https://img.shields.io/npm/v/keyv-duckdb.svg)](https://www.npmjs.com/package/keyv-duckdb) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Use it when you want Keyv's cache API backed by a local DuckDB file. The adapter supports batch methods and key iteration through Keyv's store interface.

## Install

```bash
npm install keyv keyv-duckdb
```

Install both packages: `keyv-duckdb` provides the storage adapter, while `keyv` provides the public cache API.

Node.js 22.19.0 or newer is required. This package declares a peer dependency on Keyv 6.1.0 or newer.

## Quick Start

```javascript
import Keyv from 'keyv';
import { KeyvDuckDB } from 'keyv-duckdb';

// Create a Keyv instance with DuckDB storage
const keyv = new Keyv({
  store: new KeyvDuckDB('./my-database.duckdb'),
});

// Use Keyv's standard API
await keyv.set('hello', 'world');
const value = await keyv.get('hello'); // 'world'
```

Keyv handles serialization and TTL; the adapter stores the namespace and expiry columns. Use `KeyvDuckDB` as the store passed to `Keyv`, rather than as the public cache API.

## Encryption

```javascript
import Keyv from 'keyv';
import { KeyvDuckDB } from 'keyv-duckdb';

const keyv = new Keyv({
  store: new KeyvDuckDB('./secure.duckdb', {
    encryptionKey: process.env.KEYV_DUCKDB_KEY,
  }),
});

// Set KEYV_DUCKDB_KEY before starting this program.
await keyv.set('key', { complex: 'object' });
const value = await keyv.get('key');
```

## Options

```typescript
interface KeyvDuckDBOptions {
  /** Path to DuckDB database file. Default: ~/.keyv-duckdb/store.duckdb */
  path?: string;

  /** Table name for key-value storage. Default: 'keyv' */
  table?: string;

  /** Encryption key passed to DuckDB */
  encryptionKey?: string;

  /** Maximum key size in characters */
  keySize?: number;

  /** Namespace. Keyv sets this when you pass `namespace` to `new Keyv`. Default: none */
  namespace?: string;
}
```

An unrecognised option throws. The default path is used only when no path is given.

When an `encryptionKey` is provided, the adapter opens the database with DuckDB's native database-level encryption. The key is required for every subsequent connection. Keep it outside the database, and do not expect encryption to have zero performance cost. If the key is lost, the encrypted data cannot be recovered.

## Advanced Usage

### Custom Table and Path

```javascript
const store = new KeyvDuckDB({
  path: './custom/path/data.duckdb',
  table: 'cache',
  keySize: 500,
});
```

### Namespace Support

Keyv 6 sets the namespace on the store, so use one `KeyvDuckDB` per namespace. Stores on the same file share one DuckDB instance.

```javascript
const users = new Keyv({ store: new KeyvDuckDB('./my-database.duckdb'), namespace: 'users' });
const posts = new Keyv({ store: new KeyvDuckDB('./my-database.duckdb'), namespace: 'posts' });

await users.set('123', { name: 'Alice' });
await posts.set('456', { title: 'Hello' });

// Namespaces are isolated
await users.clear(); // Only clears users namespace
```

## Table layout

Rows live in one table (default `keyv`) with the same layout as `@keyv/sqlite` 6.1.0: `key`, `value`, `namespace` (empty when unset), `expires` (Unix milliseconds, or null) and a unique constraint on `(key, namespace)`.

## Upgrading from 0.1.x

**Back up your database file first.** The first time 0.2.0 opens a 0.1.x file it converts the table to the layout above in one transaction. The conversion is one-way: 0.1.x cannot read the result.

Keyv 5 stored keys as `<namespace>:<key>`, with `keyv` as the default namespace. The conversion splits each key at its first colon, so data written with Keyv 5's defaults ends up in namespace `keyv`. Keyv 6 has no default namespace, so read it with:

```javascript
const keyv = new Keyv({ store: new KeyvDuckDB('./my-database.duckdb'), namespace: 'keyv' });
```

Converted rows have `expires` NULL until they are rewritten. Through Keyv, expiry is still honoured, because Keyv reads it from the stored value.

A file created by 0.2.0 uses DuckDB 2's storage format, which DuckDB 1.x cannot open.

## Troubleshooting

**Database locked errors**: Ensure only one process accesses the database file at a time.

**Encryption errors**: Verify that the same encryption key is used for every connection.

**General Keyv issues**: See the [Keyv documentation](https://keyv.org) for help with Keyv-specific features and patterns.

## Resources

- [Keyv Documentation](https://keyv.org) - Full Keyv API and usage guide
- [Keyv GitHub](https://github.com/jaredwray/keyv) - Main Keyv repository
- [DuckDB](https://duckdb.org) - Learn about DuckDB features
- [Other Keyv Adapters](https://github.com/jaredwray/keyv#official-storage-adapters) - Compare with Redis, SQLite, PostgreSQL, etc.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines.

## License

MIT © [Kevin Malakoff](https://github.com/kmalakoff)
