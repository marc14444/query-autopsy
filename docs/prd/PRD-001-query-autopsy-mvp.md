# PRD-001: QueryAutopsy — PostgreSQL EXPLAIN & Performance Inspector

- **Status**: Active (Milestones 1–3 Implemented)
- **Product Name**: QueryAutopsy (`query-autopsy`)
- **License**: MIT (Open Source)
- **Target Runtime**: VS Code `^1.93.0`, Node.js Extension Host, PostgreSQL 14–17+

---

## 1. Problem Statement

Backend and full-stack developers routinely write SQL queries inside `.sql` files or TypeScript/Node codebases (`pg`, `knex`, `prisma.$queryRaw`, `drizzle` raw SQL) without ever checking the actual database execution plan.

Common pain points:
1. Context switching to `psql`, pgAdmin, or external web visualizers breaks flow.
2. Developers run `EXPLAIN ANALYZE` without wrapping `UPDATE`/`DELETE` in `ROLLBACK`, accidentally mutating staging or dev data.
3. Database connection strings with passwords end up committed inside `.vscode/settings.json`.
4. Raw `EXPLAIN` output is hard to parse visually — developers miss cumulative vs exclusive node times, `Rows Removed by Filter`, buffer cache misses, or `work_mem` disk spills (`external merge`).

## 2. Product Vision

**QueryAutopsy** brings senior-level PostgreSQL query forensics directly into VS Code:
> *"Select a SQL query, inspect its live execution plan safely in one click, and immediately see which node is scanning 150,000 rows and which index fixes it."*

## 3. Target Personas

1. **Backend Engineer (Node/TS, Go, Python)**: Wants instant feedback on `Seq Scan`, missing indexes, and join strategies without leaving VS Code.
2. **Full-Stack Developer**: Uses raw SQL or query builders and needs plain-English diagnostics + copyable `CREATE INDEX CONCURRENTLY` statements.
3. **Tech Lead / Open-Source Maintainer**: Demands strict security guardrails (`ROLLBACK` isolation, `SecretStorage`, `statement_timeout`) and clean extensibility.

## 4. Explicit Non-Goals (MVP Scope)

To maintain extreme depth and reliability on PostgreSQL, the following are **out of scope** for v0.x:
- Multi-engine support (MySQL, SQLite, SQL Server, Oracle).
- Automatic schema migrations or executing `CREATE INDEX` directly against the database without user action.
- LLM/AI cloud proxy sending user SQL or schema data to third-party APIs (100% local execution against user's configured PostgreSQL instance).

---

## 5. Milestones & Functional Requirements

### Milestone 1: Safe Core & OutputChannel Inspector (Implemented)

| ID | Requirement | Acceptance Criteria |
| :--- | :--- | :--- |
| **M1-F1** | **Secure Connection Management** | Command `queryAutopsy.configureConnection` prompts with masked `InputBox`, tests connection (`SELECT version()`), and stores URI in VS Code `SecretStorage`. `queryAutopsy.clearConnection` removes it. |
| **M1-F2** | **Safe SQL Classification & Guardrails** | Rejects empty input, multi-statement strings, leading `EXPLAIN`, and all `DDL`. Blocks `WRITE` (`INSERT`/`UPDATE`/`DELETE`/`MERGE` & writable CTEs) under `analyze` unless `allowWriteAnalyze` is enabled. |
| **M1-F3** | **Transaction & Timeout Isolation** | `analyze` wraps `READ` queries in `BEGIN READ ONLY` + `SET LOCAL statement_timeout` + `ROLLBACK` in `finally`. `estimate` runs `EXPLAIN (COSTS, VERBOSE, FORMAT JSON)`. |
| **M1-F4** | **Parameterized Queries (`$1..$n`)** | Detects positional parameters outside literals/comments, throws `MissingParametersError`, prompts user for comma-separated or JSON array bindings, and executes via `pg` Extended Query Protocol. |
| **M1-F5** | **Plan Parser & Diagnostic Engine** | Parses Postgres JSON into `PlanNode` tree with exclusive node time/%, cumulative buffer stats (no double counting), and triggers 5 diagnostic rules (`SEQ_SCAN_LARGE_TABLE`, `EXTERNAL_DISK_SPILL`, `PLANNER_ROW_MISESTIMATE`, `LOW_CACHE_HIT_RATIO`, `NESTED_LOOP_HIGH_LOOPS`). |
| **M1-F6** | **Structured OutputChannel Report** | Formats summary, sorted diagnostics with `CREATE INDEX CONCURRENTLY` SQL, indented node tree, and optional raw JSON (`queryAutopsy.output.showRawJson`). |

### Milestone 2: Interactive Visual Webview (Implemented)

| ID | Requirement | Acceptance Criteria |
| :--- | :--- | :--- |
| **M2-F1** | **Webview Presenter Adapter** | Implements `ReportPresenterPort` (or composes with OutputChannel) opening a `vscode.WebviewPanel` (`queryAutopsy.planView`) without modifying `domain/` or `application/`. |
| **M2-F2** | **Interactive Node Tree & Heatmap** | Color-codes nodes by exclusive cost/time percentage (green `< 15%`, amber `15–49%`, red `>= 50%` or critical diagnostic), expandable/collapsible branches. |
| **M2-F3** | **KPI Header & Comparison** | Displays `Execution Time`, `Planning Time`, `Total Cost`, `Shared Hit %`, `Disk Read MB`, and `Temp Spill KB`. |
| **M2-F4** | **Node Detail Drawer & Copyable Index** | Clicking any node shows filter, index cond, loops, estimated vs actual rows, buffers, and a one-click `Copy CREATE INDEX` button communicating via typed `postMessage`. |
| **M2-F5** | **Strict CSP** | Nonce-based `<meta http-equiv="Content-Security-Policy">`, zero remote scripts/CDNs, `enableScripts: true` scoped strictly to extension `dist/webview`. |

### Milestone 3: Editor Automation & CodeLens (Implemented)

| ID | Requirement | Acceptance Criteria |
| :--- | :--- | :--- |
| **M3-F1** | **SQL Block Detection** | Pure domain extractor detects top-level statements in `.sql` files and tagged/raw SQL blocks in `.ts`/`.js` (`sql\`...\``, `pool.query(\`...\`)`). |
| **M3-F2** | **CodeLens Actions** | Renders `▶ Inspect Plan (ANALYZE)` and `◈ Estimate Plan` above detected queries without running automatic DB queries on file open (explicit click only). |
| **M3-F3** | **Editor Diagnostics Integration** | Highlights offending SQL ranges (`vscode.DiagnosticCollection`) after an inspection detects `critical` or `warning` findings, with a `QuickFix` / `CodeAction` to copy the suggested `CREATE INDEX` statement. |

---

## 6. Success Metrics

- Zero unintended data mutations during `EXPLAIN ANALYZE` runs.
- Domain & Application test coverage >= 90% running offline without a live PostgreSQL instance.
- End-to-end inspection latency overhead (extension parsing + diagnostic analysis) < 15 ms outside network/DB query time.
