import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => {
  class MockEventEmitter {
    event = vi.fn();
    fire = vi.fn();
    dispose = vi.fn();
  }

  class MockTreeItem {
    description?: string;
    tooltip?: unknown;
    iconPath?: unknown;
    contextValue?: string;
    command?: unknown;

    constructor(
      public readonly label: string,
      public readonly collapsibleState: number,
    ) {}
  }

  class MockMarkdownString {
    value = '';
    appendMarkdown(text: string): void {
      this.value += text;
    }
    appendCodeblock(code: string): void {
      this.value += `\n${code}\n`;
    }
  }

  class MockThemeIcon {
    constructor(
      public readonly id: string,
      public readonly color?: unknown,
    ) {}
  }

  class MockThemeColor {
    constructor(public readonly id: string) {}
  }

  return {
    EventEmitter: MockEventEmitter,
    TreeItem: MockTreeItem,
    TreeItemCollapsibleState: {
      None: 0,
      Collapsed: 1,
      Expanded: 2,
    },
    MarkdownString: MockMarkdownString,
    ThemeIcon: MockThemeIcon,
    ThemeColor: MockThemeColor,
  };
});

import type * as vscode from 'vscode';
import type { LoggerPort } from '@query-autopsy/core';
import type { DiscoveredTraceFile } from '../../src/infrastructure/vscode/workspaceTraceDiscovery.js';
import {
  ESTIMATE_TRACE_QUERY_COMMAND,
  OPEN_TRACE_FILE_COMMAND,
  OPEN_TRACE_SOURCE_COMMAND,
  TraceExplorerTreeProvider,
} from '../../src/presentation/vscode/views/traceExplorerTreeProvider.js';

function createFakeUri(fsPath: string): vscode.Uri {
  return {
    scheme: 'file',
    fsPath,
    toString: () => `file://${fsPath}`,
  } as unknown as vscode.Uri;
}

