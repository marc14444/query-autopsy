# Changelog

All notable changes to **QueryAutopsy** will be documented in this file.

## [1.8.1] - 2026-11-22

### Documentation
- **Developer Onboarding & Marketplace README Rewrite**: Reorganized `README.md` with an end-to-end 5-minute onboarding guide covering the IDE CodeLens/HypoPG workflow, copy-paste trace bridge setups (`@query-autopsy/trace`, `query-autopsy-trace`, `marc14444/laravel-query-autopsy`), Zero-Trust AI MCP setup & sample prompts (`@query-autopsy/mcp`), CLI/CI SARIF gating (`@query-autopsy/cli`), and security guarantees.

## [1.8.0] - 2026-11-22

### Added (Python & Node/TS Dev-Only Trace Bridges)
- **`@query-autopsy/trace` (`packages/trace/`, Dual CJS + ESM)**: Thin Node.js/TypeScript runtime bridge emitting sanitized `.query-autopsy/traces.jsonl` records with `AsyncLocalStorage` request scoping (`createExpressTraceMiddleware`, `runWithRequest`), ready-to-wire ORM adapters for **Prisma** (`attachPrismaTracing`), **Drizzle** (`createDrizzleLogger`), and **TypeORM** (`createTypeOrmLogger`), production guardrails (`NODE_ENV`/`APP_ENV=production` disabled by default), PII literal/binding scrubbing (`redactSqlLiterals`), caller location resolution, `.gitignore` initialization, anti-symlink checks, and `traces.jsonl.1` size rotation.
- **`query-autopsy-trace` (`packages/python/`, Zero-Dependency Python >=3.9 Stdlib)**: Thin Python bridge supporting **Django** (`QueryAutopsyDjangoMiddleware` via `connection.execute_wrapper`) and **SQLAlchemy** (`attach_sqlalchemy_tracing` via `before_cursor_execute`/`after_cursor_execute`), `contextvars` + `threading.Lock` request isolation, strict production lock (`APP_ENV`/`DJANGO_ENV`/`FLASK_ENV`/`ENV`/`ENVIRONMENT=production` disabled by default), SQL string scrubbing, binding redaction, anti-symlink protection, `.gitignore` creation, and size rotation.
- **CI & Cross-Runtime Verification**: Added `python-trace-bridge` job to `.github/workflows/ci.yml`, `@query-autopsy/trace` dual build/publish wiring in `scripts/build-packages.mjs` and `.github/workflows/npm-publish.yml`, plus Vitest integration coverage (`tests/integrations/nodeTraceBridge.test.mts`, `tests/integrations/pythonTraceBridge.test.ts`).

## [1.7.0] - 2026-11-22

### Added (Safe AI MCP Setup Wizard inside VS Code)
- **Zero-Trust MCP Configuration Wizard (`queryAutopsy.configureMcp`)**: Interactive 3-step setup generating or cleanly merging `@query-autopsy/mcp` configs across **VS Code / GitHub Copilot** (`.vscode/mcp.json`), **Antigravity** (`~/.gemini/antigravity/mcp_config.json`), **Cursor** (`.cursor/mcp.json`), **Claude Code** (`.mcp.json`), **Windsurf** (`~/.codeium/windsurf/mcp_config.json`), or Clipboard/Preview JSON.
- **Anti-Secret-Leakage & Security Guardrails (`mcpConfigWriter.ts`)**: Uses masked `${input:query_autopsy_uri}` session prompts in VS Code or `${env:QUERY_AUTOPSY_URI}` placeholders, strictly blocks writing plaintext passwords (`connectionUriHasPlaintextPassword`) into workspace files, disables `--allow-analyze` on `production` profiles, enforces strict PII redaction by default, preserves existing MCP servers on JSON merge, and validates workspace symlinks before writing.

## [1.6.0] - 2026-11-20

