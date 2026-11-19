import * as vscode from 'vscode';
import type { ExplainMode } from '../../../domain/models/queryRequest.js';
import { extractSqlBlocks } from '../../../domain/services/sqlBlockExtractor.js';

export const INSPECT_CODELENS_COMMAND = 'queryAutopsy.inspectCodeLens';

export interface CodeLensInspectArgs {
  readonly sql: string;
  readonly mode: ExplainMode;
  readonly uri: string;
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

export class SqlCodeLensProvider
  implements vscode.CodeLensProvider, vscode.Disposable
{
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly configSub: vscode.Disposable;

  readonly onDidChangeCodeLenses = this.changeEmitter.event;

  constructor() {
    this.configSub = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('queryAutopsy.codeLens.enabled')) {
        this.changeEmitter.fire();
      }
    });
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const enabled = vscode.workspace
      .getConfiguration('queryAutopsy')
      .get<boolean>('codeLens.enabled', true);
    if (!enabled) {
      return [];
    }

    const blocks = extractSqlBlocks(
      document.getText(),
      document.languageId,
      document.fileName,
    );

    const lenses: vscode.CodeLens[] = [];
    const uriStr = document.uri.toString();

    for (const block of blocks) {
      const anchorRange = new vscode.Range(
        block.startLine,
        block.startColumn,
        block.startLine,
        block.startColumn,
      );

      const baseArgs = {
        sql: block.sql,
        uri: uriStr,
        startLine: block.startLine,
        startColumn: block.startColumn,
        endLine: block.endLine,
        endColumn: block.endColumn,
      };

      lenses.push(
        new vscode.CodeLens(anchorRange, {
          title: '$(play) Inspect Plan (ANALYZE)',
          tooltip: 'Run EXPLAIN (ANALYZE, BUFFERS) inside a safe ROLLBACK transaction',
          command: INSPECT_CODELENS_COMMAND,
          arguments: [
            { ...baseArgs, mode: 'analyze' } satisfies CodeLensInspectArgs,
          ],
        }),
        new vscode.CodeLens(anchorRange, {
          title: '$(eye) Estimate Plan',
          tooltip: 'Compute estimated EXPLAIN plan without executing the query',
          command: INSPECT_CODELENS_COMMAND,
          arguments: [
            { ...baseArgs, mode: 'estimate' } satisfies CodeLensInspectArgs,
          ],
        }),
      );
    }

    return lenses;
  }

  dispose(): void {
    this.configSub.dispose();
    this.changeEmitter.dispose();
  }
}
