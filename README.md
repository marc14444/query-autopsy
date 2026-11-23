<p align="center">
  <img src="./resources/icon.png" alt="QueryAutopsy logo" width="96" height="96" />
</p>

<h1 align="center">QueryAutopsy</h1>

<p align="center">
  <strong>X-Ray your PostgreSQL, MySQL 8+, and SQLite queries inside your editor, AI assistant, and CI pipeline.</strong><br/>
  Catch Full Table Scans, missing composite indexes, disk spills, and N+1 bursts before they hit production — works in <strong>VS Code, Antigravity, Cursor, Windsurf, and VSCodium</strong>.
</p>

<p align="center">
  <a href="https://github.com/marc14444/query-autopsy/actions/workflows/ci.yml"><img src="https://github.com/marc14444/query-autopsy/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/PostgreSQL-14%E2%80%9317%2B-336791.svg" alt="PostgreSQL 14-17+" />
  <img src="https://img.shields.io/badge/MySQL-8%2B%20%2F%20MariaDB-4479A1.svg" alt="MySQL 8+ / MariaDB" />
  <img src="https://img.shields.io/badge/SQLite-WASM%20(Zero%20Native)-003B57.svg" alt="SQLite WASM" />
  <img src="https://img.shields.io/badge/MCP-Zero--Trust%20Read--Only-10b981.svg" alt="Zero-Trust MCP" />
</p>

![QueryAutopsy live execution plan inspection in VS Code](./resources/demo-screenshot.jpg)

---

## Why Teams Adopt QueryAutopsy

A query over 20 local seed rows finishes in **1 ms** even with no index — then stalls production APIs when the table hits 500,000 rows. Meanwhile, ORMs silently fire 60 identical queries per HTTP request (**N+1 bursts**) that look "fast" individually.

**QueryAutopsy** solves both using one shared engine across **4 touchpoints**:

```text
  Your App in Dev / Test (Prisma, Drizzle, TypeORM, Django, SQLAlchemy, Laravel)
        │  (dev-only trace bridges — automatically disabled in production)
        ▼
  .query-autopsy/traces.jsonl  ◀────────────────────────────────┐
        │                                                       │
        ├──▶ 1. IDE Extension   (CodeLens EXPLAIN, HypoPG, N+1 Jump-to-Line)
        ├──▶ 2. AI Assistant    (Zero-Trust @query-autopsy/mcp Firewall)
        └──▶ 3. CI / PR Gate    (@query-autopsy/cli — check / ci / trace + SARIF)
```

---

## Get Started in 5 Minutes

### Step 1 — Inspect & Simulate Queries Directly in Your Editor

1. Install **QueryAutopsy** in VS Code (or Cursor / Windsurf / Antigravity / VSCodium).
2. Open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) and run:
   - **`QueryAutopsy: Auto-Detect Local Databases (.env / Docker / SQLite)`** — discovers local `.env`, `docker-compose.yml`, and `.sqlite`/`.db` files automatically; or
   - **`QueryAutopsy: Switch / Configure Database Profile`** — Guided Setup with encrypted OS `SecretStorage` (passwords are never stored in workspace files).
3. Open any file containing SQL or ORM calls and click the inline **CodeLens** above your query:
   - `◈ Estimate Plan` — runs `EXPLAIN` without executing the query.
   - `▶ Inspect Plan (ANALYZE)` — runs `EXPLAIN (ANALYZE, BUFFERS)` safely inside an explicit transaction + timeout + unconditional `ROLLBACK`.
4. **Test fixes before creating a migration**:
   - PostgreSQL suggestions include **Simulate (HypoPG)** to test a proposed `CREATE INDEX` in memory (zero disk writes, zero locks) and compare **Before vs After** runs (`ms`, cost, buffer hits, plan shape).
   - Click **Copy PR Report (MD)** to paste the benchmark directly into your Pull Request.
5. **Find database hotspots**: open **Explorer → `QueryAutopsy: Slow Queries`** to inspect the top slowest fingerprints from `pg_stat_statements` (PostgreSQL) or `performance_schema` (MySQL).

