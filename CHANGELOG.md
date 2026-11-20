# Changelog

All notable changes to **QueryAutopsy** will be documented in this file.

## [1.2.0] - 2026-11-20

### Added & Refactored (Monorepo Core & Language-Agnostic CLI)
- **npm Workspaces Extraction (`@query-autopsy/core` & `@query-autopsy/executors`)**: Extracted zero-runtime-dependency domain/application logic into `packages/core` and database drivers (`pg`, `mysql2`, `sql.js`) into `packages/executors` with zero regressions to the VS Code / Open VSX extension bundle.
- **Language-Agnostic CLI & CI Gate (`@query-autopsy/cli`)**: Added `query-autopsy explain`, `query-autopsy ci`, and offline `query-autopsy check` supporting `--sql`, `--file`, `--dir`, and `--stdin` across `.sql`, TypeScript/JavaScript, Python, and Go, with `markdown`, `json`, and **SARIF 2.1.0** outputs, `--fail-on` exit gating, and `--redact` PII scrubbing.
- **npm OIDC Provenance Workflow**: Added `.github/workflows/npm-publish.yml` for opt-in workspace publishing with `--provenance`.

## [1.1.0] - 2026-11-20

### Security & Privacy Hardening
- **VS Code Workspace Trust Enforcement (`untrustedWorkspaces: limited`)**: Blocks `.env` / `docker-compose` / `.sqlite` auto-discovery, DB queries (`ANALYZE`, `Estimate`, `CodeLens`, `Slow Query Explorer`), HypoPG simulation, and index creation in untrusted repositories to prevent SSRF or unintended DB execution from cloned workspaces.
- **SQL Attack & Exfiltration Guardrails**: Blocks dangerous file/OS/SSRF/session-tampering constructs (`pg_read_file`, `dblink*`, `set_config`, `lo_import`/`lo_export`, `query_to_xml`, `LOAD_FILE`, `INTO OUTFILE`, `load_extension`) inside `sqlClassifier.ts`, and narrows `CREATE INDEX [CONCURRENTLY]` functional expression validation to an immutable built-in allowlist (`LOWER`, `UPPER`, `TRIM`, `BTRIM`, `LTRIM`, `RTRIM`, `LENGTH`, `OCTET_LENGTH`).
- **Transactional HypoPG Isolation**: `PgQueryExecutor.simulateHypotheticalIndex()` now re-validates SQL and runs HypoPG `EXPLAIN` inside `BEGIN READ ONLY` (or `BEGIN` for write queries) with `SET LOCAL statement_timeout` and guaranteed `ROLLBACK` cleanup.
- **Credential & TLS Transport Guardrails**: Refuses plaintext passwords in `queryAutopsy.postgres.fallbackConnectionString` (enforcing `SecretStorage`), blocks remote `?sslmode=no-verify` on `production` profiles, requires explicit modal confirmation for remote `no-verify` TLS on dev/staging, defaults non-loopback discovered `.env` profiles to `staging` (Read-Only locked), and warns when connecting as PostgreSQL `is_superuser`.
- **PII Redaction & Error Sanitization Primitives**: Added `redactSqlLiterals`, `redactExecutionPlanLiterals`, `sanitizeSqlError` (anti cast-error data exfiltration), and opt-in `queryAutopsy.privacy.redactLiteralsInReports`.

## [1.0.2] - 2026-11-20

### Fixed & Improved
- **Sub-Millisecond Comparison Noise Guard & Smart Baseline Selection**: `Before / After Comparison` now labels sub-millisecond timing deltas (`< 2 ms`, `< 1 ms` diff) and minor buffer jitter (`< 5` blocks) neutrally instead of false regression alarms, and keeps the pre-optimization plan/cost run selected across repeated post-fix re-runs.

## [1.0.1] - 2026-11-20

### Fixed & Updated
- **ESR Composite Index Detection on Bitmap Heap Scans**: `esrCompositeIndexRule` now inspects `Recheck Cond` and child `Bitmap Index Scan` / `BitmapAnd` / `BitmapOr` `Index Cond` nodes (and promotes high-row sorts to `warning`) so `Sort -> Bitmap Heap Scan -> Bitmap Index Scan` queries receive exact `Equality -> Sort -> Range` composite index suggestions.
- **Marketplace & Documentation Refresh (`README.md`)**: Updated Open VSX / GitHub landing page to document PostgreSQL, MySQL 8+, SQLite WASM, TypeScript/Python/Go ORM CodeLens, Slow Query Explorer, and a visual guide to reading KPI & diagnostic outputs.

