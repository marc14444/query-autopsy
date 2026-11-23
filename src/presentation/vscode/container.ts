import {
  ApplyIndexService,
  type ExplainMode,
  FetchSlowQueriesService,
  type InspectionReport,
  InspectQueryService,
  MissingParametersError,
  SimulateIndexService,
  type SlowQueryEntry,
} from '@query-autopsy/core';
import {
  MultiEngineQueryExecutor,
  MultiEngineSlowQueryReader,
} from '@query-autopsy/executors';
import * as vscode from 'vscode';
import { CompositeReportPresenter } from '../../infrastructure/vscode/compositeReportPresenter.js';
import { OutputChannelLogger } from '../../infrastructure/vscode/logger.js';
import { OutputChannelReportPresenter } from '../../infrastructure/vscode/outputChannelPresenter.js';
import { VsCodeConnectionStore } from '../../infrastructure/vscode/vscodeConnectionStore.js';
import {
  discoverWorkspaceDatabaseConnections,
} from '../../infrastructure/vscode/workspaceEnvDiscovery.js';
import {
  discoverWorkspaceTraceFiles,
  readSafeWorkspaceTraceFile,
  type ResolvedTraceSourceTarget,
  resolveSafeWorkspaceSourceTarget,
} from '../../infrastructure/vscode/workspaceTraceDiscovery.js';
import {
  type RerunQueryHandler,
  WebviewReportPresenter,
} from '../../infrastructure/vscode/webview/webviewReportPresenter.js';
import {
  type CodeLensInspectArgs,
  INSPECT_CODELENS_COMMAND,
  SqlCodeLensProvider,
} from './codelens/sqlCodeLensProvider.js';
import {
  runAutoDetectConnectionCommand,
  runClearConnectionCommand,
  runConfigureConnectionCommand,
} from './commands/configureConnectionCommand.js';
import {
  CONFIGURE_MCP_COMMAND,
  runConfigureMcpCommand,
} from './commands/configureMcpCommand.js';
import {
  executeInspectionWithUi,
  type InspectionTarget,
  promptForParameters,
  runInspectCodeLensCommand,
  runInspectSelectionCommand,
} from './commands/inspectSelectionCommand.js';
import {
  APPLY_SUGGESTED_INDEX_COMMAND,
  type ApplySuggestedIndexArgs,
  COPY_SUGGESTED_INDEX_COMMAND,
  EditorDiagnosticsManager,
} from './diagnostics/editorDiagnosticsManager.js';
import { ConnectionStatusBar } from './statusbar/connectionStatusBar.js';
import {
  ESTIMATE_SLOW_QUERY_COMMAND,
  INSPECT_SLOW_QUERY_COMMAND,
  REFRESH_SLOW_QUERIES_COMMAND,
  SlowQueriesTreeProvider,
  type SlowQueryTreeNode,
  TOGGLE_SLOW_QUERY_SORT_COMMAND,
} from './views/slowQueriesTreeProvider.js';
import {
  ANALYZE_TRACE_QUERY_COMMAND,
  ESTIMATE_TRACE_QUERY_COMMAND,
  OPEN_TRACE_FILE_COMMAND,
  OPEN_TRACE_SOURCE_COMMAND,
  REFRESH_TRACES_COMMAND,
  TraceExplorerTreeProvider,
  type TraceTreeNode,
} from './views/traceExplorerTreeProvider.js';

export interface ExtensionContainer {
  dispose(): Promise<void>;
}

const SUPPORTED_DOCUMENT_SELECTORS: vscode.DocumentSelector = [
  { language: 'sql' },
  { language: 'postgres' },
  { language: 'pgsql' },
  { language: 'mysql' },
  { language: 'sqlite' },
  { language: 'mssql' },
  { language: 'typescript' },
  { language: 'javascript' },
  { language: 'typescriptreact' },
  { language: 'javascriptreact' },
  { language: 'python' },
  { language: 'go' },
  { language: 'php' },
  { pattern: '**/*.sql' },
  { pattern: '**/*.ipynb' },
];

/**
 * Guards all database-touching actions behind VS Code Workspace Trust to prevent
 * untrusted cloned repositories from triggering SSRF, .env harvesting, or DB writes.
 */
