import {
  classifySqlStatement,
  type DatabaseEngine,
  DomainError,
  type ExplainMode,
  extractSqlBlocks,
  extractSqlStatementSpanAtOffset,
  type InspectionReport,
  type InspectQueryUseCase,
  type LoggerPort,
  MissingConnectionError,
  MissingParametersError,
  QueryExecutionError,
} from '@query-autopsy/core';
import * as vscode from 'vscode';
import type { CodeLensInspectArgs } from '../codelens/sqlCodeLensProvider.js';

const SQL_LANGUAGE_IDS = new Set([
  'sql',
  'postgres',
  'pgsql',
  'mysql',
  'sqlite',
  'duckdb',
  'mssql',
]);

function resolveDocumentEngineHint(
  languageId: string,
  fileName: string,
): DatabaseEngine {
  const lowerLang = languageId.toLowerCase();
  const lowerFile = fileName.toLowerCase();
  if (lowerLang === 'mysql' || lowerFile.endsWith('.mysql.sql')) {
    return 'mysql';
  }
  if (lowerLang === 'sqlite' || lowerFile.endsWith('.sqlite.sql')) {
    return 'sqlite';
  }
  if (lowerLang === 'duckdb' || lowerFile.endsWith('.duckdb.sql')) {
    return 'duckdb';
  }
  return 'postgresql';
}

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

export async function promptForParameters(
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
  initialParameters?: readonly unknown[],
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
    const report = await executeWithProgress(initialParameters);
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
            initialParameters,
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

    if (
      err instanceof QueryExecutionError &&
      (err.sqlState === '28P01' || err.sqlState === '28000')
    ) {
      const action = await vscode.window.showErrorMessage(
        `QueryAutopsy: ${err.message}`,
        'Update Connection',
      );
      if (action === 'Update Connection') {
        await onConfigureConnectionRequested();
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
    SQL_LANGUAGE_IDS.has(editor.document.languageId.toLowerCase()) ||
    editor.document.fileName.toLowerCase().endsWith('.sql');
  const engineHint = resolveDocumentEngineHint(
    editor.document.languageId,
    editor.document.fileName,
  );

  if (!rawSql.trim() && selection.isEmpty && isSqlDocument) {
    const cursorOffset = editor.document.offsetAt(selection.active);
    const span = extractSqlStatementSpanAtOffset(
      editor.document.getText(),
      cursorOffset,
      engineHint,
    );
    if (span) {
      rawSql = span.sql;
      targetRange = new vscode.Range(
        editor.document.positionAt(span.start),
        editor.document.positionAt(span.end),
      );
    }
  } else if (rawSql.trim() && !selection.isEmpty && !isSqlDocument) {
    // If user selected surrounding TypeORM/Prisma/Python/Go code (e.g. `await queryRunner.query(\`SELECT ...\`)`),
    // unwrap automatically when the selection yields a single inspectable SQL query.
    let rawIsDirectSql = false;
    try {
      rawIsDirectSql = classifySqlStatement(rawSql, engineHint).kind !== 'UNKNOWN';
    } catch {
      rawIsDirectSql = false;
    }

    if (!rawIsDirectSql) {
      const extracted = extractSqlBlocks(
        rawSql,
        editor.document.languageId,
        editor.document.fileName,
      );
      if (extracted.length === 1) {
        const block = extracted[0]!;
        rawSql = block.sql;
        const startLine = selection.start.line + block.startLine;
        const startChar =
          block.startLine === 0
            ? selection.start.character + block.startColumn
            : block.startColumn;
        const endLine = selection.start.line + block.endLine;
        const endChar =
          block.endLine === 0
            ? selection.start.character + block.endColumn
            : block.endColumn;
        targetRange = new vscode.Range(startLine, startChar, endLine, endChar);
      }
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
