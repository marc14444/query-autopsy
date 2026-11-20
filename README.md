<p align="center">
  <img src="./resources/icon.png" alt="QueryAutopsy logo" width="96" height="96" />
</p>

<h1 align="center">QueryAutopsy</h1>

<p align="center">
  <strong>X-Ray your PostgreSQL, MySQL 8+, and SQLite queries directly inside your editor.</strong><br/>
  Dissect live <code>EXPLAIN</code> execution plans, catch Full Table Scans, disk spills, and missing composite indexes before they hit production — works on <strong>VS Code, Antigravity, Cursor, Windsurf, and VSCodium</strong>.
</p>

<p align="center">
  <a href="https://github.com/marc14444/query-autopsy/actions/workflows/ci.yml"><img src="https://github.com/marc14444/query-autopsy/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/PostgreSQL-14%E2%80%9317%2B-336791.svg" alt="PostgreSQL 14-17+" />
  <img src="https://img.shields.io/badge/MySQL-8%2B%20%2F%20MariaDB-4479A1.svg" alt="MySQL 8+ / MariaDB" />
  <img src="https://img.shields.io/badge/SQLite-WASM%20(Zero%20Native)-003B57.svg" alt="SQLite WASM" />
  <img src="https://img.shields.io/badge/architecture-Hexagonal-0ea5e9.svg" alt="Hexagonal Architecture" />
</p>

![QueryAutopsy live execution plan inspection in VS Code](./resources/demo-screenshot.jpg)

---

## Why QueryAutopsy?

A SQL query over 20 dev rows finishes in 1 ms even without indexes — then stalls production APIs when the table reaches 500,000 rows. **QueryAutopsy** brings execution plan forensics inline inside your editor with strict safety guardrails:

- **Multi-Engine Support (`PostgreSQL`, `MySQL 8+`, `SQLite`)**:
  - **PostgreSQL 14–17+**: `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` inside `BEGIN READ ONLY` + `SET LOCAL statement_timeout` + unconditional `ROLLBACK`.
  - **MySQL 8+ / MariaDB**: Parses both `EXPLAIN ANALYZE` (`FORMAT=TREE` with inclusive/exclusive timings) and `EXPLAIN FORMAT=JSON` inside `START TRANSACTION` + `ROLLBACK`.
  - **SQLite (`.sqlite` / `.db`)**: Runs `EXPLAIN QUERY PLAN` via pure-JS **WASM (`sql.js`)** on an isolated in-memory copy — zero native binaries, zero risk of modifying `.db` files during inspection.
- **Staff-Level Diagnostics & Index QuickFixes (14 Rules)**:
  - **PostgreSQL**: `SEQ_SCAN_LARGE_TABLE`, **ESR Composite Index** (`WHERE` Equality → `ORDER BY` Sort → Range, including `Bitmap Heap Scan`), non-SARGable predicates (`lower(col)`, casts), correlated `SubPlan`s, lossy bitmap heap blocks, external disk spills, buffer misses, row misestimates, and high-loop `Nested Loop`s.
  - **MySQL & SQLite**: Full Table Scan (`ALL` / `SCAN`), `Using filesort`, `Using temporary`, `USE TEMP B-TREE`, transient automatic indexes, and row misestimates — each paired with copyable `CREATE INDEX` SQL.
- **Zero-Write HypoPG What-If Simulation & Before/After Diff**: Test suggested PostgreSQL indexes in memory (`Simulate (HypoPG)`), compare up to 5 consecutive runs (`ms`, `cost`, `buffers`, plan shape), and export formatted tables via **Copy PR Report (MD)**.
- **Multi-Language ORM CodeLens**: Surfaces `▶ Inspect Plan (ANALYZE)` and `◈ Estimate Plan` directly above queries in:
  - **`.sql` scripts** (`PostgreSQL`, `MySQL`, `SQLite`)
  - **TypeScript / JavaScript**: Prisma (`$queryRaw`, `$queryRawUnsafe`), Drizzle (`sql\`...\``), TypeORM (`.query()`), Knex (`.raw()`), `pg` / `mysql2`
  - **Python**: `psycopg`, `SQLAlchemy` (`text()`), `sqlite3`, Django (`.raw()`), `# sql` / triple-quoted SQL (normalizes `%s`, `%(name)s`, `:param` cleanly)
  - **Go**: `database/sql`, `pgx`, `sqlx`, `GORM` (`QueryContext`, `QueryRow`, `Exec`, `Raw`)
- **Slow Query Explorer Sidebar**: Inspect Top 10 slowest server queries from PostgreSQL `pg_stat_statements` or MySQL `performance_schema` in 1 click (on demand — zero silent background DB calls).
- **Safe Multi-Profile & Onboarding**: Guided Setup (`127.0.0.1` default, auto-encoding for special characters, SSL modes), auto-detection for `.env` / `docker-compose.yml` / `.sqlite` files, encrypted `SecretStorage` credentials, and Read-Only production locks (`[RO]`).

---