async function ensureWorkspaceTrusted(
  actionLabel: string,
  logger: OutputChannelLogger,
): Promise<boolean> {
  if (vscode.workspace.isTrusted) {
    return true;
  }

  logger.warn('Blocked database action in untrusted workspace', {
    action: actionLabel,
  });

  const choice = await vscode.window.showWarningMessage(
    `QueryAutopsy: "${actionLabel}" is disabled in Untrusted Workspaces to protect against untrusted .env files and unintended database connections.`,
    'Manage Workspace Trust',
  );
  if (choice === 'Manage Workspace Trust') {
    await vscode.commands.executeCommand('workbench.trust.manage');
  }
  return false;
}

/**
 * Composition Root wiring hexagonal ports, domain/application services, and VS Code adapters.
 */
export function createExtensionContainer(
  context: vscode.ExtensionContext,
): ExtensionContainer {
  const reportChannel = vscode.window.createOutputChannel('QueryAutopsy');
  const logChannel = vscode.window.createOutputChannel('QueryAutopsy Logs');

  const logger = new OutputChannelLogger(logChannel);
  const connectionConfig = new VsCodeConnectionStore(
    context.secrets,
    context.globalState,
  );
  const queryExecutor = new MultiEngineQueryExecutor(logger);
  const statusBar = new ConnectionStatusBar(connectionConfig);

  let activeProfileReadOnly = false;
  const syncProfileUiState = async (): Promise<void> => {
    const active = await connectionConfig.getActiveProfile();
    activeProfileReadOnly = active?.readOnlyLocked ?? false;
    await statusBar.refresh();
  };

  void syncProfileUiState();

  const diagnosticsManager = new EditorDiagnosticsManager(
    () => activeProfileReadOnly || !vscode.workspace.isTrusted,
  );
  const codeLensProvider = new SqlCodeLensProvider();

  const configureHandler = async (): Promise<boolean> => {
    if (!(await ensureWorkspaceTrusted('Configure Database Connection', logger))) {
      return false;
    }
    return runConfigureConnectionCommand(
      connectionConfig,
      queryExecutor,
      discoverWorkspaceDatabaseConnections,
      logger,
    );
  };

  let lastInspectionTarget: InspectionTarget | undefined;
  const handleReportProduced = (
    report: InspectionReport,
    target?: InspectionTarget,
  ): void => {
    if (target) {
      lastInspectionTarget = target;
      diagnosticsManager.applyReport(target.uri, target.range, report);
    }
  };

  const rerunHandlerRef: { current?: RerunQueryHandler | undefined } = {};

  const applyIndexUseCase = new ApplyIndexService({
    connectionConfig,
    queryExecutor,
    logger,
  });

  const simulateIndexUseCase = new SimulateIndexService({
    connectionConfig,
    queryExecutor,
    logger,
  });

  const webviewPresenter = new WebviewReportPresenter(
    context.extensionUri,
    logger,
    async (sql, mode) => {
      await rerunHandlerRef.current?.(sql, mode);
    },
    async (querySql, indexSql, baselineCost) => {
      if (!(await ensureWorkspaceTrusted('Simulate Hypothetical Index', logger))) {
        throw new Error(
          'Simulate Hypothetical Index is disabled in Untrusted Workspaces.',
        );
      }
      try {
        return await simulateIndexUseCase.execute({
          querySql,
          indexSql,
          baselineCost,
        });
      } catch (err) {
        if (err instanceof MissingParametersError) {
          const params = await promptForParameters(err.parameterIndices);
          if (params) {
            return simulateIndexUseCase.execute({
              querySql,
              indexSql,
              baselineCost,
              parameters: params,
            });
          }
        }
        throw err;
      }
    },
  );

  const outputPresenter = new OutputChannelReportPresenter(
    reportChannel,
    connectionConfig,
    { revealOnPresent: false },
  );

  const reportPresenter = new CompositeReportPresenter([
    webviewPresenter,
    outputPresenter,
  ]);

  const inspectQueryUseCase = new InspectQueryService({
    connectionConfig,
    queryExecutor,
    reportPresenter,
    logger,
  });

  const slowQueryReader = new MultiEngineSlowQueryReader(logger);
  const fetchSlowQueriesUseCase = new FetchSlowQueriesService({
    connectionConfig,
    slowQueryReader,
    logger,
  });

  const inspectSqlInTemporaryDocument = async (
    sql: string,
    mode: ExplainMode,
    preboundParameters?: readonly unknown[],
  ): Promise<void> => {
    const doc = await vscode.workspace.openTextDocument({
      language: 'sql',
      content: `${sql}\n`,
    });
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.One, false);
    const fullRange = new vscode.Range(
      new vscode.Position(0, 0),
      doc.lineAt(Math.max(0, doc.lineCount - 1)).range.end,
    );
    await executeInspectionWithUi(
      inspectQueryUseCase,
      sql,
      mode,
      configureHandler,
      logger,
      { uri: doc.uri, range: fullRange },
      handleReportProduced,
      preboundParameters,
    );
  };

  const inspectSlowQueryFromTree = async (
    entry: SlowQueryEntry,
    mode: ExplainMode,
  ): Promise<void> => inspectSqlInTemporaryDocument(entry.query, mode);

  const slowQueriesTreeProvider = new SlowQueriesTreeProvider(
    fetchSlowQueriesUseCase,
    inspectSlowQueryFromTree,
    configureHandler,
    logger,
    (actionLabel) => ensureWorkspaceTrusted(actionLabel, logger),
  );

  const openTraceSourceTarget = async (
    target: ResolvedTraceSourceTarget,
  ): Promise<void> => {
    const doc = await vscode.workspace.openTextDocument(target.uri);
    const editor = await vscode.window.showTextDocument(
      doc,
      vscode.ViewColumn.One,
      false,
    );
    const lineIdx = Math.max(
      0,
      Math.min(doc.lineCount - 1, target.line - 1),
    );
    const lineRange = doc.lineAt(lineIdx).range;
    editor.selection = new vscode.Selection(lineRange.start, lineRange.start);
    editor.revealRange(lineRange, vscode.TextEditorRevealType.InCenter);
  };

  const traceExplorerTreeProvider = new TraceExplorerTreeProvider({
    discoverFiles: discoverWorkspaceTraceFiles,
    readTraceFile: (file) =>
      readSafeWorkspaceTraceFile(
        file.uri,
        vscode.workspace.getWorkspaceFolder(file.uri)?.uri,
      ),
    resolveSourceTarget: resolveSafeWorkspaceSourceTarget,
    onInspectCandidate: async (sql, bindings, mode) => {
      if (!(await ensureWorkspaceTrusted('Inspect Trace Query Plan', logger))) {
        return;
      }
      await inspectSqlInTemporaryDocument(sql, mode, bindings);
    },
    onOpenSource: openTraceSourceTarget,
    getConfig: () => {
      const traceCfg = vscode.workspace.getConfiguration('queryAutopsy.traces');
      const privacyCfg = vscode.workspace.getConfiguration(
        'queryAutopsy.privacy',
      );
      return {
        nPlusOneThreshold: traceCfg.get<number>('nPlusOneThreshold', 3),
        slowQueryMsThreshold: traceCfg.get<number>('slowQueryMsThreshold', 200),
        redactLiterals: privacyCfg.get<boolean>('redactLiteralsInReports', false),
      };
    },
    logger,
  });

  const traceWatcher = vscode.workspace.createFileSystemWatcher(
    '**/.query-autopsy/*.{jsonl,ndjson}',
  );
  traceWatcher.onDidCreate(() => traceExplorerTreeProvider.scheduleRefresh());
  traceWatcher.onDidChange(() => traceExplorerTreeProvider.scheduleRefresh());
  traceWatcher.onDidDelete(() => traceExplorerTreeProvider.scheduleRefresh());

  rerunHandlerRef.current = async (sql, mode) => {
    if (!(await ensureWorkspaceTrusted('Re-run EXPLAIN Inspection', logger))) {
      return;
    }
    await executeInspectionWithUi(
      inspectQueryUseCase,
      sql,
      mode,
      configureHandler,
      logger,
      lastInspectionTarget,
      handleReportProduced,
    );
  };

  context.subscriptions.push(
    reportChannel,
    logChannel,
    connectionConfig,
    statusBar,
    diagnosticsManager,
    codeLensProvider,
    slowQueriesTreeProvider,
    traceExplorerTreeProvider,
    traceWatcher,
    vscode.window.registerTreeDataProvider(
      'queryAutopsy.slowQueries',
      slowQueriesTreeProvider,
    ),
    vscode.window.registerTreeDataProvider(
      'queryAutopsy.traces',
      traceExplorerTreeProvider,
    ),
    connectionConfig.onDidChangeProfile(() => {
      void syncProfileUiState();
      slowQueriesTreeProvider.resetToIdle();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('queryAutopsy.postgres')) {
        void syncProfileUiState();
      }
      if (
        event.affectsConfiguration('queryAutopsy.traces') ||
        event.affectsConfiguration('queryAutopsy.privacy')
      ) {
        traceExplorerTreeProvider.scheduleRefresh(150);
      }
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      void syncProfileUiState();
      slowQueriesTreeProvider.resetToIdle();
    }),
    vscode.languages.registerCodeLensProvider(
      SUPPORTED_DOCUMENT_SELECTORS,
      codeLensProvider,
    ),
    vscode.languages.registerCodeActionsProvider(
      SUPPORTED_DOCUMENT_SELECTORS,
      diagnosticsManager.createCodeActionProvider(),
      {
        providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
      },
    ),
    vscode.commands.registerCommand('queryAutopsy.inspectSelection', async () => {
      if (!(await ensureWorkspaceTrusted('Inspect Query (ANALYZE)', logger))) {
        return;
      }
      await runInspectSelectionCommand(
        inspectQueryUseCase,
        'analyze',
        configureHandler,
        logger,
        handleReportProduced,
      );
    }),
    vscode.commands.registerCommand(
      'queryAutopsy.inspectSelectionEstimate',
      async () => {
        if (!(await ensureWorkspaceTrusted('Estimate Query Plan', logger))) {
          return;
        }
        await runInspectSelectionCommand(
          inspectQueryUseCase,
          'estimate',
          configureHandler,
          logger,
          handleReportProduced,
        );
      },
    ),
    vscode.commands.registerCommand(
      INSPECT_CODELENS_COMMAND,
      async (args?: CodeLensInspectArgs) => {
        if (!(await ensureWorkspaceTrusted('Inspect CodeLens Query', logger))) {
          return;
        }
        await runInspectCodeLensCommand(
          inspectQueryUseCase,
          args,
          configureHandler,
          logger,
          handleReportProduced,
        );
      },
    ),
    vscode.commands.registerCommand(
      COPY_SUGGESTED_INDEX_COMMAND,
      async (sql?: string) => {
        if (typeof sql === 'string' && sql.trim().length > 0) {
          await vscode.env.clipboard.writeText(sql);
          void vscode.window.showInformationMessage(
            'QueryAutopsy: Copied suggested index SQL to clipboard.',
          );
        }
      },
    ),
    vscode.commands.registerCommand(
      APPLY_SUGGESTED_INDEX_COMMAND,
      async (args?: ApplySuggestedIndexArgs) => {
        if (!(await ensureWorkspaceTrusted('Create Suggested Index', logger))) {
          return;
        }
        if (!args || !args.indexSql.trim()) {
          return;
        }

        const confirm = await vscode.window.showWarningMessage(
          `Execute this index creation on your configured database?\n\n${args.indexSql}`,
          { modal: true },
          'Create Index & Re-analyze',
        );
        if (confirm !== 'Create Index & Re-analyze') {
          return;
        }

        try {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: 'QueryAutopsy: Creating suggested index...',
              cancellable: false,
            },
            async () => applyIndexUseCase.execute(args.indexSql),
          );

          void vscode.window.showInformationMessage(
            `QueryAutopsy: Created index (${args.indexSql})`,
          );

          const target: InspectionTarget = {
            uri: vscode.Uri.parse(args.uri),
            range: new vscode.Range(
              args.startLine,
              args.startColumn,
              args.endLine,
              args.endColumn,
            ),
          };

          await executeInspectionWithUi(
            inspectQueryUseCase,
            args.querySql,
            args.mode,
            configureHandler,
            logger,
            target,
            handleReportProduced,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error('Failed to create suggested index', { message });
          void vscode.window.showErrorMessage(`QueryAutopsy: ${message}`);
        }
      },
    ),
    vscode.commands.registerCommand(
      'queryAutopsy.configureConnection',
      configureHandler,
    ),
    vscode.commands.registerCommand('queryAutopsy.discoverConnections', async () => {
      if (!(await ensureWorkspaceTrusted('Auto-Detect Local Databases', logger))) {
        return;
      }
      await runAutoDetectConnectionCommand(
        connectionConfig,
        queryExecutor,
        discoverWorkspaceDatabaseConnections,
        logger,
      );
    }),
    vscode.commands.registerCommand('queryAutopsy.clearConnection', () =>
      runClearConnectionCommand(connectionConfig, logger),
    ),
    vscode.commands.registerCommand(REFRESH_SLOW_QUERIES_COMMAND, () =>
      slowQueriesTreeProvider.refresh(),
    ),
    vscode.commands.registerCommand(TOGGLE_SLOW_QUERY_SORT_COMMAND, () =>
      slowQueriesTreeProvider.toggleSortAndRefresh(),
    ),
    vscode.commands.registerCommand(
      INSPECT_SLOW_QUERY_COMMAND,
      async (node?: SlowQueryTreeNode) => {
        if (node?.kind === 'entry') {
          await slowQueriesTreeProvider.handleInspect(node.entry, 'analyze');
        }
      },
    ),
    vscode.commands.registerCommand(
      ESTIMATE_SLOW_QUERY_COMMAND,
      async (node?: SlowQueryTreeNode) => {
        if (node?.kind === 'entry') {
          await slowQueriesTreeProvider.handleInspect(node.entry, 'estimate');
        }
      },
    ),
    vscode.commands.registerCommand(REFRESH_TRACES_COMMAND, () =>
      traceExplorerTreeProvider.refresh(),
    ),
    vscode.commands.registerCommand(OPEN_TRACE_FILE_COMMAND, async () => {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        title: 'Select QueryAutopsy Trace File (.jsonl / .ndjson)',
        filters: {
          'JSONL Traces': ['jsonl', 'ndjson'],
        },
      });
      const uri = picked?.[0];
      if (!uri) {
        return;
      }
      const folder =
        vscode.workspace.getWorkspaceFolder(uri) ??
        vscode.workspace.workspaceFolders?.[0];
      traceExplorerTreeProvider.setCustomTraceFile({
        uri,
        relativePath: vscode.workspace.asRelativePath(uri, false),
        folderUri: folder?.uri ?? uri,
        folderName: folder?.name ?? 'Trace',
      });
      await traceExplorerTreeProvider.refresh();
    }),
    vscode.commands.registerCommand(
      OPEN_TRACE_SOURCE_COMMAND,
      async (node?: TraceTreeNode) => {
        await traceExplorerTreeProvider.handleOpenSource(node);
      },
    ),
    vscode.commands.registerCommand(
      ESTIMATE_TRACE_QUERY_COMMAND,
      async (node?: TraceTreeNode) => {
        await traceExplorerTreeProvider.handleInspect(node, 'estimate');
      },
    ),
    vscode.commands.registerCommand(
      ANALYZE_TRACE_QUERY_COMMAND,
      async (node?: TraceTreeNode) => {
        await traceExplorerTreeProvider.handleInspect(node, 'analyze');
      },
    ),
    vscode.commands.registerCommand(CONFIGURE_MCP_COMMAND, async () => {
      if (
        !(await ensureWorkspaceTrusted('Configure Safe AI MCP Server', logger))
      ) {
        return;
      }
      await runConfigureMcpCommand(connectionConfig, logger);
    }),
  );

  void traceExplorerTreeProvider.refresh();

  logger.info('QueryAutopsy extension activated');

  return {
    dispose: async () => {
      webviewPresenter.dispose();
      await queryExecutor.dispose();
    },
  };
}
