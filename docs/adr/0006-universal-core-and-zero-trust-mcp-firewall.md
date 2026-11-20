# ADR-0006: Universal Multi-Language Core, Trace Contract & Zero-Trust MCP Firewall

- **Status**: Proposed
- **Date**: 2026-11-20
- **Related Roadmap**: [`ROADMAP-V1.1-TO-V2.0.md`](../roadmap/ROADMAP-V1.1-TO-V2.0.md)

## Context

QueryAutopsy started as a VS Code / Open VSX extension (`v0.1.0` → `v1.0.2`) built with strict Hexagonal Architecture (`src/domain/` and `src/application/` free of `vscode` and database driver dependencies).

To expand adoption safely across non-JS ecosystems (Laravel/PHP, Python, Go), CI pipelines, npm programmatic usage, and AI coding agents ("vibe-coding" via MCP), three architectural questions must be decided cleanly:
1. Should diagnostic logic be re-implemented per language (e.g., native PHP for Laravel)?
2. How should AI coding agents inspect query performance without gaining dangerous database access?
3. Should MCP run over an external HTTP/SSE tunnel or locally over `stdio`?

## Decision

1. **Single Universal Core (`@query-autopsy/core`) + Universal JSONL Trace Contract**:
   - Extract `src/domain/` and `src/application/` into a zero-runtime-dependency npm package (`@query-autopsy/core`), paired with `@query-autopsy/executors` and `@query-autopsy/cli`.
   - Other ecosystems (starting with Laravel via a thin `--dev` Composer bridge) do **not** duplicate SQL parsing, plan math, or diagnostics; they emit a standardized `.query-autopsy/traces.jsonl` stream or invoke `@query-autopsy/cli` / `@query-autopsy/mcp`.

2. **Local `stdio` MCP Only (Zero Network Tunnel Exposure)**:
   - Expose AI agent capabilities via `@query-autopsy/mcp` over local `stdio` transport rather than an HTTP/SSE network tunnel.
   - No open TCP ports, no SSRF surface, and credentials stay local to the developer environment.

3. **Zero-Trust Bounded MCP Surface ("AI-to-DB Firewall")**:
   - **No raw SQL execution tool**: MCP exposes only bounded diagnostic tools (`autopsy_explain`, `autopsy_simulate_index`, `autopsy_list_slow_queries`, and later `autopsy_analyze_traces`).
   - **Estimate-first default**: `autopsy_explain` defaults to `mode: 'estimate'` (`EXPLAIN` without executing query logic). `analyze` requires explicit opt-in and remains blocked on `production` profiles.
   - **No schema mutation via AI**: `ApplyIndexService` and `allowWriteAnalyze` are strictly excluded from MCP; index creation remains a human-confirmed action inside the IDE.
   - **Defense-in-Depth Hardening**:
     - Support VS Code Workspace Trust (`untrustedWorkspaces`) to block untrusted `.env` discovery and outbound DB connections.
     - Enforce `BEGIN READ ONLY` + `SET LOCAL statement_timeout` + `ROLLBACK` on `simulateHypotheticalIndex` as well as `executeExplain`.
     - Strip SQL comments, redact literal values (`redactSqlLiterals`), sanitize error payloads against cast-error data exfiltration (`sanitizeSqlError`), enforce safe function allowlists on `CREATE INDEX`, and reject plaintext passwords in `fallbackConnectionString`.

## Consequences

- **Positive**:
  - Zero divergence in SQL rules or PostgreSQL/MySQL/SQLite plan math across VS Code, CLI/CI, Laravel/Python/Go, and AI agents.
  - Strong competitive differentiation for vibe-coding workflows: AI agents can verify queries and HypoPG indexes autonomously while remaining isolated from raw rows, PII literals, and destructive DDL/DML.
  - Clean incremental rollout across separate PR branches (`v1.1.0` security hardening → `v1.2.0` monorepo/CLI → `v1.3.0` MCP → `v1.4.0`/`v1.5.0` trace contract & Laravel bridge) without risking regressions in `v1.0.x`.
- **Negative / Trade-offs**:
  - Monorepo workspaces (`packages/*` + `apps/vscode-extension`) require keeping esbuild `.vsix` bundling aligned with npm workspace resolution.
  - Framework bridges (e.g., Laravel Composer package) require Node.js (or a future standalone compiled CLI binary) available in the dev/CI environment alongside PHP.
