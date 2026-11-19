# ADR-0004: esbuild CommonJS Bundle with Node16 TypeScript & Vitest

- **Status**: Accepted
- **Date**: 2026-11-19

## Context

VS Code's Extension Host executes extensions in a Node.js CommonJS runtime where `vscode` is an ambient host-provided module. At the same time, modern TypeScript tooling (`vitest`, `eslint` v9) favors clean ESM config files and strict TypeScript module resolution. Additionally, `pg` contains an optional native binding check (`require('pg-native')`) that fails bundling if not marked external.

## Decision

1. Bundle `src/extension.ts` to `dist/extension.js` (`format: 'cjs'`, `platform: 'node'`, `target: 'node20'`) using `esbuild` (`esbuild.config.mjs`).
2. Mark both `'vscode'` and `'pg-native'` as `external` in `esbuild` so pure-JS `pg` bundles cleanly without native C++ build requirements.
3. Configure `tsconfig.json` with `"module": "Node16"`, `"moduleResolution": "Node16"`, `"strict": true`, `"exactOptionalPropertyTypes": true`, and `"noUncheckedIndexedAccess": true`, using `.js` extensions on relative imports across `src/` and `tests/`.
4. Use `vitest` for fast unit testing of `src/domain/` and `src/application/`.

## Consequences

- **Positive**:
  - Sub-second builds and tiny VSIX package footprint (no `node_modules` shipped inside `.vsix`).
  - Zero native compilation friction across macOS/Linux/Windows.
  - Strict compiler checks catch undefined index access and optional property bugs at compile time.
- **Negative / Trade-offs**:
  - Contributors must remember `.js` extensions in TypeScript relative import paths (standard `Node16` convention).
