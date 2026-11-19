# Architecture Decision Records (ADRs)

This directory documents key architectural decisions for **QueryAutopsy** so context, trade-offs, and constraints remain explicit across contributors and AI agents.

| ADR | Title | Status |
| :--- | :--- | :--- |
| [ADR-0001](./0001-hexagonal-architecture-and-manual-di.md) | Hexagonal Architecture and Manual Composition Root | Accepted |
| [ADR-0002](./0002-postgres-only-mvp-and-safe-explain-transaction.md) | PostgreSQL-Only MVP & Transactional EXPLAIN Safety Guardrails | Accepted |
| [ADR-0003](./0003-secret-storage-for-credentials.md) | VS Code SecretStorage as Primary Credential Store | Accepted |
| [ADR-0004](./0004-esbuild-cjs-and-node16-ts-module-resolution.md) | esbuild CommonJS Bundle with Node16 TypeScript & Vitest | Accepted |
| [ADR-0005](./0005-webview-csp-and-typed-message-protocol.md) | Webview Strict CSP & Typed Extension-Webview Bridge (Milestone 2) | Accepted |

## ADR Template

```markdown
# ADR-XXXX: Short Title

- **Status**: Proposed | Accepted | Superseded
- **Date**: YYYY-MM-DD

## Context
## Decision
## Consequences
```