**Supported languages & ORMs for inline CodeLens**:
- **SQL** (`.sql`, PostgreSQL, MySQL, SQLite)
- **TypeScript / JavaScript**: Prisma (`$queryRaw`, `$queryRawUnsafe`), Drizzle (`sql\`...\``), TypeORM (`.query()`), Knex (`.raw()`), `pg`, `mysql2`
- **Python**: `psycopg`, SQLAlchemy (`text()`), `sqlite3`, Django (`.raw()`), triple-quoted / `# sql`
- **Go**: `database/sql`, `pgx`, `sqlx`, GORM
- **PHP / Laravel**: `DB::select()`, `DB::statement()`, `DB::raw()`, PDO `->prepare()`, heredocs/nowdocs (`<<<SQL`)

---

### Step 2 — Catch N+1 Bursts Automatically (Dev-Only Trace Bridges)

Plug a lightweight bridge into your **local/dev/test** app to stream sanitized query events into `.query-autopsy/traces.jsonl`. Every bridge **hard-blocks `production` by default**, scrubs inline `'...'` SQL string literals (`'[REDACTED]'`), strips bindings (`[]`), creates `.query-autopsy/.gitignore`, and blocks symlink writes.

#### Node.js / TypeScript ([`@query-autopsy/trace`](./packages/trace/))

```ts
import express from 'express';
import { PrismaClient } from '@prisma/client';
import {
  JsonlTraceRecorder,
  attachPrismaTracing,
  createExpressTraceMiddleware,
  // also available: createDrizzleLogger, createTypeOrmLogger
} from '@query-autopsy/trace';

const prisma = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
const recorder = new JsonlTraceRecorder({ defaultEngine: 'postgresql' });

attachPrismaTracing(prisma, recorder);

const app = express();
app.use(createExpressTraceMiddleware(recorder)); // isolates each HTTP request via AsyncLocalStorage
```

#### Python ([`query-autopsy-trace`](./packages/python/))

```python
# Django (settings.py — auto no-op when DJANGO_ENV / APP_ENV == "production")
MIDDLEWARE = [
    "query_autopsy_trace.QueryAutopsyDjangoMiddleware",
    # ...
]
```

```python
# SQLAlchemy (sync Engine or AsyncEngine)
from sqlalchemy import create_engine
from query_autopsy_trace import JsonlTraceWriter, attach_sqlalchemy_tracing

engine = create_engine("postgresql+psycopg://localhost/app")
writer = JsonlTraceWriter(workspace_root=".")
attach_sqlalchemy_tracing(engine, writer)

with writer.request_scope("req-checkout"):
    # Queries executed here share requestId="req-checkout" for accurate N+1 grouping
    ...
```

#### PHP / Laravel ([`marc14444/laravel-query-autopsy`](./packages/laravel/))

Install as a `--dev` Composer package (`APP_ENV=local` / `testing` auto-discovery via `QueryAutopsyServiceProvider`), or run the CLI through Artisan via `php artisan query:autopsy`.

**What happens in your editor?**
Open **Explorer → `QueryAutopsy: Runtime Traces (N+1)`**:
- `N_PLUS_ONE_BURST` and `SLOW_TRACE_QUERY` findings appear live as you hit endpoints or run tests.
- Click any finding to **Jump to Query Source Line** (`file:line` in TS/Python/PHP/Go) or trigger `EXPLAIN` directly on the offending query.

---

### Step 3 — Give Your AI Assistant SQL Eyes Without Exposing Your DB (`@query-autopsy/mcp`)

Let **GitHub Copilot, Cursor, Claude Code, Antigravity, or Windsurf** analyze your plans and N+1 traces through a **strictly read-only Zero-Trust MCP Firewall** — never raw SQL access, never table rows, never plaintext passwords on disk.

#### 10-Second Setup Inside VS Code
1. Open the Command Palette and run **`QueryAutopsy: Configure Safe AI MCP Server (@query-autopsy/mcp)`**.
2. Choose your AI client — the wizard safely creates or merges config without overwriting existing MCP servers:
   - VS Code / GitHub Copilot (`.vscode/mcp.json`)
   - Antigravity (`~/.gemini/antigravity/mcp_config.json`)
   - Cursor (`.cursor/mcp.json`)
   - Claude Code (`.mcp.json`)
   - Windsurf (`~/.codeium/windsurf/mcp_config.json`)
