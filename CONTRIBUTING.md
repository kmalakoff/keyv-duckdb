# Contributing to keyv-duckdb

Thank you for your interest in contributing!

This project provides a DuckDB storage adapter for Keyv following the standard Keyv adapter pattern.

## Development Workflow

1. Clone and install dependencies:
   ```bash
   npm install
   ```

2. Run tests:
   ```bash
   npm test
   ```

3. Run type checking:
   ```bash
   npm run typecheck
   ```

4. Format & lint (Biome auto-fixes):
   ```bash
   npm run format
   ```

## Project Structure

- `src/keyv-duckdb.ts` – Main adapter implementation
- `src/connection-manager.ts` – DuckDB connection pooling
- `src/index.ts` – Public exports
- `test/` – Test suites using Node's test runner
- `test/compat/` – Multi-version compatibility tests
- `dist/` – Generated build artifacts (dual ESM/CJS)

## Understanding Keyv Adapters

**READ FIRST**: See `.agents/KEYV-ADAPTER-RESEARCH.md` for comprehensive documentation on the Keyv adapter pattern.

Key principles:
- **Adapters store values as-is** – Keyv handles serialization, not the adapter
- **No TTL enforcement in adapter** – Keyv wraps values with expiry metadata
- **Simple schema** – Just key-value table, no expires column needed
- **Return undefined on miss** – Not null
- **Batching is optional but recommended** – We implement setMany, getMany, hasMany, deleteMany

## Coding Standards

- Strict TypeScript settings (noUncheckedIndexedAccess, exactOptionalPropertyTypes, etc.)
- All SQL must be parameterized – do not concatenate keys or values into SQL
- Prefer small, reviewable commits with conventional prefixes (feat:, fix:, chore:, docs:, refactor:, test:)

## Commit Messages

Use Conventional Commit style:
- `feat:` new feature
- `fix:` bug fix
- `docs:` documentation changes
- `chore:` tooling or maintenance
- `test:` test-only updates
- `refactor:` code restructuring

## Testing

- Use Node's built-in test runner (no Jest/Mocha to keep footprint small)
- Test both Keyv-wrapped usage (normal) and direct adapter usage
- Verify batching operations maintain correct ordering
- Test persistence across connections
- Multi-version compatibility: `npm run test:compat`

## Version Support

- The library targets Node >=16 runtime
- CI and local multi-version checks use `nvu` for testing across Node 16/18/20/22/24

## Release Process

1. Ensure working directory is clean and tests pass
2. Update CHANGELOG.md with notable changes
3. Run `npm run build` (includes typecheck)
4. Bump version: `npm version <patch|minor|major>`
5. Push with tags: `git push && git push --tags`
6. Publish: `npm publish`

## What This Adapter Does (and Doesn't Do)

### ✅ Adapter Responsibilities
- Store and retrieve serialized values from Keyv
- Implement KeyvStoreAdapter interface (get, set, delete, clear, iterator)
- Provide batching optimizations (getMany, setMany, etc.)
- Handle database connections and cleanup
- Parameterize all SQL queries for safety

### ❌ NOT Adapter Responsibilities
- Serialization/deserialization (Keyv does this)
- TTL enforcement (Keyv handles via metadata)
- Value transformation
- Logging/metrics (beyond error events)
- Schema migrations for TTL support (not needed)

## Common Pitfalls to Avoid

1. **Don't add an expires column** – Keyv stores expiry in the value itself
2. **Don't serialize values yourself** – Store what Keyv gives you
3. **Don't implement raw mode APIs** – Not part of KeyvStoreAdapter
4. **Don't promise TTL features** – That's Keyv's job
5. **Don't confuse with AsyncStorage** – Different API pattern entirely

## Questions / Issues

Open an issue with reproduction steps. For security concerns, please indicate clearly in the issue title.

Happy hacking!
