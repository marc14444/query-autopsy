import type {
  DiagnosticFinding,
  DiagnosticSeverity,
  InspectionReport,
  PlanComparisonSummary,
  PlanNode,
  SimulateIndexResult,
} from '@query-autopsy/core';
import type {
  ExtensionToWebviewMessage,
  WebviewRenderPayload,
  WebviewToExtensionMessage,
} from '../infrastructure/vscode/webview/contracts.js';

interface VsCodeApi {
  postMessage(message: WebviewToExtensionMessage): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

interface WebviewState {
  selectedNodeId: string | null;
  issuesOnly: boolean;
  collapsedNodeIds: string[];
}

const vscodeApi = acquireVsCodeApi();

let currentPayload: WebviewRenderPayload | null = null;
let selectedNodeId: string | null = null;
let issuesOnly = false;
const collapsedNodeIds = new Set<string>();
const simulationResultsByIndexSql = new Map<string, SimulateIndexResult>();

function getEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Missing required element #${id}`);
  }
  return el as T;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function announceStatus(message: string): void {
  const announcer = getEl<HTMLDivElement>('status-announcer');
  announcer.textContent = '';
  requestAnimationFrame(() => {
    announcer.textContent = message;
  });
}

function saveUiState(): void {
  vscodeApi.setState<WebviewState>({
    selectedNodeId,
    issuesOnly,
    collapsedNodeIds: Array.from(collapsedNodeIds),
  });
}

function restoreUiState(): void {
  const saved = vscodeApi.getState<WebviewState>();
  if (!saved) {
    return;
  }
  selectedNodeId = saved.selectedNodeId;
  issuesOnly = saved.issuesOnly;
  collapsedNodeIds.clear();
  for (const id of saved.collapsedNodeIds) {
    collapsedNodeIds.add(id);
  }
}

function indexDiagnosticsByNode(
  diagnostics: readonly DiagnosticFinding[],
): Map<string, DiagnosticFinding[]> {
  const map = new Map<string, DiagnosticFinding[]>();
  for (const item of diagnostics) {
    const existing = map.get(item.nodeId);
    if (existing) {
      existing.push(item);
    } else {
      map.set(item.nodeId, [item]);
    }
  }
  return map;
}

function flattenNodes(root: PlanNode): Map<string, PlanNode> {
  const map = new Map<string, PlanNode>();
  const visit = (node: PlanNode): void => {
    map.set(node.id, node);
    for (const child of node.children) {
      visit(child);
    }
  };
  visit(root);
  return map;
}

function getNodeHealthLevel(
  node: PlanNode,
  nodeDiagnostics: readonly DiagnosticFinding[],
): 'critical' | 'warning' | 'healthy' {
  const selfMs = node.exclusiveTimeMs ?? 0;
  const selfPct = node.exclusiveTimePercent ?? 0;

  if (
    nodeDiagnostics.some((d) => d.severity === 'critical') ||
    (selfPct >= 50 && selfMs >= 5)
  ) {
    return 'critical';
  }
  if (
    nodeDiagnostics.some((d) => d.severity === 'warning') ||
    (selfPct >= 25 && selfMs >= 2)
  ) {
    return 'warning';
  }
  return 'healthy';
}

function subtreeHasIssue(
  node: PlanNode,
  diagMap: Map<string, DiagnosticFinding[]>,
): boolean {
  const ownDiags = diagMap.get(node.id) ?? [];
  if (getNodeHealthLevel(node, ownDiags) !== 'healthy') {
    return true;
  }
  return node.children.some((child) => subtreeHasIssue(child, diagMap));
}

function formatReportEngineLabel(report: InspectionReport): string {
  switch (report.engine) {
    case 'mysql':
      return 'MySQL';
    case 'sqlite':
      return 'SQLite';
    case 'duckdb':
      return 'DuckDB';
    default:
      return 'PostgreSQL';
  }
}

