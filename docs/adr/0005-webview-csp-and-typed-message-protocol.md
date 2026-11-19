# ADR-0005: Webview Strict CSP & Typed Extension-Webview Bridge (Milestone 2)

- **Status**: Accepted (Milestone 2 Implemented)
- **Date**: 2026-11-19

## Context

Milestone 2 introduces an interactive execution plan visualizer inside a `vscode.WebviewPanel`. Poorly secured VS Code Webviews are vulnerable to XSS via SQL filter strings, table names, or unsafe remote scripts. Additionally, untyped `webview.postMessage` payloads quickly rot as UI and domain models evolve.

## Decision

When implementing Milestone 2:
1. **Adapter Isolation**: Implement `WebviewReportPresenter` in `src/infrastructure/vscode/webview/` implementing `ReportPresenterPort`. Reuse the existing `InspectionReport` domain model without embedding business/diagnostic logic in the Webview UI.
2. **Strict Content Security Policy (CSP)**:
   - Generate a per-render cryptographic `nonce` (`crypto.randomBytes(16).toString('hex')`).
   - Enforce:
     `default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource}; object-src 'none'; base-uri 'none'; form-action 'none';`
   - Set `localResourceRoots` strictly to `[vscode.Uri.joinPath(extensionUri, 'dist', 'webview')]`.
   - Zero external CDNs, zero `'unsafe-inline'`, zero `'unsafe-eval'`.
3. **Safe DOM Construction**: Render dynamic SQL/plan strings exclusively via `document.createElement`, `.textContent`, and `.replaceChildren()` (no raw `innerHTML` string interpolation).
4. **Typed Bidirectional Message Protocol**: Define discriminated union types `ExtensionToWebviewMessage` and `WebviewToExtensionMessage` in `src/infrastructure/vscode/webview/contracts.ts`.

## Consequences

- **Positive**:
  - Eliminates XSS vectors even when inspecting untrusted/malicious SQL strings or database object names.
  - Clean separation allows swapping or iterating on the Webview UI framework independently.
- **Negative / Trade-offs**:
  - Requires separate `esbuild` entry point (or clean vanilla/Preact/React build target) outputting into `dist/webview/`.