## [1.0.0] - 2026-11-19

### Added
- **ORM & Multi-Language SQL CodeLens Extractor**: Expanded `sqlBlockExtractor.ts` to extract inspectable queries across **TypeScript/JavaScript ORMs** (Prisma `$queryRaw` / `$queryRawUnsafe`, Drizzle, TypeORM `.query()`, Knex `.raw()`), **Python** (`psycopg`, `SQLAlchemy`, `sqlite3`, Django `.raw()`, normalizing `%s` / `%(name)s` / `:param` into `$1..$n` while preserving `::cast`), and **Go** (`database/sql`, `pgx`, `sqlx`, `GORM`).
- **Slow Query Explorer Sidebar (`queryAutopsy.slowQueries`)**: Added Explorer TreeView inspecting Top 10 slowest queries from PostgreSQL `pg_stat_statements` and MySQL `performance_schema.events_statements_summary_by_digest` with mean/total duration sort toggle, zero silent background queries, and 1-click EXPLAIN opening.
- **Automated Live PostgreSQL & MySQL E2E Suite**: Added `tests/e2e/liveDatabases.e2e.test.ts` (`npm run test:e2e`) and GitHub Actions service containers (`postgres:16-alpine` & `mysql:8.4`) verifying live `EXPLAIN`, parameter binding, `ROLLBACK` isolation, and index creation end-to-end.

## [0.4.0] - 2026-11-19

### Added
- **Multi-Engine Architecture (`PostgreSQL`, `MySQL 8+`, `SQLite`)**: Added `DatabaseEngineAdapter` registry (`src/domain/engines/`), multi-engine SQL dialect classifier (`?`, `?1`, `$1`, backticks, `#` comments), and unified `MultiEngineQueryExecutor`.
- **MySQL 8+ / MariaDB Support (`mysql2`)**: Supports `EXPLAIN ANALYZE` (`FORMAT=TREE` with inclusive/exclusive timings) and `EXPLAIN FORMAT=JSON`, detecting `MYSQL_FULL_TABLE_SCAN` (`ALL`), `MYSQL_USING_FILESORT`, `MYSQL_USING_TEMPORARY`, and planner misestimates.
- **SQLite Support via Pure-JS WASM (`sql.js`)**: Zero-native cross-platform `EXPLAIN QUERY PLAN` analysis inside an isolated in-memory WASM copy (zero risk of mutating `.db`/`.sqlite` files during inspection), plus persistent `CREATE INDEX IF NOT EXISTS` QuickFix and `**/*.{sqlite,sqlite3,db}` workspace auto-detection.
- **Engine-Aware Profiles & UI**: Added engine selector & SQLite file picker in profile configuration, dynamic Status Bar engine badges (`PG:`, `MySQL:`, `SQLite:`), Webview engine badge, and engine-conditional HypoPG UI controls.

## [0.3.2] - 2026-11-19

### Fixed
- **GitHub Actions Release Workflow (`release.yml`)**: Replaced invalid step-level `if: ${{ secrets.* }}` expressions with shell checks against step `env` variables so tagged releases pass workflow validation and attach `.vsix` artifacts cleanly even when marketplace secrets are unset.

## [0.3.1] - 2026-11-19

### Fixed & Improved
- **Docker & PostgreSQL Authentication UX**: Added 6-step **Guided Setup** (`127.0.0.1` default, automatic URL encoding for `@`, `#`, `/`), active profile credential editing (`Update Credentials / URI`), `Retry` on failed connection test, and direct `Update Connection` button on `28P01` / `28000` errors.
- **Actionable Auth & SSL Diagnostics**: Exposed raw PostgreSQL auth errors with Docker `localhost:5432` vs `127.0.0.1` hints and added `?sslmode=no-verify` support (`ssl: { rejectUnauthorized: false }`) for self-signed TLS certificates.
- **Docker Compose `.env` Variable Resolution**: Workspace auto-discovery now substitutes `.env` variables and `${VAR:-default}` expressions in `docker-compose.yml` and prompts securely when a password variable remains unresolved.

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
