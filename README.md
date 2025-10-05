# keyv-duckdb

DuckDB-backed async object storage implementing the `AsyncStorage<T>` interface with React Native compatibility.

## Usage

```typescript
import { DuckDBStore } from '@mcp-z/keyv-duckdb';

// Basic usage
const store = new DuckDBStore<User>('./users.duckdb');

// With encryption
const store = new DuckDBStore<User>('./users.duckdb', {
  encryptionKey: process.env.ENCRYPTION_KEY,
});

await store.setItem('user:123', { id: 123, name: 'Alice' });
const user = await store.getItem('user:123');

// Efficient multi-operations using SQL optimization
const users = await store.multiGet(['user:123', 'user:456', 'user:789']);
await store.multiSet([['user:101', userData1], ['user:102', userData2]]);
```

## API

Implements `AsyncStorage<T>` interface with SQL optimization:
- `getItem(key: string): Promise<T | null>`
- `setItem(key: string, value: T): Promise<void>`
- `removeItem(key: string): Promise<void>`
- `clear(): Promise<void>`
- `getAllKeys(): Promise<string[]>`
- `multiGet(keys: string[]): Promise<Array<[string, T | null]>>` (SQL IN clause optimization)
- `multiSet(keyValuePairs: Array<[string, T]>): Promise<void>` (Batch INSERT optimization)
- `multiRemove(keys: string[]): Promise<void>` (SQL IN clause optimization)

## Performance Notes

- **Direct key access**: O(1) operations using compound keys for optimal performance
- **Multi-operations**: SQL batch operations for efficient bulk operations
- **Encryption**: Database-level encryption with no performance impact on queries

## Configuration

```typescript
interface DuckDBStoreOptions {
  encryptionKey?: string; // Optional database encryption
}
```

Encryption uses DuckDB's native database-level encryption when `encryptionKey` is provided.

## Build & publishing

This package is published with TypeScript source files and does NOT perform a local build step in the repository. A CI or publishing agent should perform type stripping or compilation as part of your release pipeline if you need JavaScript artifacts. The package intentionally includes the `src` directory so consumers (and monorepo build systems) can handle compilation.

- To run type checking locally: `npm run typecheck`
- To publish from CI, either run your normal TypeScript compile step or publish the source package as-is if your consumers expect TypeScript sources.

If you'd prefer to publish compiled JavaScript in `dist`, let me know and I can switch the package to emit `dist` and add a `prepare` script to build before publish.

## AsyncStorage reference

This package implements the `AsyncStorage<T>` interface. The local canonical interface is available at `src/async-storage.ts` in this repository — use that file as the single source of truth for typing and behavior.

For upstream compatibility, the typings are based on the React Native AsyncStorage types. See the original reference here:

https://github.com/react-native-async-storage/async-storage/blob/main/types/index.d.ts

Keeping the local `src/async-storage.ts` file in-sync with upstream ensures compatibility with libraries expecting the same AsyncStorage API.

## How this implements AsyncStorage

The `DuckDBStore` class (see `src/duckdb-store.ts`) implements the `AsyncStorage<T>` contract defined in `src/async-storage.ts`.

Key implementation details:

- getItem/setItem/removeItem/clear/getAllKeys: straightforward SQL operations against a `store.kv` table. Keys are validated and values are JSON serialized/deserialized.
- multiGet/multiSet/multiRemove: implemented using SQL `IN` clauses and batch `INSERT OR REPLACE` statements to optimize for bulk operations.
- Atomicity and consistency: `INSERT OR REPLACE` and single-statement batch operations are used to maintain atomic updates; a connection manager handles transactions where needed.
- Encoding: values are JSON-encoded before insertion and parsed on reads. `Serializable` typing in `src/async-storage.ts` indicates allowed value types.
- Encryption: optional database-level encryption is supported via DuckDB's ENCRYPTION_KEY when provided in `DuckDBStoreOptions`.

For the precise interface shape and parameter types, inspect `src/async-storage.ts` — it's intentionally kept compatible with React Native's AsyncStorage types (link in that file points to the upstream source).

If you'd like, I can also add a small example snippet in `README.md` showing `DuckDBStore` instantiation and a couple of operations (get/set/multiGet). Want that added? 