3. Credentials use masked `${input:query_autopsy_uri}` or `${env:QUERY_AUTOPSY_URI}` placeholders (plaintext URIs in workspace files are blocked, and `--allow-analyze` is disabled on `production` profiles).

#### The 5 Read-Only MCP Tools Exposed to Your AI
| Tool | What the AI Can Do | Built-In Guardrail |
| :--- | :--- | :--- |
| `autopsy_check_sql` | Static SQL safety & DDL/multi-statement check | 100% offline, zero DB connection |
| `autopsy_explain` | Inspect plan bottlenecks (`estimate` by default) | Never returns table rows; scrubs PII literals; `ANALYZE` requires `--allow-analyze` + non-prod + `ROLLBACK` |
| `autopsy_simulate_index` | Test a `CREATE INDEX CONCURRENTLY` via HypoPG | Virtual in-memory only; zero disk writes or locks |
| `autopsy_list_slow_queries` | Inspect Top slowest `pg_stat_statements` / `performance_schema` entries | Fingerprints only, PII redacted |
| `autopsy_analyze_traces` | Detect `N_PLUS_ONE_BURST` & `SLOW_TRACE_QUERY` in `.query-autopsy/traces.jsonl` | Strictly workspace-confined `.jsonl`/`.ndjson`; anti-symlink; raw bindings stripped |

#### Prompts Your Team Can Use Immediately
- *"Run `autopsy_analyze_traces` on `.query-autopsy/traces.jsonl`, pinpoint the `N_PLUS_ONE_BURST` callers in our controllers/views, and fix them."*
- *"Check this query's plan with `autopsy_explain`, then prove which composite index lowers the cost using `autopsy_simulate_index` before I write the migration."*
- *"Use `autopsy_list_slow_queries` to find the top 5 time-consuming queries and prioritize what to fix this sprint."*

---

### Step 4 — Block SQL & N+1 Regressions in CI/CD (`@query-autopsy/cli`)

Run the same rules headless in GitHub Actions, GitLab CI, or pre-merge checks:

```bash
# 1. Static SQL safety & anti-pattern check (no database required)
npx @query-autopsy/cli check --dir ./src --fail-on critical

# 2. Plan inspection across source files + SARIF 2.1.0 upload to GitHub Code Scanning
npx @query-autopsy/cli ci --dir ./src --uri "$QUERY_AUTOPSY_URI" --format sarif --fail-on warning

# 3. Fail the build if integration tests trigger N+1 bursts in .query-autopsy/traces.jsonl
npx @query-autopsy/cli trace --file .query-autopsy/traces.jsonl --fail-on warning --explain-top 3
```

---

## Security & Safety Guarantees

| Surface | Protection |
| :--- | :--- |
| **PostgreSQL `EXPLAIN ANALYZE`** | Runs inside `BEGIN READ ONLY` + `SET LOCAL statement_timeout` + unconditional `ROLLBACK` in `finally`; rejects `DDL` & multi-statement strings before touching PostgreSQL. |
| **MySQL 8+ / MariaDB** | Executes inside `START TRANSACTION` + `ROLLBACK`; supports `EXPLAIN ANALYZE` (`FORMAT=TREE`) and `EXPLAIN FORMAT=JSON`. |
| **SQLite (`.sqlite` / `.db`)** | Runs `EXPLAIN QUERY PLAN` via pure-JS **WASM (`sql.js`)** on an isolated in-memory copy — zero native binaries, zero writes to `.db` files. |
| **Credentials** | Stored in VS Code encrypted `SecretStorage`; never logged or written into workspace files. |
| **Dev Trace Bridges** | Disabled in `production`/`prod` by default; `'...'` literals replaced with `'[REDACTED]'`; `bindings: []` stripped; `.query-autopsy/.gitignore` created; symlink paths rejected. |
| **MCP AI Firewall** | Strict argument allowlisting, read-only annotations, `estimate`-only default, no arbitrary SQL execution, workspace-realpath confinement on trace files. |

