<p align="center">
  <img src="./resources/icon.png" alt="QueryAutopsy logo" width="96" height="96" />
</p>

<h1 align="center">QueryAutopsy</h1>

<p align="center">
  <strong>X-Ray your PostgreSQL queries inside VS Code.</strong><br/>
  Dissect <code>EXPLAIN (ANALYZE, BUFFERS)</code> execution plans, catch <code>Seq Scan</code> bottlenecks, disk spills, and row estimation mismatches before they hit production.
</p>

<p align="center">
  <a href="https://github.com/marc14444/query-autopsy/actions/workflows/ci.yml"><img src="https://github.com/marc14444/query-autopsy/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/PostgreSQL-14%E2%80%9317%2B-336791.svg" alt="PostgreSQL 14-17+" />
  <img src="https://img.shields.io/badge/architecture-Hexagonal-0ea5e9.svg" alt="Hexagonal Architecture" />
</p>

![QueryAutopsy live execution plan inspection in VS Code](./resources/demo-screenshot.jpg)

---

## Why QueryAutopsy?

Most SQL bottlenecks don't fail in unit tests — they quietly scan 500,000 rows in production. **QueryAutopsy** brings PostgreSQL execution plan forensics directly into VS Code with strict safety guardrails:

- **Zero-Surprise Safety**: `READ` queries executed under `EXPLAIN ANALYZE` run inside `BEGIN READ ONLY` + `SET LOCAL statement_timeout` + unconditional `ROLLBACK`. Write statements (`INSERT`/`UPDATE`/`DELETE`/`MERGE` and writable CTEs) are blocked from `ANALYZE` by default (and rolled back if explicitly enabled). DDL and multi-statement strings are always rejected.
- **Multi-Profile & Read-Only Prod Lock**: Switch between `local`, `staging`, and `production` profiles from the status bar. Locked profiles block `WRITE` `EXPLAIN ANALYZE` and disable direct index creation.
- **Zero-Config `.env` & Docker Discovery**: Auto-detects `DATABASE_URL` / `POSTGRES_URL` in `.env` files and Postgres services in `docker-compose.yml` for instant onboarding (`QueryAutopsy: Auto-Detect Local PostgreSQL`).
- **SecretStorage Credentials**: Connection URIs and passwords are encrypted per profile in VS Code `SecretStorage` — never stored in plain `.vscode/settings.json` or logged.
- **Interactive Execution Plan Webview**: Color-coded execution tree (`HOT` / `WARN` / `OK`), `PARALLEL` worker awareness, KPI cards, buffer cache hit metrics, node inspector drawer, and strict nonce-based CSP.
- **CodeLens & Inline Editor Diagnostics**: Surfaces `▶ Inspect Plan (ANALYZE)` and `◈ Estimate Plan` directly above queries in `.sql` files and TypeScript/JavaScript SQL templates (`sql\`...\``, `Prisma.sql\`...\``, `/* sql */ \`...\``, `.query(\`...\`)`). Highlights bottlenecks in the editor with a one-click QuickFix 💡 to copy `CREATE INDEX CONCURRENTLY`.
- **Parameterized Query Support**: Detects `$1, $2...` placeholders (and converts `${expr}` interpolations in JS/TS SQL templates) and executes safely via the PostgreSQL Extended Query Protocol.

---

## Architecture (Hexagonal / Ports & Adapters)

```text
src/
├── domain/                  # Pure business rules (zero dependency on vscode or pg)
│   ├── errors/              # DomainError hierarchy
│   ├── models/              # PlanNode, ExecutionPlan, DiagnosticFinding, QueryRequest
│   ├── ports/
│   │   ├── inbound/         # InspectQueryUseCase
│   │   └── outbound/        # QueryExecutorPort, ConnectionConfigPort, ReportPresenterPort
│   └── services/            # sqlClassifier, sqlBlockExtractor, planParser, diagnosticEngine
├── application/             # Use-case orchestration (InspectQueryService)
├── infrastructure/          # Driven adapters (pg driver, SecretStorage, OutputChannel, Webview)
├── presentation/            # Driving adapters (Commands, CodeLens, Diagnostics, Composition Root)
├── webview/                 # Browser-bundled interactive UI (strict CSP, VS Code theme tokens)
└── extension.ts             # Minimal VS Code entry point
```

---

## Quick Start (Local Playground)

1. **Install dependencies and build**:
   ```bash
   npm install
   npm run build
   ```

2. **Start the seeded PostgreSQL 16 playground** (`10,000` users + `150,000` orders with intentional missing indexes):
   ```bash
   docker compose -f docker/docker-compose.yml up -d
   ```

3. **Launch the Extension Development Host** in VS Code:
   - Press `F5` (`Fn + F5` on macOS, or **Run and Debug → `Run QueryAutopsy Extension`**).
   - Click **`QueryAutopsy: Connect PG`** in the status bar (or run Command Palette → **`QueryAutopsy: Switch / Configure PostgreSQL Profile`**) and choose **Auto-detect from workspace** (detects `docker/docker-compose.yml` automatically!) or paste:
     ```text
     postgresql://postgres:queryautopsy@localhost:5432/query_autopsy_dev
     ```
   - Open `docker/sample_queries.sql` and click **`▶ Inspect Plan (ANALYZE)`** above any query (or right-click anywhere inside a query).

---

## Development Scripts

```bash
npm run check-types   # Strict TypeScript type-checking (Node host + Webview DOM)
npm run lint          # ESLint (typescript-eslint)
npm run test          # Vitest unit tests (domain, application & webview HTML/presenters)
npm run build         # Bundle extension & webview with esbuild
npm run package:vsix  # Build production VSIX installer
```

---

## Documentation & Engineering Specs

- **[AGENTS.md](./AGENTS.md)** — Architectural boundaries, safety invariants, and contributor/agent rules
- **[PRD-001](./docs/prd/PRD-001-query-autopsy-mvp.md)** — Product Requirements across Milestones 1–3
- **[Master Roadmap (v0.2 → v1.0)](./docs/roadmap/ROADMAP-V0.2-TO-V1.0.md)** — Multi-IDE release, advanced PostgreSQL diagnostics, and multi-engine plan
- **[Hexagonal Architecture](./docs/architecture/HEXAGONAL-ARCHITECTURE.md)** — Ports & Adapters blueprint
- **[ADRs](./docs/adr/README.md)** — Architecture Decision Records (`0001`–`0005`)
- **[Technical Specifications](./docs/specs/TECH-SPEC-01-sql-classifier-and-pg-executor.md)** — Classifier, Executor, Parser, Diagnostics, and Webview/CodeLens specs
- **[CONTRIBUTING.md](./CONTRIBUTING.md)** — Contributor guide & PR checklist

## Roadmap

- [x] **Milestone 1**: Hexagonal core, safe `pg` EXPLAIN runner, diagnostic engine, VS Code SecretStorage & OutputChannel report.
- [x] **Milestone 2**: Interactive Webview execution tree, KPI strip, node inspector, and copyable index suggestions ([TECH-SPEC-03](./docs/specs/TECH-SPEC-03-webview-and-codelens-roadmap.md)).
- [x] **Milestone 3**: CodeLens & inline diagnostics on `.sql` files and TypeScript/JavaScript SQL templates with QuickFix index copy ([TECH-SPEC-03](./docs/specs/TECH-SPEC-03-webview-and-codelens-roadmap.md)).

## License

[MIT](./LICENSE)
