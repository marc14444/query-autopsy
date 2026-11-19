import * as vscode from 'vscode';
import { MissingConnectionError } from '../../../domain/errors/domainErrors.js';
import type { ExplainMode } from '../../../domain/models/queryRequest.js';
import type {
  SlowQueryEntry,
  SlowQuerySortBy,
} from '../../../domain/models/slowQuery.js';
import type { FetchSlowQueriesUseCase } from '../../../domain/ports/inbound/fetchSlowQueriesUseCase.js';
import type { LoggerPort } from '../../../domain/ports/outbound/loggerPort.js';

export const REFRESH_SLOW_QUERIES_COMMAND = 'queryAutopsy.refreshSlowQueries';
export const TOGGLE_SLOW_QUERY_SORT_COMMAND = 'queryAutopsy.toggleSlowQuerySort';
export const INSPECT_SLOW_QUERY_COMMAND = 'queryAutopsy.inspectSlowQuery';
export const ESTIMATE_SLOW_QUERY_COMMAND = 'queryAutopsy.estimateSlowQuery';

export type SlowQueryTreeNode =
  | {
      readonly kind: 'status';
      readonly label: string;
      readonly description?: string | undefined;
      readonly tooltip: string;
      readonly icon: string;
      readonly commandId?: string | undefined;
    }
  | {
      readonly kind: 'entry';
      readonly entry: SlowQueryEntry;
    };

