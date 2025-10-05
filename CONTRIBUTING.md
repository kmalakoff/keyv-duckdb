# Contributing to keyv-duckdb

Thank you for your interest in contributing!

This project aims to provide a reliable DuckDB storage adapter for Keyv with a clear compliance roadmap.

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
- `src/` – TypeScript source
- `test/` – Node test runner suites (unit + integration)
- `dist/` – Generated build artifacts (dual ESM/CJS) created by `tsds build`

## Coding Standards
- Strict TypeScript settings (noUncheckedIndexedAccess, exactOptionalPropertyTypes, etc.)
- All SQL must be parameterized – do not concatenate keys or values into SQL.
- Prefer small, reviewable commits with conventional prefixes (feat:, fix:, chore:, docs:, refactor:, test:).

## Commit Messages
Use Conventional Commit style:
- `feat:` new feature
- `fix:` bug fix
- `docs:` documentation changes
- `chore:` tooling or maintenance
- `test:` test-only updates

## Testing
- Use Node's built-in test runner (no Jest/Mocha to keep footprint small).
- Add tests alongside behavior changes—especially for storage semantics.
- Avoid flaky timing-based tests; if adding TTL later, use short deterministic intervals.

## Version Support
- The library targets Node >=16 runtime usage.
- CI / local multi-version checks can be performed with `nvu` (e.g. `nvu 16 node --version && nvu 16 npm test`).

## Release Process
1. Ensure working directory clean and tests passing.
2. Run `npm run build` (implicitly runs typecheck) before publish.
3. Update CHANGELOG.md with notable changes.
4. Bump version via `npm version <patch|minor|major>` (or tsds version tooling if configured) and push tags.
5. `npm publish --access public` (if not already configured).

## Roadmap Snapshot
- Level 0 (done): Minimal adapter compliance (parameterized SQL, return semantics)
- Level 1: TTL + raw mode + batching
- Level 2: Production robustness (migration notes, corruption strategy)
- Level 3: Optional performance optimizations (pooling, prepared statements)

## Questions / Issues
Open an issue with reproduction steps. For security-related concerns, please indicate clearly in the issue title.

Happy hacking!
