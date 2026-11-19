import * as vscode from 'vscode';
import {
  DomainError,
  MissingConnectionError,
  MissingParametersError,
} from '../../../domain/errors/domainErrors.js';
import type { InspectionReport } from '../../../domain/models/diagnostic.js';
import type { ExplainMode } from '../../../domain/models/queryRequest.js';
import type { InspectQueryUseCase } from '../../../domain/ports/inbound/inspectQueryUseCase.js';
import type { LoggerPort } from '../../../domain/ports/outbound/loggerPort.js';
import { extractSqlStatementSpanAtOffset } from '../../../domain/services/sqlClassifier.js';
import type { CodeLensInspectArgs } from '../codelens/sqlCodeLensProvider.js';

const SQL_LANGUAGE_IDS = new Set(['sql', 'postgres', 'pgsql', 'mssql']);

export interface InspectionTarget {
  readonly uri: vscode.Uri;
  readonly range: vscode.Range;
}

export type ReportProducedCallback = (
  report: InspectionReport,
  target?: InspectionTarget,
) => void;

function parseParameterInput(
  rawInput: string,
  expectedCount: number,
): readonly unknown[] | undefined {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return undefined;
  }

  // Support explicit JSON array input: [42, "pending"]
  if (trimmed.startsWith('[')) {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || parsed.length < expectedCount) {
      throw new Error(
        `Expected a JSON array with at least ${expectedCount} value(s).`,
      );
    }
    return parsed;
  }

  // Otherwise split comma-separated values and infer primitives safely
  const parts = trimmed.split(',').map((part) => {
    const token = part.trim();
    if (
      (token.startsWith("'") && token.endsWith("'")) ||
      (token.startsWith('"') && token.endsWith('"'))
    ) {
      return token.slice(1, -1);
    }
    if (token.toLowerCase() === 'null') {
      return null;
    }
    if (token.toLowerCase() === 'true') {
      return true;
    }
    if (token.toLowerCase() === 'false') {
      return false;
    }
    if (/^-?\d+(\.\d+)?$/.test(token)) {
      const num = Number(token);
      if (Number.isSafeInteger(num) || !Number.isInteger(num)) {
        return num;
      }
    }
    return token;
  });

  if (parts.length < expectedCount) {
    throw new Error(
      `Expected at least ${expectedCount} comma-separated value(s).`,
    );
  }

  return parts;
}

async function promptForParameters(
  indices: readonly number[],
): Promise<readonly unknown[] | undefined> {
  const highestIndex = indices[indices.length - 1] ?? 1;
  const placeholderList = Array.from(
    { length: highestIndex },
    (_, i) => `val${i + 1}`,
  ).join(', ');

  const raw = await vscode.window.showInputBox({
    title: 'QueryAutopsy: Query Parameters Required',
    prompt: `Enter values for ${indices.map((i) => `$${i}`).join(', ')} (comma-separated or JSON array e.g. [42, "pending"])`,
    placeHolder: placeholderList,
    ignoreFocusOut: true,
    validateInput: (val) => {
      try {
        const parsed = parseParameterInput(val, highestIndex);
        return parsed ? undefined : 'Enter parameter values.';
      } catch (err) {
        return err instanceof Error ? err.message : 'Invalid parameter input.';
      }
    },
  });

  if (!raw) {
    return undefined;
  }
  return parseParameterInput(raw, highestIndex);
}

function notifySummary(report: InspectionReport): void {
  const criticalCount = report.diagnostics.filter(
    (d) => d.severity === 'critical',
  ).length;
  const warningCount = report.diagnostics.filter(
    (d) => d.severity === 'warning',
  ).length;

  const timeStr =
    report.plan.executionTimeMs !== undefined
      ? `${report.plan.executionTimeMs.toFixed(2)}ms`
      : `est. cost ${report.plan.root.totalCost.toFixed(1)}`;

  if (criticalCount > 0) {
    void vscode.window.showWarningMessage(
      `QueryAutopsy (${timeStr}): ${criticalCount} critical, ${warningCount} warning(s) — see Execution Plan.`,
    );
  } else if (warningCount > 0) {
    void vscode.window.showInformationMessage(
      `QueryAutopsy (${timeStr}): ${warningCount} warning(s) — see Execution Plan.`,
    );
  } else {
    void vscode.window.showInformationMessage(
      `QueryAutopsy (${timeStr}): No bottlenecks detected.`,
    );
  }
}

