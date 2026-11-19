import * as vscode from 'vscode';
import { InspectQueryService } from '../../application/usecases/inspectQueryService.js';
import type { InspectionReport } from '../../domain/models/diagnostic.js';
import { PgQueryExecutor } from '../../infrastructure/postgres/pgQueryExecutor.js';
import { CompositeReportPresenter } from '../../infrastructure/vscode/compositeReportPresenter.js';
import { OutputChannelLogger } from '../../infrastructure/vscode/logger.js';
import { OutputChannelReportPresenter } from '../../infrastructure/vscode/outputChannelPresenter.js';
import { VsCodeConnectionStore } from '../../infrastructure/vscode/vscodeConnectionStore.js';
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
  runClearConnectionCommand,
  runConfigureConnectionCommand,
} from './commands/configureConnectionCommand.js';
import {
  executeInspectionWithUi,
  type InspectionTarget,
  runInspectCodeLensCommand,
  runInspectSelectionCommand,
} from './commands/inspectSelectionCommand.js';
import {
  COPY_SUGGESTED_INDEX_COMMAND,
  EditorDiagnosticsManager,
} from './diagnostics/editorDiagnosticsManager.js';

export interface ExtensionContainer {
  dispose(): Promise<void>;
}

const SUPPORTED_DOCUMENT_SELECTORS: vscode.DocumentSelector = [
  { language: 'sql' },
  { language: 'postgres' },
  { language: 'pgsql' },
  { language: 'mssql' },
  { language: 'typescript' },
  { language: 'javascript' },
  { language: 'typescriptreact' },
  { language: 'javascriptreact' },
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
  const connectionConfig = new VsCodeConnectionStore(context.secrets);
  const queryExecutor = new PgQueryExecutor(logger);
  const diagnosticsManager = new EditorDiagnosticsManager();
  const codeLensProvider = new SqlCodeLensProvider();

  const configureHandler = () =>
    runConfigureConnectionCommand(connectionConfig, queryExecutor, logger);

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

  const webviewPresenter = new WebviewReportPresenter(
    context.extensionUri,
    logger,
    async (sql, mode) => {
      await rerunHandlerRef.current?.(sql, mode);
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
    diagnosticsManager,
    codeLensProvider,
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
      'queryAutopsy.configureConnection',
      configureHandler,
    ),
    vscode.commands.registerCommand('queryAutopsy.clearConnection', () =>
      runClearConnectionCommand(connectionConfig, logger),
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
