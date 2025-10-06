# keyv-duckdb

> DuckDB storage adapter for [Keyv](https://github.com/jaredwray/keyv) - persistent key-value storage with encryption

[![npm](https://img.shields.io/npm/v/keyv-duckdb.svg)](https://www.npmjs.com/package/keyv-duckdb)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A Keyv storage adapter that uses DuckDB for local file-based storage, similar to [@keyv/sqlite](https://github.com/jaredwray/keyv/tree/main/packages/sqlite) but with optional database-level encryption and optimized batch operations. Works with Keyv's standard API for caching, session storage, or any key-value needs.

## About

[Keyv](https://keyv.org) is a simple and consistent key-value storage library for Node.js. It supports multiple storage backends (Redis, MongoDB, SQLite, PostgreSQL, etc.) through storage adapters.

**keyv-duckdb** is a storage adapter that uses DuckDB as the backend, offering:
- 🗄️ **File-based persistent storage** (like SQLite)
- 🔒 **Optional database-level encryption** (AES-256-GCM via DuckDB)
- ⚡ **Optimized batch operations** (setMany, getMany, hasMany, deleteMany)
- 🌐 **Multi-version support** (Node.js 16, 18, 20, 22, 24)

**Use this adapter when you want**: Local persistent storage with optional encryption, similar to SQLite but with DuckDB's benefits.

## Features

- 🔒 **Optional Encryption**: Database-level AES-256-GCM encryption via DuckDB
- ⚡ **Batch Operations**: Optimized `setMany`, `getMany`, `hasMany`, `deleteMany` support
- 🔄 **Iterator Support**: Efficient key iteration with namespace filtering
- 💾 **Persistent Storage**: Reliable file-based storage with transaction safety
- 🎯 **Type Safe**: Full TypeScript support with comprehensive type definitions
- 🌐 **Multi-Version**: Tested on Node.js 16, 18, 20, 22, and 24

## Install

```bash
npm install keyv keyv-duckdb
```

> **Note**: You need both `keyv` and `keyv-duckdb`. This package is a storage adapter for Keyv and must be used through the Keyv library.

## Quick Start

```javascript
import Keyv from 'keyv';
import { KeyvDuckDB } from 'keyv-duckdb';

// Create a Keyv instance with DuckDB storage
const keyv = new Keyv({
  store: new KeyvDuckDB('./my-database.duckdb')
});

// Use Keyv's standard API
await keyv.set('hello', 'world');
const value = await keyv.get('hello'); // 'world'
```

## Usage

> **Important**: This is a Keyv storage adapter. Always use it through the Keyv library as shown above. Keyv handles serialization, TTL, and namespacing. Don't use `KeyvDuckDB` directly.

```javascript
import Keyv from 'keyv';
import { KeyvDuckDB } from 'keyv-duckdb';

// Basic usage
const keyv = new Keyv({
  store: new KeyvDuckDB('./my-database.duckdb')
});

// With encryption
const keyv = new Keyv({
  store: new KeyvDuckDB('./secure.duckdb', {
    encryptionKey: process.env.ENCRYPTION_KEY
  })
});

// Use Keyv as normal - it handles serialization, TTL, etc.
await keyv.set('key', { complex: 'object' });
const value = await keyv.get('key');

// TTL support (handled by Keyv)
await keyv.set('temp', 'data', 1000); // Expires in 1 second
```

## Options

```typescript
interface KeyvDuckDBOptions {
  /** Path to DuckDB database file. Default: ~/.keyv-duckdb/store.duckdb */
  path?: string;
  
  /** Table name for key-value storage. Default: 'keyv' */
  table?: string;
  
  /** Encryption key for AES-256-GCM encryption. Recommended: 32+ characters */
  encryptionKey?: string;
  
  /** Maximum key size in characters. Default: 255 */
  keySize?: number;
}
```

### Encryption

When an `encryptionKey` is provided, DuckDB's native database-level encryption is enabled. The encryption is transparent to Keyv and has no performance impact on queries.

```javascript
const store = new KeyvDuckDB('./secure.duckdb', {
  encryptionKey: 'your-secure-key-at-least-32-characters-long'
});
```

**Important**: Keep your encryption key secure. If lost, encrypted data cannot be recovered.

## Advanced Usage

### Custom Table and Path

```javascript
const store = new KeyvDuckDB({
  path: './custom/path/data.duckdb',
  table: 'cache',
  keySize: 500
});
```

### Batch Operations

The adapter provides optimized batch operations that are automatically used by Keyv:

```javascript
// These use optimized SQL batch operations internally
await keyv.set('key1', 'value1');
await keyv.set('key2', 'value2');
await keyv.set('key3', 'value3');

const values = await Promise.all([
  keyv.get('key1'),
  keyv.get('key2'),
  keyv.get('key3')
]);
```

### Namespace Support

```javascript
const users = new Keyv({ store, namespace: 'users' });
const posts = new Keyv({ store, namespace: 'posts' });

await users.set('123', { name: 'Alice' });
await posts.set('456', { title: 'Hello' });

// Namespaces are isolated
await users.clear(); // Only clears users namespace
```

## How It Works

This adapter implements the Keyv storage interface and stores serialized data in a DuckDB database. Key points:

- **Serialization**: Keyv handles serialization/deserialization of values
- **TTL**: Keyv wraps values with expiry metadata; adapter stores it as-is
- **Schema**: Simple `key-value` table with parameterized queries for safety
- **Connection Management**: Automatic connection pooling and cleanup on process exit

## Testing

```bash
# Run test suite
npm test

# Multi-version compatibility test (requires nvu)
npm run test:compat

# Type checking
npm run typecheck
```

## Troubleshooting

**Database locked errors**: Ensure only one process accesses the database file at a time.

**Encryption errors**: Verify your encryption key is correct and consistent across uses. If you lose the key, encrypted data cannot be recovered.

**TypeScript errors**: Install `@types/node` if you encounter type errors.

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