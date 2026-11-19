# QueryAutopsy Master Roadmap (`v0.2.0` → `v1.0.0`)

**Role**: Principal Backend Architecture & Product Execution Plan
**Status**: `v1.0.0` Sprint 4 Implemented (All 4 Sprints Complete)
**Mission**: Become the #1 cross-IDE SQL performance profiler across **VS Code, Antigravity IDE, Cursor, Windsurf, and VSCodium**.

---

## 1. Strategic Positioning & North Star Metrics

- **Positioning**: *"Zero-friction SQL performance forensics inside your editor — catch slow queries, missing composite indexes, and disk spills before they hit production."*
- **North Star Metric**: Weekly Active Inspected Queries (WAIQ) & `% of detected bottlenecks resolved via QuickFix / Index`.
- **Non-Negotiable Trust Principles**:
  1. **Zero Data Mutation by Default**: `BEGIN READ ONLY` + `SET LOCAL statement_timeout` + `ROLLBACK` on `EXPLAIN ANALYZE`; DDL blocked from inspection; explicit modal confirmation before any index creation.
  2. **Zero Credential Leaks**: `SecretStorage` only — never write passwords/tokens to workspace settings or logs.
  3. **Zero Silent Network / DB Calls**: Never auto-execute queries on file open or cursor move.
  4. **Zero Telemetry**: 100% local execution (critical trust factor for backend teams).

---

## 2. Release Roadmap (4 Focused Sprints)

### Sprint 1 (`v0.2.0`) — Zero-Friction Onboarding & Multi-IDE Distribution (Implemented)
**Theme**: *"From install to first execution plan in under 30 seconds, on every VS Code-compatible IDE."*

| Workstream | Deliverable | Hexagonal Layer | Acceptance Criteria |
| :--- | :--- | :--- | :--- |
| **Connection Profiles** | Multi-profile manager (`local`, `staging`, `prod`) + Status Bar switcher | `domain/ports`, `infrastructure/vscode`, `presentation/vscode` | Switching DB profile takes 1 click from status bar. |
| **Production Lock** | `readOnlyLocked` flag on profiles (`prod` defaults locked) | `domain/`, `application/` | Disables `allowWriteAnalyze` AND disables `Create Index` QuickFix when active profile is locked. |
| **`.env` Auto-Discovery** | Local detector scanning `.env` (`DATABASE_URL`, `POSTGRES_URL`) & `docker-compose.yml` | `infrastructure/vscode` | Prompts once with `"Connect to detected local PostgreSQL?"`; never reads secrets silently without consent. |
| **Dual Registry CI** | Release GitHub Action publishing signed `.vsix` to **VS Code Marketplace** (`vsce`) + **Open VSX** (`ovsx`) | `.github/workflows/release.yml` | Tagging `v*.*.*` deploys simultaneously to VS Code + Antigravity/Cursor/Windsurf/VSCodium. |

---

### Sprint 2 (`v0.3.0`) — PostgreSQL Staff-Level Intelligence & Viral UX (Implemented)
**Theme**: *"Solve deep DBA-level bottlenecks and make performance wins instantly visible."*

| Workstream | Deliverable | Hexagonal Layer | Acceptance Criteria |
| :--- | :--- | :--- | :--- |
| **Before / After Plan Diff** | Run history ring-buffer (last 5 runs per normalized SQL hash) + visual delta badge in Webview | `infrastructure/vscode/webview`, `webview/` | Shows `14.08 ms → 0.09 ms (-99.4%)`, buffer delta, and node-type shift (`Seq Scan → Bitmap Index Scan`). |
| **ESR Composite Indexes** | Cross-node rule inspecting `Sort` + child `Seq Scan` together | `domain/services/diagnosticEngine.ts` | Suggests `(status, amount_cents DESC)` for `WHERE status = 'pending' ORDER BY amount_cents DESC` to eliminate both scan and sort. |
| **Advanced PG Rules** | 1. `NON_SARGABLE_PREDICATE` (`lower(col)`, `date(ts)`, casts on column)<br/>2. `CORRELATED_SUBPLAN` (`SubPlan` repeated per outer row)<br/>3. `BITMAP_LOSSY_BLOCKS` (`Lossy Heap Blocks > 0`) | `domain/services/diagnosticEngine.ts` | Each rule carries unit tests on real PostgreSQL 16/17 JSON fixtures + plain-English explanation. |
| **HypoPG What-If Mode** | Detect `hypopg` extension and simulate index impact in memory (`Simulate Index` button) | `infrastructure/postgres`, `webview/` | Estimates new cost/plan with zero disk writes or locks when `hypopg` is installed. |
| **PR Markdown Export** | `"Copy Markdown Report"` button in Webview | `webview/`, `infrastructure/vscode/webview` | Copies clean Before/After summary + execution table ready to paste into GitHub Pull Requests. |