function renderMeta(report: InspectionReport): void {
  const metaContainer = getEl<HTMLDivElement>('report-meta');
  const enginePill = el(
    'span',
    'pill pill-neutral',
    formatReportEngineLabel(report),
  );
  const modePill = el(
    'span',
    `pill ${report.mode === 'analyze' ? 'pill-accent' : 'pill-neutral'}`,
    report.mode === 'analyze' ? 'EXPLAIN ANALYZE' : 'ESTIMATE ONLY',
  );
  const kindPill = el('span', 'pill pill-neutral', report.statementKind);
  const pills: HTMLElement[] = [enginePill, modePill, kindPill];

  if (report.profileName) {
    const profilePill = el(
      'span',
      `pill ${report.readOnlyLocked ? 'pill-warn' : 'pill-neutral'}`,
      report.readOnlyLocked ? `${report.profileName} [RO]` : report.profileName,
    );
    pills.push(profilePill);
  }

  const timeStr = new Date(report.inspectedAtIso).toLocaleTimeString();
  pills.push(el('span', 'pill pill-muted', timeStr));
  metaContainer.replaceChildren(...pills);
}

function createKpiCard(
  label: string,
  value: string,
  subtext: string,
  tone: 'default' | 'good' | 'warn' | 'bad' = 'default',
): HTMLElement {
  const card = el('article', `kpi-card tone-${tone}`);
  const dt = el('div', 'kpi-label', label);
  const dd = el('div', 'kpi-value', value);
  const sub = el('div', 'kpi-sub', subtext);
  card.append(dt, dd, sub);
  return card;
}

function renderKpiStrip(report: InspectionReport): void {
  const { plan, mode } = report;
  const { totalBuffers } = plan;

  const execValue =
    plan.executionTimeMs !== undefined
      ? `${plan.executionTimeMs.toFixed(2)} ms`
      : 'N/A';
  const execSub =
    mode === 'analyze'
      ? `Planning: ${plan.planningTimeMs?.toFixed(2) ?? 'N/A'} ms`
      : 'Query not executed';

  const costValue = plan.root.totalCost.toFixed(1);
  const costSub = `Startup: ${plan.root.startupCost.toFixed(1)} | Est rows: ${plan.root.planRows.toLocaleString('en-US')}`;

  const hitPct =
    totalBuffers.cacheHitRatio !== null
      ? `${(totalBuffers.cacheHitRatio * 100).toFixed(1)}%`
      : 'N/A';
  const hitTone: 'default' | 'good' | 'warn' | 'bad' =
    totalBuffers.cacheHitRatio === null
      ? 'default'
      : totalBuffers.cacheHitRatio >= 0.95
        ? 'good'
        : totalBuffers.cacheHitRatio >= 0.8
          ? 'warn'
          : 'bad';
  const hitSub = `Hit: ${totalBuffers.sharedHitBlocks.toLocaleString('en-US')} | Read: ${totalBuffers.sharedReadBlocks.toLocaleString('en-US')} blks`;

  const readMb = ((totalBuffers.sharedReadBlocks * 8) / 1024).toFixed(2);
  const tempKb = totalBuffers.tempWrittenBlocks * 8;
  const ioTone: 'default' | 'good' | 'warn' | 'bad' =
    tempKb > 0 ? 'bad' : totalBuffers.sharedReadBlocks > 1000 ? 'warn' : 'good';
  const ioValue =
    tempKb > 0 ? `${tempKb.toLocaleString('en-US')} KB spill` : `${readMb} MB`;
  const ioSub =
    tempKb > 0
      ? `Disk spill (${totalBuffers.tempWrittenBlocks} temp blocks)`
      : 'Disk / OS page reads';

  const strip = getEl<HTMLElement>('kpi-strip');
  strip.replaceChildren(
    createKpiCard('Execution Time', execValue, execSub),
    createKpiCard('Total Cost', costValue, costSub),
    createKpiCard('Buffer Cache Hit', hitPct, hitSub, hitTone),
    createKpiCard('I/O & Temp Spill', ioValue, ioSub, ioTone),
  );
}