### Added (VS Code Runtime Trace & N+1 Explorer)
- **Explorer Sidebar View (`QueryAutopsy: Runtime Traces (N+1)`)**: Added `TraceExplorerTreeProvider` surfacing `N_PLUS_ONE_BURST`, `SLOW_TRACE_QUERY`, and top cumulative queries directly inside VS Code from `.query-autopsy/*.{jsonl,ndjson}` with live debounced `FileSystemWatcher` auto-refresh (100% offline parsing, zero silent database calls).
- **1-Click Jump to Source & Parameterized Trace EXPLAIN**: Clicking any N+1 or slow finding jumps straight to the originating PHP/TypeScript/Python/Go `file:line`, and inline `$(eye)` Estimate / `$(play)` ANALYZE actions open interactive execution plan Webviews (automatically forwarding recorded bindings when present and enforcing Workspace Trust).
- **Workspace Trace Security Guards (`workspaceTraceDiscovery.ts`)**: Constrained trace file discovery/reads and `file:line` jump resolution with `fs.realpath` workspace confinement, `.jsonl`/`.ndjson` extension checks, `10 MiB` size caps, and anti-symlink escape guards.
- **Configuration Settings**: Added `queryAutopsy.traces.nPlusOneThreshold`, `queryAutopsy.traces.slowQueryMsThreshold`, `queryAutopsy.refreshTraces`, and `queryAutopsy.openTraceFile`.

## [1.5.0] - 2026-11-20

### Added (`marc14444/laravel-query-autopsy` — Lightweight Dev-Only Laravel Bridge)
- **Thin Composer Package (`packages/laravel/composer.json` — PHP `^8.1`, Laravel `10/11/12`)**:
  - Hooks `DB::listen()` automatically via `QueryAutopsyServiceProvider` (`afterResolving('db')`) ONLY when `APP_ENV` is in `allowed_environments` (`local`, `testing`), guaranteeing zero DB listeners or overhead in `APP_ENV=production`.
  - Emits sanitized JSONL records matching `.query-autopsy/traces.jsonl` via `JsonlTraceWriter`, with `BindingSanitizer` redacting inline `'...'` SQL string literals (`'[REDACTED]'`) and stripping bindings (`[]`) by default, `CallerLocator` mapping backtraces to workspace source lines, automatic `.query-autopsy/.gitignore` creation, anti-symlink write protection, bounded per-request memory buffer, and automatic size rotation (`traces.jsonl.1`).
  - Isolates queue jobs & Laravel Octane requests (`JobProcessed` / `RequestTerminated`) cleanly into independent `requestId` windows so N+1 bursts stay scoped per request/job.
- **Artisan Command (`php artisan query:autopsy`)**: `QueryAutopsyCommand` wraps `@query-autopsy/cli` (`trace`, `ci`, `check`) using raw argument-vector `proc_open(array $argv)` (zero shell injection) and passes `--uri` strictly via `QUERY_AUTOPSY_URI` subprocess environment variable (zero credential leaks in process listings).
- **CI & Cross-Runtime Tests**: Added PHP syntax linting (`php -l`), `composer validate --strict`, native PHP test suite (`packages/laravel/tests/run.php`), and end-to-end Vitest integration test (`tests/integrations/laravelBridge.test.mts`) verifying real PHP JSONL output consumed by `@query-autopsy/core`, `@query-autopsy/cli`, and `@query-autopsy/mcp`.

## [1.4.0] - 2026-11-20

