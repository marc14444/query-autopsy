# ADR-0001: Hexagonal Architecture and Manual Composition Root

- **Status**: Accepted
- **Date**: 2026-11-19

## Context

VS Code extensions frequently couple UI commands (`vscode.*`), database drivers (`pg`), and business logic inside `extension.ts`. This makes unit testing impossible without launching an Electron Extension Host and turns adding a Webview or CodeLens into a major rewrite.

Because QueryAutopsy is designed as an open-source project with multiple upcoming presentation modes (OutputChannel -> Webview -> CodeLens), the core parsing, SQL classification, and diagnostic rules must remain isolated and independently verifiable.

## Decision

1. Structure `src/` strictly into **Hexagonal Layers**:
   - `domain/` (models, errors, inbound/outbound ports, pure services)
   - `application/` (use case orchestration)
   - `infrastructure/` (driven adapters for `pg` and VS Code APIs)
   - `presentation/` (driving adapters for VS Code commands, future CodeLens, and `container.ts`)
2. Wire dependencies via a **manual Composition Root** (`src/presentation/vscode/container.ts`) using constructor injection rather than runtime reflection DI frameworks (`tsyringe`, `inversify`, `reflect-metadata`).

## Consequences

- **Positive**:
  - `domain/` and `application/` test cleanly in milliseconds via `vitest` with zero mocks of the `vscode` runtime.
  - Adding Webview output (Milestone 2) only requires implementing `ReportPresenterPort`.
  - Zero decorator/reflection overhead and smaller `esbuild` bundle size.
- **Negative / Trade-offs**:
  - Slightly more upfront files/interfaces than a single-file script.
  - Contributors must respect the inward dependency rule enforced in `AGENTS.md`.
