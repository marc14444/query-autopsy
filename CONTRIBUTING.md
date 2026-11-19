# Contributing to QueryAutopsy

Thank you for contributing to **QueryAutopsy**!

## Engineering Principles

QueryAutopsy follows strict **Hexagonal Architecture (Ports & Adapters)**. Before writing code, please read:

1. [AGENTS.md](./AGENTS.md) — Architectural rules, safety invariants, and TypeScript conventions.
2. [Hexagonal Architecture](./docs/architecture/HEXAGONAL-ARCHITECTURE.md) — Layer boundaries and dependency flow.
3. [ADRs](./docs/adr/README.md) — Core architectural decisions.

## Git Branching & Pull Request Workflow

Direct commits/pushes to `main` are forbidden. Every change must go through a dedicated branch and Pull Request against `main`:

- **Required branch naming convention** (enforced by GitHub Actions CI):
  - `feat/<short-kebab-description>` — new features (`feat/v0.4.0-multi-engine`)
  - `fix/<short-kebab-description>` — bug fixes (`fix/docker-auth-guided-setup`)
  - `chore/<short-kebab-description>` — maintenance/dependency updates
  - `docs/<short-kebab-description>` — documentation / ADR updates
  - `refactor/<short-kebab-description>` — internal refactoring without behavior changes
  - `test/<short-kebab-description>` — test additions/improvements
  - `ci/<short-kebab-description>` — GitHub Actions & build pipeline changes
  - `perf/<short-kebab-description>` — performance improvements
  - `hotfix/<short-kebab-description>` — urgent production patches

### Versioning & Automatic Releases

Do **not** push release tags manually. When a maintainer reviews and merges a PR into `main`:
- If `package.json` `"version"` was bumped (and `CHANGELOG.md` updated) and tag `v<version>` does not exist yet, `.github/workflows/release.yml` automatically creates tag `v<version>`, attaches the `.vsix` to a GitHub Release, and publishes to Open VSX / Marketplace.
- If `package.json` `"version"` was not bumped (e.g. docs/CI PR), CI runs without creating a release.

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

Then press `F5` in VS Code / Antigravity to launch the Extension Development Host and test queries in `docker/sample_queries.sql`.

## Pull Request Checklist

- [ ] Branch follows `<type>/<kebab-case-slug>` naming convention (`feat/...`, `fix/...`, etc.).
- [ ] `src/domain/` and `src/application/` contain zero imports from `vscode`, `pg`, `mysql2`, `sql.js`, `infrastructure/`, or `presentation/`.
- [ ] New diagnostic rules or SQL parser rules include comprehensive Vitest unit tests under `tests/`.
- [ ] Relative TypeScript imports use `.js` extensions (`Node16` resolution).
- [ ] `npm run check-types`, `npm run lint`, `npm run test`, and `npm run build` all pass with zero warnings/errors.
- [ ] `package.json` and `CHANGELOG.md` are updated if this PR should trigger an automatic release upon merge to `main`.