### Added (Universal JSONL Trace Contract, N+1 Burst Detector & PHP/Laravel Support)
- **Universal `.query-autopsy/traces.jsonl` Trace Contract (`@query-autopsy/core`)**: Added pure domain schema (`QueryTraceEntry`), bounded JSONL stream parser (`parseQueryTraceStream`), structural SQL fingerprinter (`computeTraceQueryFingerprint`, normalizing literals, `$N`/`?`/`:param` bindings, numeric constants, `IN (...)` lists, and multi-row `VALUES`), and request-scoped burst analyzer (`analyzeQueryTraces`, emitting `N_PLUS_ONE_BURST` and `SLOW_TRACE_QUERY` diagnostics).
- **CLI Trace Gate (`query-autopsy trace`)**: Added `query-autopsy trace [--file <path> | --stdin] [--threshold-n1 <n>] [--slow-ms <ms>] [--explain-top <N>]` with `markdown`, `json`, and **SARIF 2.1.0** output plus `--redact` and `--fail-on` CI gating (defaulting to `.query-autopsy/traces.jsonl`).
- **Workspace-Confined MCP Trace Analyzer (`autopsy_analyze_traces`)**: Added strictly read-only 5th tool to `@query-autopsy/mcp` with strict workspace realpath + `.jsonl`/`.ndjson` extension confinement (anti-path-traversal / anti-symlink escape), raw binding suppression, PII literal scrubbing, and optional read-only `EXPLAIN estimate` on top offenders.
- **PHP / Laravel Source Extraction**: Added `php-sql` extractor (`extractPhpSqlBlocks`) in `sqlBlockExtractor.ts` supporting Laravel `DB::select` / `DB::statement` / `DB::raw`, PDO `->prepare()` / `->query()`, heredocs (`<<<SQL`), nowdocs (`<<<'SQL'`), and PDO `:named` parameter normalization; wired `onLanguage:php` in VS Code activation/CodeLens and `.php` scanning in `@query-autopsy/cli`.

## [1.3.1] - 2026-11-20

### Fixed & Improved
- **Actionable DDL & Application-Code Error Guidance**: `InspectQueryService` now names the detected DDL keyword (e.g. `"CREATE TABLE"`, `"CREATE UNIQUE INDEX"`, `"DROP TABLE"`) and explains that EXPLAIN only runs on data queries, and detects when application source code (`await ...`, `import ...`, `const ...`) was selected instead of SQL.
- **Smart ORM Selection Unwrapping**: Right-click `Inspect Query Performance` in TypeScript/JavaScript/Python/Go files now unwraps single wrapper expressions (e.g. `await queryRunner.query(\`SELECT ...\`)`) automatically via `extractSqlBlocks`, and `SQL_LANGUAGE_IDS` + cursor extraction now pass the document engine dialect (`mysql`, `sqlite`, `postgresql`) so MySQL `\'` escapes and `#` comments do not bleed across statements.
- **Slow Queries Explorer DDL Filter**: `MultiEngineSlowQueryReader` now filters DDL/maintenance statements (`CREATE`, `ALTER`, `DROP`, `VACUUM`, `ANALYZE`, etc.) from PostgreSQL `pg_stat_statements` and MySQL `performance_schema` results so every listed entry is inspectable.

## [1.3.0] - 2026-11-20

### Added (`@query-autopsy/mcp` — Zero-Trust AI-to-DB MCP Firewall)
- **Zero-Dependency Local `stdio` MCP Server (`npx @query-autopsy/mcp`)**: Connects Antigravity, Cursor, Claude Code, and Windsurf safely to database execution plans with zero open TCP ports or external HTTP tunnels.
- **Strictly Bounded Read-Only Tools**: Exposes `autopsy_check_sql` (offline static audit), `autopsy_explain` (`estimate` default; `analyze` gated by `--allow-analyze` on non-production targets), `autopsy_simulate_index` (HypoPG what-if), and `autopsy_list_slow_queries` (`pg_stat_statements` / `performance_schema`).
- **Zero-Trust Security Middleware**: Strictly excludes `ApplyIndexUseCase` (`CREATE INDEX`), `allowWriteAnalyze`, raw SQL tools (`run_sql`), and LLM-supplied connection strings (SSRF prevention); strips prompt-injection SQL comments, redacts PII literals by default (`--no-redact` opt-out), and sanitizes SQL cast/constraint errors via `sanitizeSqlError`.
- **Shared Core Adapter**: Extracted `StaticConnectionConfig` into `@query-autopsy/core` for stateless CLI and MCP use cases.

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
