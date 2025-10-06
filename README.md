# keyv-duckdb

> DuckDB storage adapter for Keyv

[![npm](https://img.shields.io/npm/v/keyv-duckdb.svg)](https://www.npmjs.com/package/keyv-duckdb)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

DuckDB storage adapter for [Keyv](https://github.com/jaredwray/keyv), providing a persistent key-value store with optional AES-256-GCM encryption.

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

## Usage

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

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines.

## License

MIT © [Kevin Malakoff](https://github.com/kmalakoff) 