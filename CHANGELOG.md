# Changelog

All notable changes to **QueryAutopsy** will be documented in this file.

## [0.3.0] - 2026-11-19

### Added
- **Before / After Execution Diff**: Webview tracks up to 5 recent runs per normalized SQL query and renders execution time, cost, buffer, and plan-shape deltas with a baseline selector.
- **ESR Composite Index Optimizer**: Detects `Sort` over filtered scans and proposes `Equality -> Sort -> Range` composite indexes (`CREATE INDEX CONCURRENTLY ... (status, amount_cents DESC, ...)`).
- **Staff-Level PostgreSQL Diagnostic Rules**: Added `NON_SARGABLE_PREDICATE` (with safe expression index suggestions for `lower`/`upper`/`trim`), `CORRELATED_SUBPLAN`, and `BITMAP_LOSSY_BLOCKS`.
- **Plain-English Node Explanations**: Human-readable operator summaries inside the Webview Node Inspector (`nodeExplainer.ts`).
- **HypoPG What-If Simulation & PR Markdown Export**: Added `Simulate (HypoPG)` button (zero disk writes/locks when `hypopg` is installed) and `Copy PR Report (MD)` button in the Webview toolbar.

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
