# Changelog

All notable changes to this project will be documented here.

The format follows Conventional Commits and is manually curated until/if automation is added.

## [Unreleased]
### Added
- CONTRIBUTING.md with development guidelines
- Biome formatting and lint configuration (biome.json)
- Typecheck script and prepublish build guard
- Minimal adapter compliance (Level 0):
  - Parameterized SQL (no manual escaping)
  - set now returns boolean
  - get returns undefined (instead of null) when key missing or value corrupt
  - keySize enforcement
  - Safe JSON decode (corrupt values yield undefined)

### Changed
- Broadened Node engine support to >=16

### Notes
- Upcoming Level 1 will introduce TTL, raw access, batching (setMany, getManyRaw, etc.).