---

### Sprint 3 (`v0.4.0`) — Multi-Engine Architecture (`MySQL 8+` & `SQLite`) (Implemented)
**Theme**: *"Expand addressable user base 3× without duplicating Webview, CodeLens, or Editor Diagnostics."*

#### Architectural Pattern
Refactor single-engine services behind a `DatabaseEngineAdapter` registry keyed by `DatabaseEngine = 'postgresql' | 'mysql' | 'sqlite'`:

```text
src/domain/engines/
├── engineRegistry.ts          # Selects SQL classifier, plan parser & diagnostic rules by engine
├── postgres/                  # Existing PG logic isolated cleanly
├── mysql/                     # MySQL 8+ EXPLAIN ANALYZE / FORMAT=JSON adapter
└── sqlite/                    # SQLite EXPLAIN QUERY PLAN adapter
```

| Workstream | Deliverable | Acceptance Criteria |
| :--- | :--- | :--- |
| **Engine Port & Registry** | `DatabaseEngine` metadata on connection profiles; `QueryExecutorPort` dispatched by engine | All existing 33+ PostgreSQL tests stay green with zero regressions. |
| **MySQL 8+ / MariaDB** | `mysql2` infrastructure adapter parsing `EXPLAIN FORMAT=JSON` & `EXPLAIN ANALYZE` tree | Detects full table scans (`ALL`), `Using filesort`, `Using temporary`, and maps into unified `ExecutionPlan`. |
| **SQLite Adapter** | `EXPLAIN QUERY PLAN` parser (local `.sqlite` / `.db` files) | Detects `SCAN` vs `SEARCH USING INDEX` and `USE TEMP B-TREE FOR ORDER BY`. |

---

### Sprint 4 (`v1.0.0`) — Ecosystem, Server Forensics & Enterprise Readiness (Implemented)
**Theme**: *"Complete backend workflow coverage and production polish."*

| Workstream | Deliverable | Acceptance Criteria |
| :--- | :--- | :--- |
| **ORM & Multi-Lang SQL** | Expand `sqlBlockExtractor.ts` for Prisma, Drizzle, TypeORM, Knex, plus Python (`psycopg`/`sqlalchemy`) & Go (`database/sql`/`pgx`) raw strings | Zero false positives on non-SQL strings; parameterized placeholders normalized cleanly. |
| **Slow Query Explorer** | Optional Sidebar TreeView querying `pg_stat_statements` (Top 10 slowest by total/mean time) | Clicking any slow query opens and inspects its plan in 1 click. |
| **Automated Perf Tests** | E2E integration suite running against ephemeral Docker PostgreSQL & MySQL containers in GitHub Actions | CI validates live `EXPLAIN` execution, parameter binding, `ROLLBACK` isolation, and index creation. |

---

## 3. Technical Risk & Mitigation Register

| Risk | Severity | Mitigation |
| :--- | :--- | :--- |
| **Accidental mutation on shared/staging DB** | High | Profiles tagged `staging`/`prod` lock `readOnlyLocked: true` by default (blocks `WRITE` analyze and hides `Create Index` QuickFix). |
| **Leaky multi-engine abstraction diluting PG depth** | Medium | Keep `ExecutionPlan` as a shared presentation DTO while allowing engine-specific rules (`src/domain/engines/<engine>/`). |
| **CodeLens lag on massive TypeScript repositories** | Medium | Pure $O(N)$ linear scan, skip files > 200 KB (`maxFileSizeBytes` guard), zero DB calls unless clicked. |
| **Breaking VS Code / Antigravity / Cursor parity** | Medium | Restrict host dependencies strictly to stable VS Code API `^1.93.0`, keep Webview CSP self-contained (`dist/webview/`), test `.vsix` on both VS Code & Antigravity IDE. |

---

## 4. Recommended Immediate Next Action (Sprint 1 Kickoff)

Start **Sprint 1 (`v0.2.0`)** in two crisp PRs:
1. **PR #1 (`feat: connection profiles, status bar switcher, and read-only lock`)** — unlocks safe multi-DB workflows and instant `.env` onboarding.
2. **PR #2 (`ci: automated Open VSX + VS Code Marketplace release pipeline`)** — unlocks distribution across VS Code, Antigravity IDE, Cursor, Windsurf, and VSCodium.
