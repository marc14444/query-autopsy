# Contributing to QueryAutopsy

Thank you for contributing to **QueryAutopsy**!

## Engineering Principles

QueryAutopsy follows strict **Hexagonal Architecture (Ports & Adapters)**. Before writing code, please read:

1. [AGENTS.md](./AGENTS.md) — Architectural rules, safety invariants, and TypeScript conventions.
2. [Hexagonal Architecture](./docs/architecture/HEXAGONAL-ARCHITECTURE.md) — Layer boundaries and dependency flow.
3. [ADRs](./docs/adr/README.md) — Core architectural decisions.

## Local Setup

```bash
# 1. Install dependencies
npm install

# 2. Run unit tests (no Docker/Postgres required)
npm test

# 3. Typecheck, lint, and bundle
npm run check-types && npm run lint && npm run build
```

### Testing Against Live PostgreSQL 16

```bash
docker compose -f docker/docker-compose.yml up -d
```

Then press `F5` in VS Code to launch the Extension Development Host and test queries in `docker/sample_queries.sql`.

## Pull Request Checklist

- [ ] `src/domain/` and `src/application/` contain zero imports from `vscode` or `pg`.
- [ ] New diagnostic rules or SQL parser rules include comprehensive Vitest unit tests under `tests/`.
- [ ] Relative TypeScript imports use `.js` extensions (`Node16` resolution).
- [ ] `npm run check-types`, `npm run lint`, `npm run test`, and `npm run build` all pass with zero warnings/errors.
- [ ] Relevant ADRs / Tech Specs are updated if contracts or rules changed.
