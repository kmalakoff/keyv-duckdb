# Changelog

All notable changes to this project will be documented here.

The format follows [Conventional Commits](https://www.conventionalcommits.org/).

## [Unreleased]

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

## Notes

This adapter follows the standard Keyv adapter pattern:
- Extends EventEmitter for error events
- Implements KeyvStoreAdapter interface
- Stores serialized values from Keyv as-is (no additional serialization)
- TTL is handled by Keyv via value metadata, not enforced in the adapter
- Simple key-value schema with no expires column
- Returns `undefined` (not `null`) for missing keys
- Supports namespace filtering in clear() and iterator()