## Understanding Your Autopsy Report

| Metric / Screen | What It Means |
| :--- | :--- |
| **Execution Time** | Real DB runtime (`ms`) in `EXPLAIN ANALYZE`, plus planning overhead. Shows `N/A` in **Estimate Only** mode because the query is never executed. |
| **Total Cost** | Optimizer work score (unitless). Lower is faster — compare **Before vs After** creating an index. |
| **Buffer Cache Hit** | `%` of PostgreSQL data pages served from fast RAM (`Hit`) vs slower disk reads (`Read`). Aim for **> 95%**. |
| **I/O & Temp Spill** | Disk pages read or `KB spill` when an `ORDER BY` / Hash Join overflows `work_mem` onto temporary disk files. |
| **Seq Scan vs Index Scan** | `Seq Scan` / `Table Scan (ALL)` / `SCAN` reads every row in the table. Creating the suggested `CREATE INDEX` switches to an Index Scan (typically `10×–1000×` faster). |
| **Parameters (`$1`, `?`)** | Real app queries use placeholders instead of hardcoded values; enter sample values (e.g. `42, pending`) when prompted so `EXPLAIN ANALYZE` can execute safely. |

---

## Architecture (Hexagonal / Ports & Adapters)

```text
src/
├── domain/                  # Pure business rules (zero dependency on vscode or DB drivers)
│   ├── engines/             # Multi-engine registry + PG / MySQL / SQLite parsers & rules
│   ├── errors/              # DomainError hierarchy
│   ├── models/              # ConnectionProfile, ExecutionPlan, DiagnosticFinding, SlowQueryEntry
│   ├── ports/               # Inbound use-case & outbound driver/storage/UI ports
│   └── services/            # sqlClassifier, sqlBlockExtractor, planDiff, nodeExplainer, envDiscovery
├── application/             # Use-case orchestration (InspectQuery, ApplyIndex, SimulateIndex, FetchSlowQueries)
├── infrastructure/          # Adapters (pg, mysql2, sql.js WASM, SecretStorage, Webview, OutputChannel)
├── presentation/            # Driving adapters (Commands, CodeLens, Status Bar, TreeView, Composition Root)
├── webview/                 # Browser-bundled interactive UI (strict nonce CSP, VS Code theme tokens)
└── extension.ts             # Minimal VS Code entry point
```

---

## Quick Start (Local Playground)

1. **Install dependencies and build**:
   ```bash
   npm install
   npm run build
   ```

2. **Start the seeded PostgreSQL 16 (and optional MySQL 8.4) playground**:
   ```bash
   # PostgreSQL 16 (10,000 users + 150,000 orders with missing indexes)
   docker compose -f docker/docker-compose.yml up -d

   # Optional: also start MySQL 8.4
   docker compose -f docker/docker-compose.yml --profile mysql up -d
   ```

3. **Launch the Extension Development Host**:
   - Press `F5` (`Fn + F5` on macOS, or **Run and Debug → `Run QueryAutopsy Extension`**).
   - Click **`QueryAutopsy: Connect DB`** in the status bar (or run Command Palette → **`QueryAutopsy: Switch / Configure Database Profile`**) and choose **Auto-detect from workspace**, **Guided Setup**, or browse a local `.sqlite`/`.db` file.
   - Open `docker/sample_queries.sql` and click **`▶ Inspect Plan (ANALYZE)`** above any query (or open **Explorer → QueryAutopsy: Slow Queries**).

---

## Development Scripts

```bash
npm run check-types   # Strict TypeScript type-checking (Node host + Webview DOM)
npm run lint          # ESLint (typescript-eslint)
npm run test          # Vitest unit & SQLite WASM tests (63 tests, offline)
npm run test:e2e      # Live E2E suite against Docker PostgreSQL 16 & MySQL 8.4
npm run build         # Bundle extension, Webview, and sql-wasm.wasm with esbuild
npm run package:vsix  # Build universal production VSIX installer
```

---

## Documentation & Engineering Specs

- **[AGENTS.md](./AGENTS.md)** — Architectural boundaries, safety invariants, and contributor rules
- **[PRD-001](./docs/prd/PRD-001-query-autopsy-mvp.md)** — Product Requirements
- **[Master Roadmap (v0.2 → v1.0)](./docs/roadmap/ROADMAP-V0.2-TO-V1.0.md)** — Delivery roadmap across all 4 sprints
- **[Hexagonal Architecture](./docs/architecture/HEXAGONAL-ARCHITECTURE.md)** — Ports & Adapters blueprint
- **[ADRs](./docs/adr/README.md)** — Architecture Decision Records (`0001`–`0005`)
- **[Technical Specifications](./docs/specs/TECH-SPEC-01-sql-classifier-and-pg-executor.md)** — Classifier, Executor, Parser, Diagnostics, and Webview/CodeLens specs
- **[CONTRIBUTING.md](./CONTRIBUTING.md)** — Branch naming conventions & PR checklist

## License

[MIT](./LICENSE)