export async function executeInspectionWithUi(
  useCase: InspectQueryUseCase,
  rawSql: string,
  mode: ExplainMode,
  onConfigureConnectionRequested: () => Promise<boolean>,
  logger: LoggerPort,
  target?: InspectionTarget,
  onReportProduced?: ReportProducedCallback,
): Promise<void> {
  const executeWithProgress = async (
    parameters?: readonly unknown[],
  ): Promise<InspectionReport> =>
    vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title:
          mode === 'analyze'
            ? 'QueryAutopsy: Running EXPLAIN (ANALYZE, BUFFERS)...'
            : 'QueryAutopsy: Computing EXPLAIN plan...',
        cancellable: false,
      },
      async () => useCase.execute({ rawSql, mode, parameters }),
    );

  try {
    const report = await executeWithProgress();
    onReportProduced?.(report, target);
    notifySummary(report);
  } catch (err) {
    if (err instanceof MissingConnectionError) {
      const action = await vscode.window.showErrorMessage(
        err.message,
        'Configure Connection',
      );
      if (action === 'Configure Connection') {
        const configured = await onConfigureConnectionRequested();
        if (configured) {
          await executeInspectionWithUi(
            useCase,
            rawSql,
            mode,
            onConfigureConnectionRequested,
            logger,
            target,
            onReportProduced,
          );
        }
      }
      return;
    }

    if (err instanceof MissingParametersError) {
      const params = await promptForParameters(err.parameterIndices);
      if (!params) {
        return;
      }
      try {
        const report = await executeWithProgress(params);
        onReportProduced?.(report, target);
        notifySummary(report);
      } catch (retryErr) {
        const msg =
          retryErr instanceof Error ? retryErr.message : String(retryErr);
        logger.error('Parameterized inspection failed', { message: msg });
        void vscode.window.showErrorMessage(`QueryAutopsy: ${msg}`);
      }
      return;
    }

    const message =
      err instanceof DomainError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);

    logger.error('Query inspection failed', { message });
    void vscode.window.showErrorMessage(`QueryAutopsy: ${message}`);
  }
}

export async function runInspectSelectionCommand(
  useCase: InspectQueryUseCase,
  mode: ExplainMode,
  onConfigureConnectionRequested: () => Promise<boolean>,
  logger: LoggerPort,
  onReportProduced?: ReportProducedCallback,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage(
      'Open an editor and select a SQL query to inspect.',
    );
    return;
  }

  const selection = editor.selection;
  let rawSql = editor.document.getText(selection);
  let targetRange: vscode.Range = new vscode.Range(
    selection.start,
    selection.end,
  );

  const isSqlDocument =
    SQL_LANGUAGE_IDS.has(editor.document.languageId) ||
    editor.document.fileName.toLowerCase().endsWith('.sql');

  if (!rawSql.trim() && selection.isEmpty && isSqlDocument) {
    const cursorOffset = editor.document.offsetAt(selection.active);
    const span = extractSqlStatementSpanAtOffset(
      editor.document.getText(),
      cursorOffset,
    );
    if (span) {
      rawSql = span.sql;
      targetRange = new vscode.Range(
        editor.document.positionAt(span.start),
        editor.document.positionAt(span.end),
      );
    }
  }

  if (!rawSql.trim()) {
    void vscode.window.showWarningMessage(
      'Select a complete SQL query (or place your cursor inside a statement in a .sql file) first.',
    );
    return;
  }

  await executeInspectionWithUi(
    useCase,
    rawSql,
    mode,
    onConfigureConnectionRequested,
    logger,
    { uri: editor.document.uri, range: targetRange },
    onReportProduced,
  );
}

export async function runInspectCodeLensCommand(
  useCase: InspectQueryUseCase,
  args: CodeLensInspectArgs | undefined,
  onConfigureConnectionRequested: () => Promise<boolean>,
  logger: LoggerPort,
  onReportProduced?: ReportProducedCallback,
): Promise<void> {
  if (!args || !args.sql.trim()) {
    return;
  }

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
    useCase,
    args.sql,
    args.mode,
    onConfigureConnectionRequested,
    logger,
    target,
    onReportProduced,
  );
}
