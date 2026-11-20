import type {
  DiagnosticFinding,
  DiagnosticSeverity,
  ExplainMode,
  InspectionReport,
} from '@query-autopsy/core';
import * as vscode from 'vscode';

export const COPY_SUGGESTED_INDEX_COMMAND = 'queryAutopsy.copySuggestedIndex';
export const APPLY_SUGGESTED_INDEX_COMMAND = 'queryAutopsy.applySuggestedIndex';

export interface ApplySuggestedIndexArgs {
  readonly indexSql: string;
  readonly querySql: string;
  readonly mode: ExplainMode;
  readonly uri: string;
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

interface StoredFindingMetadata {
  readonly range: vscode.Range;
  readonly querySql: string;
  readonly mode: ExplainMode;
  readonly finding: DiagnosticFinding;
}

function toVsCodeSeverity(
  severity: DiagnosticSeverity,
): vscode.DiagnosticSeverity {
  switch (severity) {
    case 'critical':
      return vscode.DiagnosticSeverity.Error;
    case 'warning':
      return vscode.DiagnosticSeverity.Warning;
    case 'info':
      return vscode.DiagnosticSeverity.Information;
  }
}

function linesOverlap(a: vscode.Range, b: vscode.Range): boolean {
  return a.end.line >= b.start.line && a.start.line <= b.end.line;
}

export class EditorDiagnosticsManager implements vscode.Disposable {
  private readonly collection: vscode.DiagnosticCollection;
  private readonly storedByUri = new Map<string, StoredFindingMetadata[]>();
  private readonly closeSub: vscode.Disposable;

  constructor(private readonly isReadOnlyLocked: () => boolean = () => false) {
    this.collection = vscode.languages.createDiagnosticCollection('queryAutopsy');
    this.closeSub = vscode.workspace.onDidCloseTextDocument((doc) => {
      const key = doc.uri.toString();
      this.storedByUri.delete(key);
      this.collection.delete(doc.uri);
    });
  }

  applyReport(
    uri: vscode.Uri,
    range: vscode.Range,
    report: InspectionReport,
  ): void {
    const uriKey = uri.toString();
    const existing = this.storedByUri.get(uriKey) ?? [];

    // Replace previous findings overlapping this inspected SQL block
    const retained = existing.filter(
      (entry) => entry.range.intersection(range) === undefined,
    );

    const added: StoredFindingMetadata[] = report.diagnostics.map(
      (finding) => ({
        range,
        querySql: report.sql,
        mode: report.mode,
        finding,
      }),
    );

    const nextEntries = [...retained, ...added];
    if (nextEntries.length === 0) {
      this.storedByUri.delete(uriKey);
      this.collection.delete(uri);
      return;
    }

    this.storedByUri.set(uriKey, nextEntries);

    const vsDiagnostics = nextEntries.map(({ range: entryRange, finding }) => {
      const msg = finding.indexSuggestion
        ? `${finding.title} — ${finding.indexSuggestion.sql}`
        : `${finding.title} — ${finding.recommendation}`;
      const diag = new vscode.Diagnostic(
        entryRange,
        msg,
        toVsCodeSeverity(finding.severity),
      );
      diag.source = 'QueryAutopsy';
      diag.code = finding.ruleId;
      return diag;
    });

    this.collection.set(uri, vsDiagnostics);
  }

  createCodeActionProvider(): vscode.CodeActionProvider {
    return {
      provideCodeActions: (document, range, context) => {
        if (
          context.only &&
          !vscode.CodeActionKind.QuickFix.contains(context.only) &&
          !context.only.contains(vscode.CodeActionKind.QuickFix)
        ) {
          return [];
        }

        const entries = this.storedByUri.get(document.uri.toString());
        if (!entries || entries.length === 0) {
          return [];
        }

        const activeDiagnostics =
          this.collection
            .get(document.uri)
            ?.filter((diag) => diag.source === 'QueryAutopsy') ?? [];

        const actions: vscode.CodeAction[] = [];
        const seenSql = new Set<string>();

        for (const entry of entries) {
          if (!linesOverlap(entry.range, range)) {
            continue;
          }
          const indexSql = entry.finding.indexSuggestion?.sql;
          if (!indexSql || seenSql.has(indexSql)) {
            continue;
          }
          seenSql.add(indexSql);

          const matchingDiags = activeDiagnostics.filter((diag) =>
            linesOverlap(diag.range, entry.range),
          );

          const copyAction = new vscode.CodeAction(
            `QueryAutopsy: Copy index SQL (${indexSql})`,
            vscode.CodeActionKind.QuickFix,
          );
          copyAction.diagnostics = matchingDiags;
          copyAction.command = {
            command: COPY_SUGGESTED_INDEX_COMMAND,
            title: 'Copy Suggested Index SQL',
            arguments: [indexSql],
          };

          if (!this.isReadOnlyLocked()) {
            const applyAction = new vscode.CodeAction(
              `QueryAutopsy: Create index & re-analyze (${indexSql})`,
              vscode.CodeActionKind.QuickFix,
            );
            applyAction.isPreferred = entry.finding.severity === 'critical';
            applyAction.diagnostics = matchingDiags;
            applyAction.command = {
              command: APPLY_SUGGESTED_INDEX_COMMAND,
              title: 'Create Index on PostgreSQL & Re-analyze',
              arguments: [
                {
                  indexSql,
                  querySql: entry.querySql,
                  mode: entry.mode,
                  uri: document.uri.toString(),
                  startLine: entry.range.start.line,
                  startColumn: entry.range.start.character,
                  endLine: entry.range.end.line,
                  endColumn: entry.range.end.character,
                } satisfies ApplySuggestedIndexArgs,
              ],
            };
            actions.push(applyAction);
          }

          actions.push(copyAction);
        }

        return actions;
      },
    };
  }

  dispose(): void {
    this.closeSub.dispose();
    this.collection.dispose();
    this.storedByUri.clear();
  }
}