function formatDurationMs(ms: number): string {
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(2)}s`;
  }
  return `${ms.toFixed(1)}ms`;
}

function summarizeSqlPreview(sql: string, maxLen = 58): string {
  const collapsed = sql.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLen) {
    return collapsed;
  }
  return `${collapsed.slice(0, maxLen - 1)}…`;
}

export class SlowQueriesTreeProvider
  implements vscode.TreeDataProvider<SlowQueryTreeNode>, vscode.Disposable
{
  private readonly changeEmitter = new vscode.EventEmitter<
    SlowQueryTreeNode | undefined
  >();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  private sortBy: SlowQuerySortBy = 'mean_exec_time';
  private state:
    | { readonly kind: 'idle' }
    | { readonly kind: 'loading' }
    | { readonly kind: 'loaded'; readonly entries: readonly SlowQueryEntry[] }
    | { readonly kind: 'unsupported'; readonly message: string }
    | { readonly kind: 'error'; readonly message: string } = { kind: 'idle' };

  constructor(
    private readonly fetchSlowQueriesUseCase: FetchSlowQueriesUseCase,
    private readonly onInspectSlowQuery: (
      entry: SlowQueryEntry,
      mode: ExplainMode,
    ) => Promise<void>,
    private readonly onConfigureConnectionRequested: () => Promise<boolean>,
    private readonly logger: LoggerPort,
  ) {}

  getSortLabel(): string {
    return this.sortBy === 'mean_exec_time' ? 'Mean Time' : 'Total Time';
  }

  resetToIdle(): void {
    this.state = { kind: 'idle' };
    this.changeEmitter.fire(undefined);
  }

  async toggleSortAndRefresh(): Promise<void> {
    this.sortBy =
      this.sortBy === 'mean_exec_time' ? 'total_exec_time' : 'mean_exec_time';
    void vscode.window.showInformationMessage(
      `QueryAutopsy Slow Queries: Sorted by ${this.getSortLabel()}.`,
    );
    await this.refresh();
  }

  async refresh(): Promise<void> {
    this.state = { kind: 'loading' };
    this.changeEmitter.fire(undefined);

    try {
      const result = await this.fetchSlowQueriesUseCase.execute({
        limit: 10,
        sortBy: this.sortBy,
      });

      if (!result.supported) {
        this.state = { kind: 'unsupported', message: result.reason };
      } else {
        this.state = { kind: 'loaded', entries: result.entries };
      }
    } catch (err) {
      if (err instanceof MissingConnectionError) {
        this.state = {
          kind: 'unsupported',
          message:
            'No database connection configured yet. Click here to configure a profile.',
        };
      } else {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error('Failed to load slow queries', { message });
        this.state = { kind: 'error', message };
      }
    }

    this.changeEmitter.fire(undefined);
  }

  async handleInspect(entry: SlowQueryEntry, mode: ExplainMode): Promise<void> {
    await this.onInspectSlowQuery(entry, mode);
  }

  getTreeItem(element: SlowQueryTreeNode): vscode.TreeItem {
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
      item.contextValue = 'slowQueryStatus';
      if (element.commandId) {
        item.command = {
          command: element.commandId,
          title: element.label,
        };
      }
      return item;
    }

    const { entry } = element;
    const item = new vscode.TreeItem(
      summarizeSqlPreview(entry.query),
      vscode.TreeItemCollapsibleState.None,
    );

    const avgStr = formatDurationMs(entry.meanExecTimeMs);
    const totalStr = formatDurationMs(entry.totalExecTimeMs);
    item.description = `avg ${avgStr} · ${entry.calls.toLocaleString('en-US')} calls · total ${totalStr}`;

    const md = new vscode.MarkdownString();
    md.appendMarkdown(
      `**Mean:** \`${avgStr}\` | **Total:** \`${totalStr}\` | **Calls:** \`${entry.calls.toLocaleString('en-US')}\` | **Rows:** \`${entry.rows.toLocaleString('en-US')}\`\n\n`,
    );
    if (entry.sharedBlksHit + entry.sharedBlksRead > 0) {
      const hitRatio = (
        (entry.sharedBlksHit / (entry.sharedBlksHit + entry.sharedBlksRead)) *
        100
      ).toFixed(1);
      md.appendMarkdown(
        `**Cache Hit:** \`${hitRatio}%\` (hit ${entry.sharedBlksHit.toLocaleString('en-US')}, read ${entry.sharedBlksRead.toLocaleString('en-US')})\n\n`,
      );
    }
    md.appendCodeblock(entry.query, 'sql');
    md.appendMarkdown('\nClick to open SQL and run EXPLAIN inspection.');
    item.tooltip = md;

    item.iconPath = new vscode.ThemeIcon(
      entry.meanExecTimeMs >= 100
        ? 'flame'
        : entry.meanExecTimeMs >= 20
          ? 'warning'
          : 'pulse',
    );
    item.contextValue = 'slowQueryEntry';
    item.command = {
      command: INSPECT_SLOW_QUERY_COMMAND,
      title: 'Open & Inspect Slow Query',
      arguments: [element],
    };

    return item;
  }

  getChildren(element?: SlowQueryTreeNode): SlowQueryTreeNode[] {
    if (element) {
      return [];
    }

    switch (this.state.kind) {
      case 'idle':
        return [
          {
            kind: 'status',
            label: `Load Top 10 Slow Queries (${this.getSortLabel()})`,
            description: 'pg_stat_statements / MySQL',
            tooltip:
              'Query server slow-query stats on demand (no silent background DB calls)',
            icon: 'cloud-download',
            commandId: REFRESH_SLOW_QUERIES_COMMAND,
          },
        ];
      case 'loading':
        return [
          {
            kind: 'status',
            label: 'Loading slow queries from database...',
            icon: 'loading~spin',
            tooltip: 'Querying database statistics',
          },
        ];
      case 'unsupported':
        return [
          {
            kind: 'status',
            label: 'Slow Query stats unavailable',
            description: 'Click for details or configure DB',
            tooltip: this.state.message,
            icon: 'info',
            commandId: this.state.message.includes('configured')
              ? 'queryAutopsy.configureConnection'
              : REFRESH_SLOW_QUERIES_COMMAND,
          },
        ];
      case 'error':
        return [
          {
            kind: 'status',
            label: 'Failed to load slow queries (click to retry)',
            description: this.state.message,
            tooltip: this.state.message,
            icon: 'error',
            commandId: REFRESH_SLOW_QUERIES_COMMAND,
          },
        ];
      case 'loaded':
        if (this.state.entries.length === 0) {
          return [
            {
              kind: 'status',
              label: 'No slow queries recorded yet',
              description: 'Run queries then refresh',
              tooltip: 'No statements found in server slow query stats',
              icon: 'check',
              commandId: REFRESH_SLOW_QUERIES_COMMAND,
            },
          ];
        }
        return this.state.entries.map((entry) => ({
          kind: 'entry',
          entry,
        }));
    }
  }

  async promptConfigureIfMissing(): Promise<boolean> {
    return this.onConfigureConnectionRequested();
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}