---

## Diagnostics & Understanding Your Autopsy Report

- **PostgreSQL (`EXPLAIN` rules)**: `SEQ_SCAN_LARGE_TABLE`, **ESR Composite Index** (`WHERE` Equality → `ORDER BY` Sort → Range, including `Bitmap Heap Scan`), non-SARGable predicates (`lower(col)`, casts), correlated `SubPlan`s, lossy bitmap heap blocks, external disk spills, buffer misses, row misestimates, and high-loop `Nested Loop`s.
- **MySQL & SQLite**: Full Table Scan (`ALL` / `SCAN`), `Using filesort`, `Using temporary`, `USE TEMP B-TREE`, transient automatic indexes, and row misestimates — paired with copyable `CREATE INDEX` SQL.
- **Runtime Traces**: `N_PLUS_ONE_BURST` (per-`requestId` normalized SQL burst) and `SLOW_TRACE_QUERY`.

| Metric | What It Means |
| :--- | :--- |
| **Execution Time** | Real DB runtime (`ms`) in `EXPLAIN ANALYZE` (`N/A` in **Estimate Only** mode because the query never runs). |
| **Total Cost** | Optimizer work score (unitless). Compare **Before vs After** in HypoPG diff. |
| **Buffer Cache Hit** | `%` of PostgreSQL pages read from RAM (`Hit`) vs disk (`Read`). Aim for **> 95%**. |
| **I/O & Temp Spill** | Disk pages read or temp spill blocks when `ORDER BY` / Hash Join overflows `work_mem`. |
| **Parameters (`$1`, `?`)** | Enter sample values when prompted so `EXPLAIN ANALYZE` runs safely without editing source SQL. |

---

## Contributing & Local Extension Development

If you want to hack on QueryAutopsy itself or run the local Docker playground:

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
   - Open `docker/sample_queries.sql` and click **`▶ Inspect Plan (ANALYZE)`** above any query.

```bash
npm run check-types   # Build workspace packages + strict tsc checks (host + webview)
npm run lint          # ESLint across extension, packages, scripts, and tests
npm run test          # Vitest suite (125 tests across 30 files, offline)
npm run test:e2e      # Live E2E suite against Docker PostgreSQL 16 & MySQL 8.4
npm run build         # Bundle extension, webview, and sql-wasm.wasm with esbuild
npm run package:vsix  # Build universal VSIX installer
python3 -m unittest discover -s packages/python/tests -v  # Python bridge unit tests (7 tests)
```

---

## Documentation & Engineering Specs

- **[AGENTS.md](./AGENTS.md)** — Hexagonal architectural boundaries, safety invariants, and contributor rules
- **[PRD-001](./docs/prd/PRD-001-query-autopsy-mvp.md)** — Product Requirements
- **[Master Roadmap (v0.2 → v1.0)](./docs/roadmap/ROADMAP-V0.2-TO-V1.0.md)** — Delivery roadmap across all 4 sprints
- **[Universal Ecosystem & Security Roadmap (v1.1 → v2.0)](./docs/roadmap/ROADMAP-V1.1-TO-V2.0.md)** — Core extraction, MCP Firewall, JSONL Traces & Bridges
- **[Data & Analytics Roadmap (v1.8.2 → v1.9.x)](./docs/roadmap/ROADMAP-DATA-ANALYTICS-V1.8.2.md)** — OLAP diagnostics, Jupyter/dbt, DuckDB/Parquet, FinOps DW dry-runs & Python pipeline traces
- **[Hexagonal Architecture](./docs/architecture/HEXAGONAL-ARCHITECTURE.md)** — Ports & Adapters blueprint
- **[ADRs](./docs/adr/README.md)** — Architecture Decision Records (`0001`–`0006`)
- **[Technical Specifications](./docs/specs/TECH-SPEC-01-sql-classifier-and-pg-executor.md)** — Classifier, Executor, Parser, Diagnostics, and Webview/CodeLens specs
- **[CONTRIBUTING.md](./CONTRIBUTING.md)** — Branch naming conventions & PR checklist

## License

[MIT](./LICENSE)
