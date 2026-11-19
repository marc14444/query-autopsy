---
name: query-autopsy-milestone-2-webview
description: >-
  Use this skill when implementing or updating the Milestone 2 interactive
  Webview panel for QueryAutopsy execution plans.
---

# Implement Milestone 2 Interactive Webview

Use this runbook to add the visual execution plan tree without violating Hexagonal Architecture or VS Code Webview security rules.

## Prerequisites

- Read [ADR-0005](../../../docs/adr/0005-webview-csp-and-typed-message-protocol.md).
- Read [TECH-SPEC-03](../../../docs/specs/TECH-SPEC-03-webview-and-codelens-roadmap.md).
- Also follow the `modern-web-guidance` skill for HTML/CSS/DOM best practices inside the Webview.

## Steps

1. **Define Typed Bridge Contracts** in `src/infrastructure/vscode/webview/contracts.ts`:
   - Use discriminated unions for `ExtensionToWebviewMessage` and `WebviewToExtensionMessage`.
2. **Implement Presenter Adapter** in `src/infrastructure/vscode/webview/webviewReportPresenter.ts`:
   - Implement `ReportPresenterPort` (`present(report: InspectionReport): Promise<void>`).
   - Generate a fresh per-render cryptographic `nonce` and enforce the ADR-0005 Content Security Policy (using `webviewHtml.ts`).
   - Restrict `localResourceRoots` to `dist/webview`.
   - Wire `WebviewReportPresenter` and `CompositeReportPresenter` in `src/presentation/vscode/container.ts`. Do NOT touch `src/domain/` or `src/application/`.
3. **Build Webview UI** under `src/webview/`:
   - Use VS Code CSS theme variables (`--vscode-editor-background`, `--vscode-editor-foreground`, etc.).
   - Render text safely via `textContent` or safe framework escaping — NEVER inject unescaped SQL or filter text into `innerHTML`.
4. **Update `esbuild.config.mjs`**:
   - Add a browser-targeted build entry outputting `dist/webview/main.js` (and CSS if applicable).
5. **Verify**:
   ```bash
   npm run check-types && npm run lint && npm run test && npm run build
   ```
   Then press `F5` in VS Code and inspect queries from `docker/sample_queries.sql`.
