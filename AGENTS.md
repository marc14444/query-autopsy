# AGENTS.md — QueryAutopsy Project Constitution

This file defines mandatory architectural boundaries, safety invariants, and workflow rules for all AI agents and human contributors working in `/Users/yaman/extension-project` (**QueryAutopsy** — VS Code PostgreSQL `EXPLAIN` & Performance Inspector).

## 1. Architecture Boundaries (Hexagonal / Ports & Adapters)

Strict inward dependency rule — **NO EXCEPTIONS**:

| Layer | Directory | Allowed Dependencies | Forbidden Dependencies |
| :--- | :--- | :--- | :--- |
| **Domain** | `src/domain/` | `src/domain/` only | `vscode`, `pg`, `node:fs`, `application/`, `infrastructure/`, `presentation/` |
| **Application** | `src/application/` | `src/domain/` only | `vscode`, `pg`, `infrastructure/`, `presentation/` |
| **Infrastructure** | `src/infrastructure/` | `src/domain/` (models, errors, outbound ports), `pg`, `vscode`, Node stdlib | `presentation/`, `application/` |
| **Presentation** | `src/presentation/` | `src/domain/` (inbound ports, errors, models), `vscode`, `container.ts` wires `application/` + `infrastructure/` | Direct SQL queries or `pg` imports outside `container.ts` |
| **Entrypoint** | `src/extension.ts` | `src/presentation/vscode/container.ts`, `vscode` types | Business logic or direct adapter instantiation |

- **Dependency Injection**: Manual explicit wiring in `src/presentation/vscode/container.ts` (Composition Root). Do NOT introduce reflection-based DI containers (`inversify`, `tsyringe`).
- **New Features Rule**:
  - Adding a Webview UI (Milestone 2) MUST implement `ReportPresenterPort` without modifying `src/domain/` or `src/application/`.
  - Adding CodeLens / inline diagnostics (Milestone 3) MUST live in `src/presentation/vscode/` and invoke `InspectQueryUseCase` (pure SQL block extraction helpers belong in `src/domain/services/`).

## 2. Non-Negotiable Safety & Security Invariants

1. **EXPLAIN ANALYZE Execution Safety**:
   - Every `EXPLAIN ANALYZE` execution MUST run inside an explicit PostgreSQL transaction (`BEGIN READ ONLY` for `READ` queries, `BEGIN` for permitted `WRITE` queries), apply `SET LOCAL statement_timeout = <int>`, and ALWAYS execute `ROLLBACK` in `finally`.
   - `DDL` (`CREATE`, `ALTER`, `DROP`, `TRUNCATE`, `GRANT`, `REVOKE`, `VACUUM`, `COPY`, etc.) MUST ALWAYS be rejected before touching PostgreSQL.
   - Multi-statement selections (`SELECT 1; DROP TABLE ...`) MUST ALWAYS throw `MultipleStatementsError`.
   - `WRITE` statements (`INSERT`, `UPDATE`, `DELETE`, `MERGE`, and `WITH` CTEs containing them) MUST be rejected under `mode: 'analyze'` unless `queryAutopsy.postgres.allowWriteAnalyze === true`.
2. **Credentials & Secret Handling**:
   - Connection URIs and passwords MUST be stored in VS Code `SecretStorage` (`context.secrets`), never written to workspace files or logged.
   - Never log raw connection strings, passwords, or bound parameter values in `LoggerPort`.
3. **PostgreSQL Plan Math Invariants**:
   - `Actual Total Time` in PostgreSQL JSON is cumulative and per-loop: `inclusiveTimeMs = actualTotalTimeMs * actualLoops`. Clamp `exclusiveTimeMs = Math.max(0, inclusiveTimeMs - childrenInclusiveSum)` to handle parallel worker overlap (`Gather` / `Gather Merge`).
   - Buffer counters (`Shared Hit Blocks`, `Shared Read Blocks`, `Temp Written Blocks`) in PostgreSQL JSON are **cumulative across subtrees**. Never sum all nodes for plan totals; subtract child buffers when diagnosing node-exclusive I/O or disk spills.

## 3. TypeScript & Code Quality Standards

- `tsconfig.json` enforces `strict: true`, `exactOptionalPropertyTypes: true`, `noUncheckedIndexedAccess: true`, `module: "Node16"`.
- Always include `.js` extensions on relative TypeScript imports (`import { ... } from './foo.js'`).
- Keep `src/domain/` and `src/application/` 100% unit-testable in Node via `vitest` with zero VS Code or live PostgreSQL dependencies.
- Never duplicate logic; handle driver errors cleanly via `mapPostgresError` -> `QueryExecutionError`.

## 4. Documentation & Context Map

Read the relevant specification before modifying or extending any subsystem:
- **PRD & Milestones**: `docs/prd/PRD-001-query-autopsy-mvp.md`
- **Master Roadmap (`v0.2` → `v1.0`)**: `docs/roadmap/ROADMAP-V0.2-TO-V1.0.md`
- **Hexagonal Blueprint**: `docs/architecture/HEXAGONAL-ARCHITECTURE.md`
- **ADRs**: `docs/adr/README.md` (`0001` through `0005`)
- **Technical Specs**:
  - `docs/specs/TECH-SPEC-01-sql-classifier-and-pg-executor.md`
  - `docs/specs/TECH-SPEC-02-explain-parser-and-diagnostics.md`
  - `docs/specs/TECH-SPEC-03-webview-and-codelens-roadmap.md`
- **Project Skills** (`.agents/skills/`):
  - `query-autopsy-add-diagnostic-rule`
  - `query-autopsy-milestone-2-webview`
  - `query-autopsy-pg-playground`

## 5. Mandatory Verification Before Completion

After any code change, run and verify:
```bash
npm run check-types && npm run lint && npm run test && npm run build
```
