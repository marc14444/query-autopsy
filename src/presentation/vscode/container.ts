import * as vscode from 'vscode';
import { ApplyIndexService } from '../../application/usecases/applyIndexService.js';
import { FetchSlowQueriesService } from '../../application/usecases/fetchSlowQueriesService.js';
import { InspectQueryService } from '../../application/usecases/inspectQueryService.js';
import { SimulateIndexService } from '../../application/usecases/simulateIndexService.js';
import { MissingParametersError } from '../../domain/errors/domainErrors.js';
import type { InspectionReport } from '../../domain/models/diagnostic.js';
import type { ExplainMode } from '../../domain/models/queryRequest.js';
import type { SlowQueryEntry } from '../../domain/models/slowQuery.js';
import { MultiEngineQueryExecutor } from '../../infrastructure/database/multiEngineQueryExecutor.js';
import { MultiEngineSlowQueryReader } from '../../infrastructure/database/slowQueryReader.js';
import { CompositeReportPresenter } from '../../infrastructure/vscode/compositeReportPresenter.js';
import { OutputChannelLogger } from '../../infrastructure/vscode/logger.js';
import { OutputChannelReportPresenter } from '../../infrastructure/vscode/outputChannelPresenter.js';
import { VsCodeConnectionStore } from '../../infrastructure/vscode/vscodeConnectionStore.js';
import {
  type RerunQueryHandler,
  WebviewReportPresenter,
} from '../../infrastructure/vscode/webview/webviewReportPresenter.js';
import { discoverWorkspaceDatabaseConnections } from '../../infrastructure/vscode/workspaceEnvDiscovery.js';
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
  { pattern: '**/*.sql' },
];

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
    () => activeProfileReadOnly,
  );
  const codeLensProvider = new SqlCodeLensProvider();

  const configureHandler = () =>
    runConfigureConnectionCommand(
      connectionConfig,
      queryExecutor,
      discoverWorkspaceDatabaseConnections,
      logger,
    );

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

  const inspectSlowQueryFromTree = async (
    entry: SlowQueryEntry,
    mode: ExplainMode,
  ): Promise<void> => {
    const doc = await vscode.workspace.openTextDocument({
      language: 'sql',
      content: `${entry.query}\n`,
    });
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.One, false);
    const fullRange = new vscode.Range(
      new vscode.Position(0, 0),
      doc.lineAt(Math.max(0, doc.lineCount - 1)).range.end,
    );
    await executeInspectionWithUi(
      inspectQueryUseCase,
      entry.query,
      mode,
      configureHandler,
      logger,
      { uri: doc.uri, range: fullRange },
      handleReportProduced,
    );
  };

  const slowQueriesTreeProvider = new SlowQueriesTreeProvider(
    fetchSlowQueriesUseCase,
    inspectSlowQueryFromTree,
    configureHandler,
    logger,
  );

  rerunHandlerRef.current = async (sql, mode) => {
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
    vscode.window.registerTreeDataProvider(
      'queryAutopsy.slowQueries',
      slowQueriesTreeProvider,
    ),
    connectionConfig.onDidChangeProfile(() => {
      void syncProfileUiState();
      slowQueriesTreeProvider.resetToIdle();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('queryAutopsy.postgres')) {
        void syncProfileUiState();
      }
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
    vscode.commands.registerCommand('queryAutopsy.inspectSelection', () =>
      runInspectSelectionCommand(
        inspectQueryUseCase,
        'analyze',
        configureHandler,
        logger,
        handleReportProduced,
      ),
    ),
    vscode.commands.registerCommand(
      'queryAutopsy.inspectSelectionEstimate',
      () =>
        runInspectSelectionCommand(
          inspectQueryUseCase,
          'estimate',
          configureHandler,
          logger,
          handleReportProduced,
        ),
    ),
    vscode.commands.registerCommand(
      INSPECT_CODELENS_COMMAND,
      (args?: CodeLensInspectArgs) =>
        runInspectCodeLensCommand(
          inspectQueryUseCase,
          args,
          configureHandler,
          logger,
          handleReportProduced,
        ),
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
    vscode.commands.registerCommand('queryAutopsy.discoverConnections', () =>
      runAutoDetectConnectionCommand(
        connectionConfig,
        queryExecutor,
        discoverWorkspaceDatabaseConnections,
        logger,
      ),
    ),
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
  );

  logger.info('QueryAutopsy extension activated');

  return {
    dispose: async () => {
      webviewPresenter.dispose();
      await queryExecutor.dispose();
    },
  };
}
