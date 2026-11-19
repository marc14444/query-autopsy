# Changelog

All notable changes to **QueryAutopsy** will be documented in this file.

## [0.2.0] - 2026-11-19

### Added
- **Multi-Profile Connection Manager & Status Bar**: Switch between `local`, `staging`, and `production` PostgreSQL profiles directly from the bottom status bar or Command Palette (`queryAutopsy.configureConnection`), with automatic migration from v0.1.0 `SecretStorage` URIs.
- **Production Read-Only Lock (`readOnlyLocked`)**: Profiles marked `staging`/`production` lock out `WRITE` `EXPLAIN ANALYZE` and hide/block the `Create index & re-analyze` QuickFix while still allowing `Estimate Plan` and `READ` inspection.
- **Workspace Auto-Discovery**: Added `queryAutopsy.discoverConnections` and pure `.env` / `docker-compose.yml` PostgreSQL URI extraction for 10-second onboarding.
- **Dual-Registry Release Pipeline**: Added `.github/workflows/release.yml` publishing to GitHub Releases, VS Code Marketplace (`vsce`), and Open VSX (`ovsx` for Antigravity, Cursor, Windsurf, VSCodium).

## [0.1.0] - 2026-11-19

### Added
- **Hexagonal Core**: Strict isolation between PostgreSQL plan parsing/diagnostics (`src/domain/`, `src/application/`) and VS Code / `pg` adapters (`src/infrastructure/`, `src/presentation/`).
- **Safe EXPLAIN Runner**: Wraps `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` in `BEGIN READ ONLY` + `SET LOCAL statement_timeout` + unconditional `ROLLBACK` in `finally`; blocks DDL and multi-statement queries; stores credentials in VS Code `SecretStorage`.
- **Diagnostic Engine**: Detects `SEQ_SCAN_LARGE_TABLE` (with `CREATE INDEX CONCURRENTLY` suggestions), `EXTERNAL_DISK_SPILL`, `PLANNER_ROW_MISESTIMATE`, `LOW_CACHE_HIT_RATIO`, and `NESTED_LOOP_HIGH_LOOPS`.
- **Interactive Execution Plan Webview**: Displays KPI strip, diagnostics cards with node jump & one-click SQL copy, color-coded execution tree with `PARALLEL` indicators, and Node Inspector drawer under strict nonce CSP.
- **CodeLens & Inline Editor Diagnostics**: Surfaces `Inspect Plan (ANALYZE)` and `Estimate Plan` CodeLenses in `.sql` and TypeScript/JavaScript SQL templates, plus red/yellow squiggles and QuickFix index copy actions.
