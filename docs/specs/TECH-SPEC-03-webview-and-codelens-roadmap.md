# TECH-SPEC-03: Milestones 2 & 3 Blueprint (Webview & Editor Automation)

This spec locks down the contracts for **Milestone 2 (Webview)** and **Milestone 3 (CodeLens & Diagnostics)** so any contributor or agent can implement them without architectural drift.

---

## Milestone 2: Interactive Visual Webview (Implemented)

### 1. Hexagonal Integration
- Implemented `WebviewReportPresenter` in `src/infrastructure/vscode/webview/webviewReportPresenter.ts` (`ReportPresenterPort`).
- Implemented `CompositeReportPresenter` in `src/infrastructure/vscode/compositeReportPresenter.ts` to update both Webview and OutputChannel cleanly (`revealOnPresent: false` on OutputChannel when paired with Webview).
- Zero changes to `src/domain/` or `src/application/`.

### 2. Typed Message Protocol (`src/infrastructure/vscode/webview/contracts.ts`)

```ts
export type ExtensionToWebviewMessage = {
  readonly type: 'RENDER_REPORT';
  readonly payload: InspectionReport;
};

export type WebviewToExtensionMessage =
  | { readonly type: 'READY' }
  | { readonly type: 'COPY_SQL'; readonly payload: { readonly sql: string } }
  | {
      readonly type: 'RERUN_QUERY';
      readonly payload: { readonly sql: string; readonly mode: ExplainMode };
    };
```

### 3. Build & Packaging (`esbuild.config.mjs` + `tsconfig.webview.json`)
- Browser-targeted `esbuild` context compiles `src/webview/main.ts` and `src/webview/styles.css` -> `dist/webview/main.js` and `dist/webview/styles.css` (`format: 'iife'`).
- Dedicated `tsconfig.webview.json` checks browser DOM code separately from Node host code.
- `webviewOptions`:
  - `enableScripts: true`
  - `localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'webview')]`
  - `retainContextWhenHidden: true` + `READY` handshake re-syncing cached `InspectionReport`.

### 4. UI Visual Specification
- **Theme Integration**: Use VS Code CSS variables (`--vscode-editor-background`, `--vscode-editor-foreground`, `--vscode-testing-iconPassed`, `--vscode-testing-iconFailed`, `--vscode-editorWarning-foreground`) so dark/light/high-contrast themes work natively.
- **Node Severity Coloring**:
  - Red badge (`HOT`): node has `critical` diagnostic OR (`exclusiveTimePercent >= 50` AND `exclusiveTimeMs >= 5`)
  - Amber badge (`WARN`): node has `warning` diagnostic OR (`exclusiveTimePercent >= 25` AND `exclusiveTimeMs >= 2`)
  - Green badge (`OK`): healthy / sub-millisecond fast node
- **Strict CSP**: Enforce ADR-0005 nonce-based policy; never use `innerHTML` with unescaped SQL/filter strings.

---

## Milestone 3: CodeLens & Inline SQL Diagnostics (Implemented)

### 1. Pure Domain SQL Block Extractor (`src/domain/services/sqlBlockExtractor.ts`)
Implemented pure function:
```ts
export interface DetectedSqlBlock {
  readonly sql: string;
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
  readonly sourceKind: 'sql-file' | 'ts-tagged-template';
}

export function extractSqlBlocks(
  text: string,
  languageId: string,
  fileName?: string,
): readonly DetectedSqlBlock[];
```
- For `.sql` / `sql` / `postgres` / `pgsql` / `mssql`: uses shared `extractSqlStatementSpans` from `sqlClassifier.ts`, filtering to inspectable `READ`/`WRITE` queries (`DDL` skipped).
- For `typescript` / `javascript` / TSX / JSX: matches tagged templates (`sql\`...\``, `Prisma.sql\`...\``), `/* sql */ \`...\`` comments, `.query(\`...\`)` / `.execute(\`...\`)` / `.raw(\`...\`)` calls, and valid standalone SQL template literals, substituting `${...}` interpolations with `$1..$n`.

### 2. Presentation CodeLens (`src/presentation/vscode/codelens/sqlCodeLensProvider.ts`)
- Registered via `vscode.languages.registerCodeLensProvider` for SQL, PostgreSQL, MSSQL, TypeScript, and JavaScript (guarded by `queryAutopsy.codeLens.enabled`).
- Emits `$(play) Inspect Plan (ANALYZE)` and `$(eye) Estimate Plan` above each `DetectedSqlBlock` without executing DB queries on open/edit.

### 3. Inline Editor Diagnostics (`src/presentation/vscode/diagnostics/editorDiagnosticsManager.ts`)
- Manages `vscode.DiagnosticCollection` (`'queryAutopsy'`) mapping `critical` -> `Error`, `warning` -> `Warning`, `info` -> `Information` on the inspected query range (clearing automatically when a re-run passes cleanly).
- Provides `vscode.CodeActionProvider` (`QuickFix`) to copy the suggested `CREATE INDEX CONCURRENTLY` statement (`queryAutopsy.copySuggestedIndex`).
