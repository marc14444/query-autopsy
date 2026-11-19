export interface WebviewHtmlParams {
  readonly cspSource: string;
  readonly nonce: string;
  readonly scriptUri: string;
  readonly styleUri: string;
}

export function buildWebviewHtml(params: WebviewHtmlParams): string {
  const csp = [
    "default-src 'none'",
    `style-src ${params.cspSource}`,
    `script-src 'nonce-${params.nonce}'`,
    `img-src ${params.cspSource} data:`,
    `font-src ${params.cspSource}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>QueryAutopsy Execution Plan</title>
  <link rel="stylesheet" href="${params.styleUri}">
</head>
<body>
  <header class="topbar">
    <div class="brand-group">
      <h1>QueryAutopsy</h1>
      <div id="report-meta" class="meta-pills"></div>
    </div>
    <div class="toolbar-actions" role="toolbar" aria-label="Execution plan actions">
      <button type="button" id="btn-rerun-analyze" class="btn-primary">Re-run ANALYZE</button>
      <button type="button" id="btn-rerun-estimate" class="btn-secondary">Estimate Only</button>
      <button type="button" id="btn-copy-markdown" class="btn-secondary">Copy PR Report (MD)</button>
      <button type="button" id="btn-expand-all" class="btn-secondary">Expand All</button>
      <button type="button" id="btn-collapse-all" class="btn-secondary">Collapse All</button>
    </div>
  </header>

  <main id="app-main">
    <section id="empty-state" class="empty-state">
      <p>Waiting for PostgreSQL execution plan...</p>
    </section>

    <div id="report-root" hidden>
      <section aria-label="Execution summary" id="kpi-strip" class="kpi-strip"></section>

      <section aria-labelledby="comparison-heading" id="comparison-section" class="comparison-section" hidden>
        <div class="section-header">
          <h2 id="comparison-heading">Before / After Comparison</h2>
          <div class="baseline-picker">
            <label for="baseline-select">Compare against:</label>
            <select id="baseline-select"></select>
          </div>
        </div>
        <div id="comparison-grid" class="comparison-grid"></div>
      </section>

      <details class="sql-disclosure">
        <summary>Inspected SQL Statement</summary>
        <div class="sql-disclosure-body">
          <pre role="region" aria-label="Inspected SQL statement" tabindex="0"><code id="inspected-sql"></code></pre>
        </div>
      </details>

      <section aria-labelledby="diagnostics-heading" class="diagnostics-section">
        <div class="section-header">
          <h2 id="diagnostics-heading">Diagnostics</h2>
        </div>
        <div id="diagnostics-list" class="diagnostics-list"></div>
      </section>

      <div class="workspace-grid">
        <section aria-labelledby="tree-heading" class="tree-panel">
          <div class="section-header">
            <h2 id="tree-heading">Execution Plan Tree</h2>
            <div class="filter-toggle" role="group" aria-label="Node visibility filter">
              <button type="button" id="btn-filter-all" class="filter-btn active" aria-pressed="true">All Nodes</button>
              <button type="button" id="btn-filter-issues" class="filter-btn" aria-pressed="false">Bottlenecks Only</button>
            </div>
          </div>
          <ul id="plan-tree" class="plan-tree" aria-label="PostgreSQL execution nodes"></ul>
        </section>

        <aside aria-labelledby="inspector-heading" class="inspector-panel">
          <h2 id="inspector-heading">Node Inspector</h2>
          <div id="node-inspector" class="node-inspector"></div>
        </aside>
      </div>
    </div>

    <div id="status-announcer" class="visually-hidden" aria-live="polite" aria-atomic="true"></div>
  </main>

  <script nonce="${params.nonce}" src="${params.scriptUri}"></script>
</body>
</html>`;
}