const silentLogger: LoggerPort = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe('TraceExplorerTreeProvider', () => {
  it('renders helpful empty state when no .query-autopsy/traces.jsonl exists', async () => {
    const provider = new TraceExplorerTreeProvider({
      discoverFiles: async () => [],
      readTraceFile: async () => '',
      resolveSourceTarget: async () => undefined,
      onInspectCandidate: vi.fn(),
      onOpenSource: vi.fn(),
      getConfig: () => ({
        nPlusOneThreshold: 3,
        slowQueryMsThreshold: 200,
        redactLiterals: true,
      }),
      logger: silentLogger,
    });

    await provider.refresh();
    const roots = provider.getChildren();
    expect(roots).toHaveLength(1);
    expect(roots[0]?.kind).toBe('status');

    const item = provider.getTreeItem(roots[0]!);
    expect(item.label).toContain('No .query-autopsy/traces.jsonl');
    expect((item.command as { command: string }).command).toBe(
      OPEN_TRACE_FILE_COMMAND,
    );
    provider.dispose();
  });

  it('surfaces N+1 & slow diagnostics, resolves safe file:line jumps, and forwards recorded bindings to 1-click EXPLAIN', async () => {
    const onInspectCandidate = vi.fn().mockResolvedValue(undefined);
    const onOpenSource = vi.fn().mockResolvedValue(undefined);
    const traceFile: DiscoveredTraceFile = {
      uri: createFakeUri('/repo/.query-autopsy/traces.jsonl'),
      relativePath: '.query-autopsy/traces.jsonl',
      folderUri: createFakeUri('/repo'),
      folderName: 'repo',
    };

    const jsonl = [
      ...Array.from({ length: 4 }, (_, idx) =>
        JSON.stringify({
          engine: 'postgresql',
          sql: 'SELECT * FROM order_items WHERE order_id = $1',
          bindings: [idx + 1],
          durationMs: 4.5,
          requestId: 'req-order-1',
          file: 'app/Http/Controllers/OrderController.php',
          line: 42,
        }),
      ),
      JSON.stringify({
        engine: 'postgresql',
        sql: "SELECT count(*) FROM audit_logs WHERE email = 'ceo@corp.com'",
        durationMs: 380,
        requestId: 'req-report-2',
      }),
    ].join('\n');

    const provider = new TraceExplorerTreeProvider({
      discoverFiles: async () => [traceFile],
      readTraceFile: async () => jsonl,
      resolveSourceTarget: async (rawFile, line) =>
        rawFile === 'app/Http/Controllers/OrderController.php'
          ? {
              uri: createFakeUri('/repo/app/Http/Controllers/OrderController.php'),
              line: line ?? 1,
            }
          : undefined,
      onInspectCandidate,
      onOpenSource,
      getConfig: () => ({
        nPlusOneThreshold: 3,
        slowQueryMsThreshold: 200,
        redactLiterals: true,
      }),
      logger: silentLogger,
    });

    await provider.refresh();

    const roots = provider.getChildren();
    expect(roots.map((n) => n.kind)).toEqual(['summary', 'group', 'group']);

    const diagnosticsGroup = roots[1]!;
    const findingNodes = provider.getChildren(diagnosticsGroup);
    expect(findingNodes).toHaveLength(2);

    const n1Node = findingNodes[0]!;
    const slowNode = findingNodes[1]!;
    expect(n1Node.kind).toBe('finding');
    expect(slowNode.kind).toBe('finding');

    // N+1 finding with valid workspace source jumps on click & exposes traceFindingWithLocation
    const n1Item = provider.getTreeItem(n1Node);
    expect(n1Item.label).toContain('N+1 (4×)');
    expect(n1Item.contextValue).toBe('traceFindingWithLocation');
    expect((n1Item.command as { command: string }).command).toBe(
      OPEN_TRACE_SOURCE_COMMAND,
    );

    // Slow finding without source location runs estimate EXPLAIN on click & scrubs PII
    const slowItem = provider.getTreeItem(slowNode);
    expect(slowItem.label).toContain('Slow (380.0ms)');
    expect(slowItem.contextValue).toBe('traceFinding');
    expect((slowItem.command as { command: string }).command).toBe(
      ESTIMATE_TRACE_QUERY_COMMAND,
    );
    expect(String(slowItem.label)).not.toContain('ceo@corp.com');

    // Trigger source jump and EXPLAIN inspection (forwarding recorded bindings!)
    await provider.handleOpenSource(n1Node);
    expect(onOpenSource).toHaveBeenCalledWith({
      uri: expect.objectContaining({
        fsPath: '/repo/app/Http/Controllers/OrderController.php',
      }),
      line: 42,
    });

    await provider.handleInspect(n1Node, 'estimate');
    expect(onInspectCandidate).toHaveBeenCalledWith(
      'SELECT * FROM order_items WHERE order_id = $1',
      [1],
      'estimate',
    );

    provider.dispose();
  });

  it('groups multiple workspace trace files cleanly at root level', async () => {
    const fileA: DiscoveredTraceFile = {
      uri: createFakeUri('/repo/api/.query-autopsy/traces.jsonl'),
      relativePath: 'api/.query-autopsy/traces.jsonl',
      folderUri: createFakeUri('/repo/api'),
      folderName: 'api',
    };
    const fileB: DiscoveredTraceFile = {
      uri: createFakeUri('/repo/worker/.query-autopsy/traces.jsonl'),
      relativePath: 'worker/.query-autopsy/traces.jsonl',
      folderUri: createFakeUri('/repo/worker'),
      folderName: 'worker',
    };

    const provider = new TraceExplorerTreeProvider({
      discoverFiles: async () => [fileA, fileB],
      readTraceFile: async () =>
        JSON.stringify({ sql: 'SELECT 1', durationMs: 1.0, requestId: 'r1' }),
      resolveSourceTarget: async () => undefined,
      onInspectCandidate: vi.fn(),
      onOpenSource: vi.fn(),
      getConfig: () => ({
        nPlusOneThreshold: 3,
        slowQueryMsThreshold: 200,
        redactLiterals: true,
      }),
      logger: silentLogger,
    });

    await provider.refresh();
    const roots = provider.getChildren();
    expect(roots).toHaveLength(2);
    expect(roots[0]?.kind).toBe('traceFile');
    expect(roots[1]?.kind).toBe('traceFile');

    const childrenA = provider.getChildren(roots[0]);
    expect(childrenA.map((n) => n.kind)).toEqual(['summary', 'group', 'group']);
    provider.dispose();
  });
});
