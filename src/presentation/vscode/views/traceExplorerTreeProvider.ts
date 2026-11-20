import {
  analyzeQueryTraces,
  type ExplainMode,
  type LoggerPort,
  parseQueryTraceStream,
  type QueryTraceAnalysisResult,
  selectExplainCandidatesForTrace,
  type TraceDiagnosticFinding,
  type TraceExplainCandidate,
  type TraceQuerySummary,
} from '@query-autopsy/core';
import * as vscode from 'vscode';
import type {
  DiscoveredTraceFile,
  ResolvedTraceSourceTarget,
} from '../../../infrastructure/vscode/workspaceTraceDiscovery.js';

export const REFRESH_TRACES_COMMAND = 'queryAutopsy.refreshTraces';
export const OPEN_TRACE_FILE_COMMAND = 'queryAutopsy.openTraceFile';
export const OPEN_TRACE_SOURCE_COMMAND = 'queryAutopsy.openTraceSource';
export const ESTIMATE_TRACE_QUERY_COMMAND = 'queryAutopsy.estimateTraceQuery';
export const ANALYZE_TRACE_QUERY_COMMAND = 'queryAutopsy.analyzeTraceQuery';

export interface TraceFileAnalysisViewModel {
  readonly file: DiscoveredTraceFile;
  readonly skippedLines: number;
  readonly truncated: boolean;
  readonly analysis: QueryTraceAnalysisResult;
  readonly candidatesByKey: ReadonlyMap<string, TraceExplainCandidate>;
  readonly resolvedSourcesByKey: ReadonlyMap<string, ResolvedTraceSourceTarget>;
}

export type TraceTreeNode =
  | {
      readonly kind: 'status';
      readonly label: string;
      readonly description?: string | undefined;
      readonly tooltip: string;
      readonly icon: string;
      readonly commandId?: string | undefined;
    }
  | {
      readonly kind: 'traceFile';
      readonly model: TraceFileAnalysisViewModel;
    }
  | {
      readonly kind: 'summary';
      readonly model: TraceFileAnalysisViewModel;
    }
  | {
      readonly kind: 'group';
      readonly groupKind: 'diagnostics' | 'offenders';
      readonly model: TraceFileAnalysisViewModel;
    }
  | {
      readonly kind: 'finding';
      readonly finding: TraceDiagnosticFinding;
      readonly model: TraceFileAnalysisViewModel;
      readonly candidate?: TraceExplainCandidate | undefined;
      readonly resolvedSource?: ResolvedTraceSourceTarget | undefined;
    }
  | {
      readonly kind: 'offender';
      readonly summary: TraceQuerySummary;
      readonly model: TraceFileAnalysisViewModel;
      readonly candidate?: TraceExplainCandidate | undefined;
      readonly resolvedSource?: ResolvedTraceSourceTarget | undefined;
    };

export interface TraceExplorerConfig {
  readonly nPlusOneThreshold: number;
  readonly slowQueryMsThreshold: number;
  readonly redactLiterals: boolean;
}

export interface TraceExplorerDependencies {
  readonly discoverFiles: () => Promise<readonly DiscoveredTraceFile[]>;
  readonly readTraceFile: (file: DiscoveredTraceFile) => Promise<string>;
  readonly resolveSourceTarget: (
    rawFile: string,
    line: number | undefined,
    folderUri: vscode.Uri,
  ) => Promise<ResolvedTraceSourceTarget | undefined>;
  readonly onInspectCandidate: (
    sql: string,
    bindings: readonly unknown[] | undefined,
    mode: ExplainMode,
  ) => Promise<void>;
  readonly onOpenSource: (target: ResolvedTraceSourceTarget) => Promise<void>;
  readonly getConfig: () => TraceExplorerConfig;
  readonly logger: LoggerPort;
}