function createDeltaTile(
  label: string,
  transition: string,
  deltaPct: number | undefined,
  isNoise?: boolean,
  noiseLabel = 'SUB-MS JITTER',
): HTMLElement {
  let tone = 'neutral';
  let badgeText = 'UNCHANGED';
  if (isNoise) {
    badgeText = noiseLabel;
  } else if (deltaPct !== undefined) {
    if (deltaPct <= -5) {
      tone = 'improved';
      badgeText = `${deltaPct.toFixed(1)}% FASTER / LOWER`;
    } else if (deltaPct >= 5) {
      tone = 'regressed';
      badgeText = `+${deltaPct.toFixed(1)}% SLOWER / HIGHER`;
    } else {
      badgeText = `${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(1)}%`;
    }
  }

  const tile = el('div', `diff-tile diff-${tone}`);
  tile.append(
    el('div', 'diff-label', label),
    el('div', 'diff-transition', transition),
    el('div', `diff-badge diff-badge-${tone}`, badgeText),
  );
  return tile;
}

function renderComparison(payload: WebviewRenderPayload): void {
  const section = getEl<HTMLElement>('comparison-section');
  const select = getEl<HTMLSelectElement>('baseline-select');
  const grid = getEl<HTMLDivElement>('comparison-grid');

  const cmp: PlanComparisonSummary | undefined = payload.comparison;
  if (!cmp || payload.baselineOptions.length === 0) {
    section.hidden = true;
    return;
  }

  section.hidden = false;

  const options = payload.baselineOptions.map((opt) => {
    const option = document.createElement('option');
    option.value = String(opt.index);
    option.textContent = opt.label;
    option.selected = opt.index === payload.selectedBaselineIndex;
    return option;
  });
  select.replaceChildren(...options);

  const tiles: HTMLElement[] = [];
  if (
    cmp.previousExecutionTimeMs !== undefined &&
    cmp.currentExecutionTimeMs !== undefined
  ) {
    tiles.push(
      createDeltaTile(
        'Execution Time',
        `${cmp.previousExecutionTimeMs.toFixed(2)} ms → ${cmp.currentExecutionTimeMs.toFixed(2)} ms`,
        cmp.executionTimeDeltaPercent,
        cmp.executionTimeIsNoise,
        'SUB-MS JITTER',
      ),
    );
  }

  tiles.push(
    createDeltaTile(
      'Total Cost',
      `${cmp.previousCost.toFixed(1)} → ${cmp.currentCost.toFixed(1)}`,
      cmp.costDeltaPercent,
    ),
    createDeltaTile(
      'Total Buffers',
      `${cmp.previousSharedBlocks.toLocaleString('en-US')} → ${cmp.currentSharedBlocks.toLocaleString('en-US')}`,
      cmp.blocksDeltaPercent,
      cmp.blocksDeltaIsNoise,
      'MINOR JITTER',
    ),
  );

  const planTile = el('div', 'diff-tile diff-neutral');
  planTile.append(
    el('div', 'diff-label', 'Plan Shape & Alerts'),
    el(
      'div',
      'diff-transition',
      `${cmp.previousPlanSummary} ➔ ${cmp.currentPlanSummary}`,
    ),
    el(
      'div',
      'diff-badge diff-badge-neutral',
      `Diagnostics: ${cmp.previousDiagnosticsCount} → ${cmp.currentDiagnosticsCount}`,
    ),
  );
  tiles.push(planTile);

  grid.replaceChildren(...tiles);
}

function severityLabel(severity: DiagnosticSeverity): string {
  switch (severity) {
    case 'critical':
      return 'CRITICAL';
    case 'warning':
      return 'WARNING';
    case 'info':
      return 'INFO';
  }
}

function focusNodeInTree(nodeId: string, payload: WebviewRenderPayload): void {
  const parts = nodeId.split('.');
  for (let i = 1; i < parts.length; i++) {
    collapsedNodeIds.delete(parts.slice(0, i).join('.'));
  }
  selectedNodeId = nodeId;
  saveUiState();

  const diagMap = indexDiagnosticsByNode(payload.report.diagnostics);
  renderTree(payload, diagMap);
  renderInspector(payload, diagMap);

  const prefersReducedMotion = window.matchMedia(
    '(prefers-reduced-motion: reduce)',
  ).matches;
  const btn = document.querySelector<HTMLButtonElement>(
    `button[data-node-id="${CSS.escape(nodeId)}"]`,
  );
  btn?.focus();
  btn?.scrollIntoView({
    block: 'nearest',
    behavior: prefersReducedMotion ? 'auto' : 'smooth',
  });
}

