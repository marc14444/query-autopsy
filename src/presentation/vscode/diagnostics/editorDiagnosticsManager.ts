import * as vscode from 'vscode';
import type {
  DiagnosticFinding,
  DiagnosticSeverity,
  InspectionReport,
} from '../../../domain/models/diagnostic.js';

export const COPY_SUGGESTED_INDEX_COMMAND = 'queryAutopsy.copySuggestedIndex';

interface StoredFindingMetadata {
  readonly range: vscode.Range;
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

export class EditorDiagnosticsManager implements vscode.Disposable {
  private readonly collection: vscode.DiagnosticCollection;
  private readonly storedByUri = new Map<string, StoredFindingMetadata[]>();
  private readonly closeSub: vscode.Disposable;

  constructor() {
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
        const entries = this.storedByUri.get(document.uri.toString());
        if (!entries || entries.length === 0) {
          return [];
        }

        const hasQueryAutopsyDiag = context.diagnostics.some(
          (diag) => diag.source === 'QueryAutopsy',
        );
        if (!hasQueryAutopsyDiag) {
          return [];
        }

        const actions: vscode.CodeAction[] = [];
        const seenSql = new Set<string>();

        for (const entry of entries) {
          if (entry.range.intersection(range) === undefined) {
            continue;
          }
          const indexSql = entry.finding.indexSuggestion?.sql;
          if (!indexSql || seenSql.has(indexSql)) {
            continue;
          }
          seenSql.add(indexSql);

          const action = new vscode.CodeAction(
            `QueryAutopsy: Copy index SQL (${indexSql})`,
            vscode.CodeActionKind.QuickFix,
          );
          action.isPreferred = entry.finding.severity === 'critical';
          action.command = {
            command: COPY_SUGGESTED_INDEX_COMMAND,
            title: 'Copy Suggested Index SQL',
            arguments: [indexSql],
          };
          actions.push(action);
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