function formatDurationMs(ms: number): string {
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(2)}s`;
  }
  return `${ms.toFixed(1)}ms`;
}

function summarizeSqlPreview(sql: string, maxLen = 48): string {
  const collapsed = sql.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLen) {
    return collapsed;
  }
  return `${collapsed.slice(0, maxLen - 1)}…`;
}

function makeCandidateKey(engine: string, fingerprint: string): string {
  return `${engine}\u0000${fingerprint}`;
}

function makeSourceLocationKey(file: string, line?: number): string {
  return `${file}\u0000${line ?? 1}`;
}

export class TraceExplorerTreeProvider
  implements vscode.TreeDataProvider<TraceTreeNode>, vscode.Disposable
{
  private readonly changeEmitter = new vscode.EventEmitter<
    TraceTreeNode | undefined
  >();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  private customTraceFile: DiscoveredTraceFile | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshSequence = 0;

  private state:
    | { readonly kind: 'empty' }
    | { readonly kind: 'loading' }
    | { readonly kind: 'loaded'; readonly models: readonly TraceFileAnalysisViewModel[] }
    | { readonly kind: 'error'; readonly message: string } = { kind: 'empty' };

  constructor(private readonly deps: TraceExplorerDependencies) {}

  setCustomTraceFile(file: DiscoveredTraceFile | undefined): void {
    this.customTraceFile = file;
  }

  scheduleRefresh(delayMs = 350): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, delayMs);
  }

  async refresh(): Promise<void> {
    const seq = ++this.refreshSequence;
    this.state = { kind: 'loading' };
    this.changeEmitter.fire(undefined);

    try {
      const discovered = await this.deps.discoverFiles();
      const files: DiscoveredTraceFile[] = [...discovered];
      if (
        this.customTraceFile &&
        !files.some(
          (f) => f.uri.toString() === this.customTraceFile!.uri.toString(),
        )
      ) {
        files.unshift(this.customTraceFile);
      }

      if (files.length === 0) {
        if (seq === this.refreshSequence) {
          this.state = { kind: 'empty' };
          this.changeEmitter.fire(undefined);
        }
        return;
      }

      const cfg = this.deps.getConfig();
      const models: TraceFileAnalysisViewModel[] = [];

      for (const file of files) {
        try {
          const content = await this.deps.readTraceFile(file);
          const parsed = parseQueryTraceStream(content);
          const analysis = analyzeQueryTraces(parsed.entries, {
            nPlusOneWarningThreshold: Math.max(2, cfg.nPlusOneThreshold),
            nPlusOneCriticalThreshold: Math.max(
              Math.max(2, cfg.nPlusOneThreshold) + 1,
              10,
            ),
            slowQueryMsThreshold: Math.max(1, cfg.slowQueryMsThreshold),
            redact: cfg.redactLiterals,
          });

          const candidates = selectExplainCandidatesForTrace(
            parsed.entries,
            analysis,
            analysis.diagnostics.length + analysis.topOffenders.length,
          );
          const candidatesByKey = new Map<string, TraceExplainCandidate>();
          for (const candidate of candidates) {
            candidatesByKey.set(
              makeCandidateKey(candidate.engine, candidate.fingerprint),
              candidate,
            );
          }

          const resolvedSourcesByKey = new Map<string, ResolvedTraceSourceTarget>();
          const uniqueLocations = new Map<
            string,
            { readonly file: string; readonly line: number | undefined }
          >();

          for (const d of analysis.diagnostics) {
            if (d.file) {
              uniqueLocations.set(makeSourceLocationKey(d.file, d.line), {
                file: d.file,
                line: d.line,
              });
            }
          }
          for (const o of analysis.topOffenders) {
            if (o.file) {
              uniqueLocations.set(makeSourceLocationKey(o.file, o.line), {
                file: o.file,
                line: o.line,
              });
            }
          }

          await Promise.all(
            Array.from(uniqueLocations.entries()).map(async ([key, loc]) => {
              const target = await this.deps.resolveSourceTarget(
                loc.file,
                loc.line,
                file.folderUri,
              );
              if (target) {
                resolvedSourcesByKey.set(key, target);
              }
            }),
          );

          models.push({
            file,
            skippedLines: parsed.skippedLines,
            truncated: parsed.truncated,
            analysis,
            candidatesByKey,
            resolvedSourcesByKey,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.deps.logger.warn('Failed to parse trace file', {
            path: file.relativePath,
            message: msg,
          });
        }
      }

      if (seq !== this.refreshSequence) {
        return;
      }

      if (models.length === 0) {
        this.state = {
          kind: 'error',
          message: 'Found trace file(s), but none could be read safely.',
        };
      } else {
        this.state = { kind: 'loaded', models };
      }
    } catch (err) {
      if (seq !== this.refreshSequence) {
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.deps.logger.error('Failed to refresh Trace Explorer', { message });
      this.state = { kind: 'error', message };
    }

    this.changeEmitter.fire(undefined);
  }

  async handleOpenSource(node: TraceTreeNode | undefined): Promise<void> {
    if (
      node &&
      (node.kind === 'finding' || node.kind === 'offender') &&
      node.resolvedSource
    ) {
      await this.deps.onOpenSource(node.resolvedSource);
    }
  }

  async handleInspect(
    node: TraceTreeNode | undefined,
    mode: ExplainMode,
  ): Promise<void> {
    if (!node || (node.kind !== 'finding' && node.kind !== 'offender')) {
      return;
    }

    const sql =
      node.candidate?.rawSql ??
      (node.kind === 'finding' ? node.finding.sampleSql : node.summary.sampleSql);
    await this.deps.onInspectCandidate(sql, node.candidate?.bindings, mode);
  }

  getTreeItem(element: TraceTreeNode): vscode.TreeItem {
    if (element.kind === 'status') {
      const item = new vscode.TreeItem(
        element.label,
        vscode.TreeItemCollapsibleState.None,
      );
      if (element.description !== undefined) {
        item.description = element.description;
      }
      item.tooltip = element.tooltip;
      item.iconPath = new vscode.ThemeIcon(element.icon);
      item.contextValue = 'traceStatus';
      if (element.commandId) {
        item.command = {
          command: element.commandId,
          title: element.label,
        };
      }
      return item;
    }

    if (element.kind === 'traceFile') {
      const { model } = element;
      const diagCount = model.analysis.diagnostics.length;
      const item = new vscode.TreeItem(
        model.file.relativePath,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.description = `${diagCount} issue(s) · ${model.analysis.totalQueries} queries`;
      item.iconPath = new vscode.ThemeIcon(diagCount > 0 ? 'warning' : 'file-code');
      item.contextValue = 'traceFile';
      return item;
    }

    if (element.kind === 'summary') {
      const { model } = element;
      const a = model.analysis;
      const item = new vscode.TreeItem(
        `${a.totalQueries} queries · ${a.requestCount} request(s) · ${formatDurationMs(a.totalDurationMs)}`,
        vscode.TreeItemCollapsibleState.None,
      );
      item.description = model.file.relativePath;
      item.iconPath = new vscode.ThemeIcon(
        a.diagnostics.length === 0 ? 'pass' : 'pulse',
      );
      item.tooltip = [
        `Trace file: ${model.file.relativePath}`,
        `Total queries: ${a.totalQueries}`,
        `Distinct fingerprints: ${a.distinctFingerprints}`,
        `Requests: ${a.requestCount}`,
        `Skipped malformed lines: ${model.skippedLines}`,
        model.truncated ? 'Note: Trace capped at parser maxEntries.' : '',
      ]
        .filter(Boolean)
        .join('\n');
      item.contextValue = 'traceSummary';
      return item;
    }

    if (element.kind === 'group') {
      const { model, groupKind } = element;
      if (groupKind === 'diagnostics') {
        const count = model.analysis.diagnostics.length;
        const item = new vscode.TreeItem(
          `N+1 & Slow Diagnostics (${count})`,
          count > 0
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.iconPath = new vscode.ThemeIcon(count > 0 ? 'flame' : 'check');
        item.contextValue = 'traceGroup';
        return item;
      }

      const item = new vscode.TreeItem(
        `Top Queries (${model.analysis.topOffenders.length})`,
        model.analysis.diagnostics.length === 0
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.iconPath = new vscode.ThemeIcon('list-ordered');
      item.contextValue = 'traceGroup';
      return item;
    }

    if (element.kind === 'finding') {
      const { finding, resolvedSource } = element;
      const prefix =
        finding.ruleId === 'N_PLUS_ONE_BURST'
          ? `N+1 (${finding.repeatCount}×)`
          : `Slow (${formatDurationMs(finding.maxDurationMs)})`;
      const item = new vscode.TreeItem(
        `${prefix} · ${summarizeSqlPreview(finding.sampleSql, 44)}`,
        vscode.TreeItemCollapsibleState.None,
      );

      const locText = finding.file
        ? `${finding.file}${finding.line !== undefined ? `:${finding.line}` : ''}`
        : undefined;
      item.description = [
        finding.requestId,
        formatDurationMs(finding.totalDurationMs),
        locText,
      ]
        .filter(Boolean)
        .join(' · ');

      const md = new vscode.MarkdownString();
      md.appendMarkdown(`**${finding.ruleId}** (${finding.severity.toUpperCase()})\n\n`);
      md.appendMarkdown(`${finding.detail}\n\n`);
      if (locText) {
        md.appendMarkdown(`**Source:** \`${locText}\`\n\n`);
      }
      md.appendCodeblock(finding.sampleSql, 'sql');
      md.appendMarkdown(`\n**Recommendation:** ${finding.recommendation}\n\n`);
      md.appendMarkdown(
        resolvedSource
          ? '_Click to jump to source line, or use inline icons to run EXPLAIN._'
          : '_Click to run read-only EXPLAIN estimate on this query._',
      );
      item.tooltip = md;

      item.iconPath =
        finding.severity === 'critical'
          ? new vscode.ThemeIcon(
              'flame',
              new vscode.ThemeColor('errorForeground'),
            )
          : new vscode.ThemeIcon(
              'warning',
              new vscode.ThemeColor('editorWarning.foreground'),
            );

      item.contextValue = resolvedSource
        ? 'traceFindingWithLocation'
        : 'traceFinding';

      item.command = resolvedSource
        ? {
            command: OPEN_TRACE_SOURCE_COMMAND,
            title: 'Jump to Source Location',
            arguments: [element],
          }
        : {
            command: ESTIMATE_TRACE_QUERY_COMMAND,
            title: 'Estimate EXPLAIN Plan',
            arguments: [element],
          };

      return item;
    }

    const { summary, resolvedSource } = element;
    const item = new vscode.TreeItem(
      summarizeSqlPreview(summary.sampleSql, 52),
      vscode.TreeItemCollapsibleState.None,
    );
    const burstSuffix =
      summary.maxBurstInSingleRequest >= 2
        ? ` · max burst ${summary.maxBurstInSingleRequest}×`
        : '';
    item.description = `${summary.executionCount}× · ${formatDurationMs(summary.totalDurationMs)} total (avg ${formatDurationMs(summary.meanDurationMs)})${burstSuffix}`;

    const md = new vscode.MarkdownString();
    md.appendMarkdown(
      `**Executions:** \`${summary.executionCount}\` across \`${summary.distinctRequestCount}\` request(s) | **Total:** \`${formatDurationMs(summary.totalDurationMs)}\` | **Max:** \`${formatDurationMs(summary.maxDurationMs)}\`\n\n`,
    );
    if (summary.file) {
      md.appendMarkdown(
        `**Source:** \`${summary.file}${summary.line !== undefined ? `:${summary.line}` : ''}\`\n\n`,
      );
    }
    md.appendCodeblock(summary.sampleSql, 'sql');
    item.tooltip = md;
    item.iconPath = new vscode.ThemeIcon('database');
    item.contextValue = resolvedSource
      ? 'traceOffenderWithLocation'
      : 'traceOffender';
    item.command = {
      command: ESTIMATE_TRACE_QUERY_COMMAND,
      title: 'Estimate EXPLAIN Plan',
      arguments: [element],
    };

    return item;
  }

  getChildren(element?: TraceTreeNode): TraceTreeNode[] {
    if (!element) {
      switch (this.state.kind) {
        case 'empty':
          return [
            {
              kind: 'status',
              label: 'No .query-autopsy/traces.jsonl found',
              description: 'Click to open a JSONL trace file',
              tooltip:
                'Emit traces with marc14444/laravel-query-autopsy or write JSONL lines to .query-autopsy/traces.jsonl, then refresh.',
              icon: 'file-code',
              commandId: OPEN_TRACE_FILE_COMMAND,
            },
          ];
        case 'loading':
          return [
            {
              kind: 'status',
              label: 'Analyzing JSONL runtime traces...',
              icon: 'loading~spin',
              tooltip: 'Parsing and fingerprinting .query-autopsy/traces.jsonl',
            },
          ];
        case 'error':
          return [
            {
              kind: 'status',
              label: 'Failed to load traces (click to retry)',
              description: this.state.message,
              tooltip: this.state.message,
              icon: 'error',
              commandId: REFRESH_TRACES_COMMAND,
            },
          ];
        case 'loaded':
          if (this.state.models.length === 1) {
            return this.buildFileDetailNodes(this.state.models[0]!);
          }
          return this.state.models.map((model) => ({
            kind: 'traceFile',
            model,
          }));
      }
    }

    if (element.kind === 'traceFile') {
      return this.buildFileDetailNodes(element.model);
    }

    if (element.kind === 'group') {
      const { model, groupKind } = element;
      if (groupKind === 'diagnostics') {
        if (model.analysis.diagnostics.length === 0) {
          return [
            {
              kind: 'status',
              label: 'No N+1 bursts or slow outliers detected',
              icon: 'check',
              tooltip: 'All captured queries stayed within configured thresholds.',
            },
          ];
        }

        return model.analysis.diagnostics.map((finding) => {
          const candidate = model.candidatesByKey.get(
            makeCandidateKey(finding.engine, finding.fingerprint),
          );
          const resolvedSource = finding.file
            ? model.resolvedSourcesByKey.get(
                makeSourceLocationKey(finding.file, finding.line),
              )
            : undefined;
          return {
            kind: 'finding',
            finding,
            model,
            ...(candidate ? { candidate } : {}),
            ...(resolvedSource ? { resolvedSource } : {}),
          };
        });
      }

      return model.analysis.topOffenders.map((summary) => {
        const candidate = model.candidatesByKey.get(
          makeCandidateKey(summary.engine, summary.fingerprint),
        );
        const resolvedSource = summary.file
          ? model.resolvedSourcesByKey.get(
              makeSourceLocationKey(summary.file, summary.line),
            )
          : undefined;
        return {
          kind: 'offender',
          summary,
          model,
          ...(candidate ? { candidate } : {}),
          ...(resolvedSource ? { resolvedSource } : {}),
        };
      });
    }

    return [];
  }

  private buildFileDetailNodes(
    model: TraceFileAnalysisViewModel,
  ): TraceTreeNode[] {
    return [
      { kind: 'summary', model },
      { kind: 'group', groupKind: 'diagnostics', model },
      { kind: 'group', groupKind: 'offenders', model },
    ];
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this.changeEmitter.dispose();
  }
}