function renderDiagnostics(payload: WebviewRenderPayload): void {
  const { report } = payload;
  const heading = getEl<HTMLHeadingElement>('diagnostics-heading');
  heading.textContent = `Diagnostics (${report.diagnostics.length})`;

  const list = getEl<HTMLDivElement>('diagnostics-list');
  if (report.diagnostics.length === 0) {
    const okBox = el(
      'div',
      'diagnostic-empty',
      'No performance bottlenecks detected by current QueryAutopsy rules.',
    );
    list.replaceChildren(okBox);
    return;
  }

  const cards = report.diagnostics.map((finding) => {
    const card = el('article', `diagnostic-card severity-${finding.severity}`);

    const header = el('div', 'diagnostic-header');
    const left = el('div', 'diagnostic-title-row');
    const badge = el(
      'span',
      `severity-badge badge-${finding.severity}`,
      severityLabel(finding.severity),
    );
    const title = el('strong', 'diagnostic-title', finding.title);
    left.append(badge, title);

    const jumpBtn = el(
      'button',
      'btn-link',
      `Node #${finding.nodeId} (${finding.nodeType})`,
    );
    jumpBtn.type = 'button';
    jumpBtn.addEventListener('click', () => {
      focusNodeInTree(finding.nodeId, payload);
    });

    header.append(left, jumpBtn);

    const detail = el('p', 'diagnostic-detail', finding.detail);
    const rec = el('p', 'diagnostic-rec', `Fix: ${finding.recommendation}`);
    card.append(header, detail, rec);

    if (finding.indexSuggestion) {
      const sqlBox = el('div', 'index-suggestion-box');
      const pre = el('pre', 'index-sql-pre');
      pre.setAttribute('role', 'region');
      pre.setAttribute(
        'aria-label',
        `Suggested index SQL for ${finding.indexSuggestion.table}`,
      );
      pre.tabIndex = 0;
      pre.appendChild(el('code', undefined, finding.indexSuggestion.sql));

      const actionRow = el('div', 'index-action-row');
      const sqlToUse = finding.indexSuggestion.sql;
      const tableName = finding.indexSuggestion.table;

      const copyBtn = el('button', 'btn-secondary btn-copy', 'Copy Index SQL');
      copyBtn.type = 'button';
      copyBtn.setAttribute(
        'aria-label',
        `Copy suggested index SQL for ${tableName}`,
      );
      copyBtn.addEventListener('click', () => {
        vscodeApi.postMessage({ type: 'COPY_SQL', payload: { sql: sqlToUse } });
        announceStatus(`Copied suggested index SQL for ${tableName}`);
      });

      actionRow.append(copyBtn);

      if (!report.engine || report.engine === 'postgresql') {
        const simBtn = el('button', 'btn-secondary', 'Simulate (HypoPG)');
        simBtn.type = 'button';
        simBtn.setAttribute(
          'aria-label',
          `Simulate index impact for ${tableName} using HypoPG`,
        );
        simBtn.addEventListener('click', () => {
          vscodeApi.postMessage({
            type: 'SIMULATE_INDEX',
            payload: { querySql: report.sql, indexSql: sqlToUse },
          });
          announceStatus(`Running HypoPG What-If simulation for ${tableName}`);
        });
        actionRow.append(simBtn);
      }

      sqlBox.append(pre, actionRow);

      const cachedSim = simulationResultsByIndexSql.get(sqlToUse);
      if (cachedSim) {
        const simBox = el(
          'div',
          `sim-result-box ${cachedSim.supported ? 'sim-supported' : 'sim-unsupported'}`,
          cachedSim.message,
        );
        sqlBox.appendChild(simBox);
      }

      card.appendChild(sqlBox);
    }

    return card;
  });

  list.replaceChildren(...cards);
}

