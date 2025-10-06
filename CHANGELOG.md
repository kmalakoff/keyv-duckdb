# Changelog

All notable changes to this project will be documented here.

The format follows [Conventional Commits](https://www.conventionalcommits.org/).

## [Unreleased]

### Added
- Initial DuckDB storage adapter for Keyv
- AES-256-GCM database-level encryption support via DuckDB
- Batch operations: `setMany`, `getMany`, `hasMany`, `deleteMany`
- Iterator support with namespace filtering
- Connection pooling and automatic cleanup
- Multi-version Node.js compatibility (16, 18, 20, 22, 24)
- Comprehensive test suite including compatibility tests
- TypeScript support with full type definitions

### Features
- Parameterized SQL queries for security
- Proper Keyv adapter semantics (no double serialization)
- EventEmitter-based error handling
- Configurable table names and key sizes
- Persistent file-based storage

### Developer Experience
- Biome formatting and linting
- Automated typecheck in build process
- Multi-version compatibility testing via `nvu`
- Comprehensive documentation and research notes

## Notes

This adapter follows the standard Keyv adapter pattern:
- Stores serialized values from Keyv as-is (no additional serialization)
- TTL is handled by Keyv via value metadata, not enforced in the adapter
- Simple key-value schema with no expires column
- Returns `undefined` (not `null`) for missing keys