function buildTreeBranch(
  node: PlanNode,
  payload: WebviewRenderPayload,
  diagMap: Map<string, DiagnosticFinding[]>,
): HTMLLIElement | null {
  if (issuesOnly && !subtreeHasIssue(node, diagMap)) {
    return null;
  }

  const { report } = payload;
  const li = el('li', 'tree-item');
  const row = el('div', 'tree-node-row');
  const hasChildren = node.children.length > 0;
  const isCollapsed = collapsedNodeIds.has(node.id);
  const childrenUlId = `tree-children-${node.id.replace(/\./g, '-')}`;

  if (hasChildren) {
    const toggleBtn = el('button', 'tree-toggle', isCollapsed ? '▸' : '▾');
    toggleBtn.type = 'button';
    toggleBtn.setAttribute('aria-expanded', String(!isCollapsed));
    toggleBtn.setAttribute('aria-controls', childrenUlId);
    toggleBtn.setAttribute(
      'aria-label',
      `${isCollapsed ? 'Expand' : 'Collapse'} ${node.nodeType} #${node.id}`,
    );
    toggleBtn.addEventListener('click', () => {
      if (collapsedNodeIds.has(node.id)) {
        collapsedNodeIds.delete(node.id);
      } else {
        collapsedNodeIds.add(node.id);
      }
      saveUiState();
      renderTree(payload, diagMap);
    });
    row.appendChild(toggleBtn);
  } else {
    row.appendChild(el('span', 'tree-leaf-spacer', '•'));
  }

  const nodeDiagnostics = diagMap.get(node.id) ?? [];
  const health = getNodeHealthLevel(node, nodeDiagnostics);
  const isSelected = selectedNodeId === node.id;

  const selectBtn = el(
    'button',
    `tree-select-btn health-${health}${isSelected ? ' selected' : ''}`,
  );
  selectBtn.type = 'button';
  selectBtn.dataset['nodeId'] = node.id;
  selectBtn.setAttribute('aria-pressed', String(isSelected));

  const topLine = el('div', 'node-top-line');
  const titleGroup = el('span', 'node-title-group');
  const healthLabel =
    health === 'critical' ? 'HOT' : health === 'warning' ? 'WARN' : 'OK';
  const healthBadge = el(
    'span',
    `node-health-badge health-${health}`,
    healthLabel,
  );
  const labelText = [
    node.nodeType,
    node.relationName ? `on ${node.relationName}` : '',
    node.indexName ? `using ${node.indexName}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  titleGroup.append(healthBadge, el('span', 'node-name', labelText));

  if (node.parallelAware) {
    titleGroup.appendChild(el('span', 'pill pill-parallel', 'PARALLEL'));
  }
  if (node.subplanName) {
    titleGroup.appendChild(el('span', 'pill pill-muted', node.subplanName));
  }

  const metricsGroup = el('span', 'node-metrics-group');
  if (report.mode === 'analyze' && node.exclusiveTimeMs !== undefined) {
    const pct = node.exclusiveTimePercent ?? 0;
    metricsGroup.appendChild(
      el(
        'span',
        'node-metric',
        `${node.exclusiveTimeMs.toFixed(2)} ms (${pct.toFixed(1)}%)`,
      ),
    );
  } else {
    metricsGroup.appendChild(
      el('span', 'node-metric', `cost ${node.totalCost.toFixed(1)}`),
    );
  }

  topLine.append(titleGroup, metricsGroup);
  selectBtn.appendChild(topLine);

  const subLine = el('div', 'node-sub-line');
  const rowsText =
    report.mode === 'analyze' && node.actualRows !== undefined
      ? `rows: ${node.actualRows.toLocaleString('en-US')} (est ${node.planRows.toLocaleString('en-US')}) · loops: ${node.actualLoops ?? 1}`
      : `est rows: ${node.planRows.toLocaleString('en-US')}`;
  subLine.appendChild(el('span', 'node-sub-text', rowsText));

  if (report.mode === 'analyze' && node.exclusiveTimePercent !== undefined) {
    const progress = document.createElement('progress');
    progress.className = `node-time-bar health-${health}`;
    progress.max = 100;
    progress.value = Math.min(100, Math.max(0, node.exclusiveTimePercent));
    progress.setAttribute(
      'aria-label',
      `Exclusive time share ${node.exclusiveTimePercent.toFixed(1)} percent`,
    );
    subLine.appendChild(progress);
  }

  selectBtn.appendChild(subLine);
  selectBtn.addEventListener('click', () => {
    selectedNodeId = node.id;
    saveUiState();
    renderTree(payload, diagMap);
    renderInspector(payload, diagMap);
  });

  row.appendChild(selectBtn);
  li.appendChild(row);

  if (hasChildren) {
    const childrenUl = el('ul', 'tree-children');
    childrenUl.id = childrenUlId;
    childrenUl.hidden = isCollapsed;
    for (const child of node.children) {
      const childLi = buildTreeBranch(child, payload, diagMap);
      if (childLi) {
        childrenUl.appendChild(childLi);
      }
    }
    if (childrenUl.childElementCount > 0) {
      li.appendChild(childrenUl);
    }
  }

  return li;
}

function renderTree(
  payload: WebviewRenderPayload,
  diagMap: Map<string, DiagnosticFinding[]>,
): void {
  const treeUl = getEl<HTMLUListElement>('plan-tree');
  const rootBranch = buildTreeBranch(payload.report.plan.root, payload, diagMap);
  if (rootBranch) {
    treeUl.replaceChildren(rootBranch);
  } else {
    treeUl.replaceChildren(
      el('li', 'tree-empty', 'No bottlenecks match the current filter.'),
    );
  }
}

function addInspectorRow(
  dl: HTMLDListElement,
  term: string,
  definition: string,
): void {
  dl.append(el('dt', undefined, term), el('dd', undefined, definition));
}

function renderInspector(
  payload: WebviewRenderPayload,
  diagMap: Map<string, DiagnosticFinding[]>,
): void {
  const { report, nodeExplanations } = payload;
  const container = getEl<HTMLDivElement>('node-inspector');
  const nodeMap = flattenNodes(report.plan.root);
  const activeNode =
    (selectedNodeId ? nodeMap.get(selectedNodeId) : undefined) ??
    report.plan.root;

  selectedNodeId = activeNode.id;

  const header = el('div', 'inspector-node-header');
  header.append(
    el('div', 'inspector-node-title', `[#${activeNode.id}] ${activeNode.nodeType}`),
    el(
      'div',
      'inspector-node-sub',
      activeNode.relationName
        ? `${activeNode.schema ? `${activeNode.schema}.` : ''}${activeNode.relationName}${activeNode.alias && activeNode.alias !== activeNode.relationName ? ` (${activeNode.alias})` : ''}`
        : activeNode.parentRelationship ?? 'Execution operator',
    ),
  );

  const elements: HTMLElement[] = [header];

  const plainEnglish = nodeExplanations[activeNode.id];
  if (plainEnglish) {
    elements.push(el('p', 'inspector-plain-english', plainEnglish));
  }

  const dl = el('dl', 'inspector-dl');
  if (activeNode.indexName) {
    addInspectorRow(dl, 'Index', activeNode.indexName);
  }
  if (activeNode.joinType) {
    addInspectorRow(dl, 'Join Type', activeNode.joinType);
  }
  if (activeNode.subplanName) {
    addInspectorRow(dl, 'Subplan', activeNode.subplanName);
  }
  addInspectorRow(
    dl,
    'Cost (Startup..Total)',
    `${activeNode.startupCost.toFixed(2)} .. ${activeNode.totalCost.toFixed(2)}`,
  );
  addInspectorRow(
    dl,
    'Planned Rows / Width',
    `${activeNode.planRows.toLocaleString('en-US')} rows (${activeNode.planWidth} B)`,
  );

  if (report.mode === 'analyze') {
    addInspectorRow(
      dl,
      'Actual Rows / Loops',
      `${(activeNode.actualRows ?? 0).toLocaleString('en-US')} rows × ${activeNode.actualLoops ?? 1} loop(s)${activeNode.parallelAware ? ' (parallel)' : ''}`,
    );
    addInspectorRow(
      dl,
      'Exclusive Time',
      `${(activeNode.exclusiveTimeMs ?? 0).toFixed(3)} ms (${(activeNode.exclusiveTimePercent ?? 0).toFixed(1)}%)`,
    );
    addInspectorRow(
      dl,
      'Inclusive Time',
      `${(activeNode.inclusiveTimeMs ?? 0).toFixed(3)} ms`,
    );
  }

  if (activeNode.rowsRemovedByFilter !== undefined) {
    addInspectorRow(
      dl,
      'Rows Removed by Filter',
      activeNode.rowsRemovedByFilter.toLocaleString('en-US'),
    );
  }
  if (activeNode.exactHeapBlocks !== undefined || activeNode.lossyHeapBlocks !== undefined) {
    addInspectorRow(
      dl,
      'Heap Blocks (Exact / Lossy)',
      `${activeNode.exactHeapBlocks ?? 0} exact / ${activeNode.lossyHeapBlocks ?? 0} lossy`,
    );
  }
  if (activeNode.filter) {
    addInspectorRow(dl, 'Filter', activeNode.filter);
  }
  if (activeNode.indexCond) {
    addInspectorRow(dl, 'Index Cond', activeNode.indexCond);
  }
  if (activeNode.hashCond) {
    addInspectorRow(dl, 'Hash Cond', activeNode.hashCond);
  }
  if (activeNode.sort?.sortMethod) {
    addInspectorRow(
      dl,
      'Sort',
      `${activeNode.sort.sortMethod} (${activeNode.sort.sortSpaceUsedKb ?? 0} KB ${activeNode.sort.sortSpaceType ?? ''})`,
    );
  }

  const buf = activeNode.buffers;
  const hitRatioText =
    buf.cacheHitRatio !== null
      ? `${(buf.cacheHitRatio * 100).toFixed(1)}%`
      : 'N/A';
  addInspectorRow(
    dl,
    'Subtree Buffers',
    `hit=${buf.sharedHitBlocks}, read=${buf.sharedReadBlocks}, temp_w=${buf.tempWrittenBlocks} (${hitRatioText} hit)`,
  );

  elements.push(dl);

  const nodeDiags = diagMap.get(activeNode.id) ?? [];
  if (nodeDiags.length > 0) {
    const diagBox = el('div', 'inspector-diagnostics');
    diagBox.appendChild(
      el('h3', 'inspector-subheading', `Node Alerts (${nodeDiags.length})`),
    );
    for (const d of nodeDiags) {
      diagBox.appendChild(
        el(
          'p',
          `inspector-alert severity-${d.severity}`,
          `[${severityLabel(d.severity)}] ${d.title}`,
        ),
      );
    }
    elements.push(diagBox);
  }

  container.replaceChildren(...elements);
}

function updateFilterButtons(): void {
  const allBtn = getEl<HTMLButtonElement>('btn-filter-all');
  const issuesBtn = getEl<HTMLButtonElement>('btn-filter-issues');

  allBtn.classList.toggle('active', !issuesOnly);
  allBtn.setAttribute('aria-pressed', String(!issuesOnly));
  issuesBtn.classList.toggle('active', issuesOnly);
  issuesBtn.setAttribute('aria-pressed', String(issuesOnly));
}

function renderPayload(payload: WebviewRenderPayload): void {
  const prevSql = currentPayload?.report.sql;
  if (prevSql !== payload.report.sql) {
    simulationResultsByIndexSql.clear();
  }

  currentPayload = payload;
  const { report } = payload;

  getEl<HTMLElement>('empty-state').hidden = true;
  getEl<HTMLDivElement>('report-root').hidden = false;
  getEl<HTMLElement>('inspected-sql').textContent = report.sql;

  const nodeMap = flattenNodes(report.plan.root);
  if (!selectedNodeId || !nodeMap.has(selectedNodeId)) {
    selectedNodeId = report.diagnostics[0]?.nodeId ?? report.plan.root.id;
  }

  const diagMap = indexDiagnosticsByNode(report.diagnostics);

  renderMeta(report);
  renderKpiStrip(report);
  renderComparison(payload);
  renderDiagnostics(payload);
  updateFilterButtons();
  renderTree(payload, diagMap);
  renderInspector(payload, diagMap);
  saveUiState();
}

function collectParentNodeIds(node: PlanNode, out: Set<string>): void {
  if (node.children.length > 0) {
    out.add(node.id);
    for (const child of node.children) {
      collectParentNodeIds(child, out);
    }
  }
}

function wireEvents(): void {
  getEl<HTMLButtonElement>('btn-rerun-analyze').addEventListener('click', () => {
    if (!currentPayload) {
      return;
    }
    vscodeApi.postMessage({
      type: 'RERUN_QUERY',
      payload: { sql: currentPayload.report.sql, mode: 'analyze' },
    });
  });

  getEl<HTMLButtonElement>('btn-rerun-estimate').addEventListener(
    'click',
    () => {
      if (!currentPayload) {
        return;
      }
      vscodeApi.postMessage({
        type: 'RERUN_QUERY',
        payload: { sql: currentPayload.report.sql, mode: 'estimate' },
      });
    },
  );

  getEl<HTMLButtonElement>('btn-copy-markdown').addEventListener('click', () => {
    if (!currentPayload) {
      return;
    }
    vscodeApi.postMessage({ type: 'COPY_MARKDOWN_REPORT' });
    announceStatus('Copied Markdown pull request report to clipboard');
  });

  getEl<HTMLSelectElement>('baseline-select').addEventListener(
    'change',
    (event) => {
      const target = event.target as HTMLSelectElement;
      const index = Number(target.value);
      if (Number.isInteger(index)) {
        vscodeApi.postMessage({
          type: 'SELECT_BASELINE',
          payload: { index },
        });
      }
    },
  );

  getEl<HTMLButtonElement>('btn-expand-all').addEventListener('click', () => {
    if (!currentPayload) {
      return;
    }
    collapsedNodeIds.clear();
    saveUiState();
    renderTree(
      currentPayload,
      indexDiagnosticsByNode(currentPayload.report.diagnostics),
    );
  });

  getEl<HTMLButtonElement>('btn-collapse-all').addEventListener('click', () => {
    if (!currentPayload) {
      return;
    }
    collapsedNodeIds.clear();
    collectParentNodeIds(currentPayload.report.plan.root, collapsedNodeIds);
    collapsedNodeIds.delete(currentPayload.report.plan.root.id);
    saveUiState();
    renderTree(
      currentPayload,
      indexDiagnosticsByNode(currentPayload.report.diagnostics),
    );
  });

  getEl<HTMLButtonElement>('btn-filter-all').addEventListener('click', () => {
    issuesOnly = false;
    updateFilterButtons();
    saveUiState();
    if (currentPayload) {
      renderTree(
        currentPayload,
        indexDiagnosticsByNode(currentPayload.report.diagnostics),
      );
    }
  });

  getEl<HTMLButtonElement>('btn-filter-issues').addEventListener('click', () => {
    issuesOnly = true;
    updateFilterButtons();
    saveUiState();
    if (currentPayload) {
      renderTree(
        currentPayload,
        indexDiagnosticsByNode(currentPayload.report.diagnostics),
      );
    }
  });

  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    const data = event.data as Partial<ExtensionToWebviewMessage> | undefined;
    if (data?.type === 'RENDER_REPORT' && data.payload) {
      renderPayload(data.payload);
      announceStatus('Updated PostgreSQL execution plan report');
      return;
    }
    if (data?.type === 'SIMULATION_RESULT' && data.payload && currentPayload) {
      simulationResultsByIndexSql.set(data.payload.indexSql, data.payload);
      renderDiagnostics(currentPayload);
      announceStatus(data.payload.message);
    }
  });
}

restoreUiState();
wireEvents();
vscodeApi.postMessage({ type: 'READY' });
