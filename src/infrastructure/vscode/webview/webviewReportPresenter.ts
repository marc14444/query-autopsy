import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { InspectionReport } from '../../../domain/models/diagnostic.js';
import type { ExplainMode } from '../../../domain/models/queryRequest.js';
import type { LoggerPort } from '../../../domain/ports/outbound/loggerPort.js';
import type { ReportPresenterPort } from '../../../domain/ports/outbound/reportPresenterPort.js';
import type {
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
} from './contracts.js';
import { buildWebviewHtml } from './webviewHtml.js';

export type RerunQueryHandler = (
  sql: string,
  mode: ExplainMode,
) => Promise<void>;

function parseWebviewMessage(
  raw: unknown,
): WebviewToExtensionMessage | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const msg = raw as Record<string, unknown>;
  if (msg['type'] === 'READY') {
    return { type: 'READY' };
  }
  if (
    msg['type'] === 'COPY_SQL' &&
    typeof msg['payload'] === 'object' &&
    msg['payload'] !== null
  ) {
    const payload = msg['payload'] as Record<string, unknown>;
    if (typeof payload['sql'] === 'string') {
      return { type: 'COPY_SQL', payload: { sql: payload['sql'] } };
    }
  }
  if (
    msg['type'] === 'RERUN_QUERY' &&
    typeof msg['payload'] === 'object' &&
    msg['payload'] !== null
  ) {
    const payload = msg['payload'] as Record<string, unknown>;
    const mode = payload['mode'];
    if (
      typeof payload['sql'] === 'string' &&
      (mode === 'analyze' || mode === 'estimate')
    ) {
      return {
        type: 'RERUN_QUERY',
        payload: { sql: payload['sql'], mode },
      };
    }
  }
  return undefined;
}

export class WebviewReportPresenter implements ReportPresenterPort {
  private panel: vscode.WebviewPanel | undefined;
  private latestReport: InspectionReport | undefined;
  private isWebviewReady = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly logger: LoggerPort,
    private readonly onRerunQuery?: RerunQueryHandler,
  ) {}

  async present(report: InspectionReport): Promise<void> {
    this.latestReport = report;
    const panel = this.ensurePanel();
    panel.reveal(vscode.ViewColumn.Beside, true);

    if (this.isWebviewReady) {
      await this.postReport(panel, report);
    }
  }

  private ensurePanel(): vscode.WebviewPanel {
    if (this.panel) {
      return this.panel;
    }

    const webviewRoot = vscode.Uri.joinPath(
      this.extensionUri,
      'dist',
      'webview',
    );
    const panel = vscode.window.createWebviewPanel(
      'queryAutopsy.planView',
      'QueryAutopsy: Execution Plan',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [webviewRoot],
      },
    );

    const nonce = randomBytes(16).toString('hex');
    const scriptUri = panel.webview
      .asWebviewUri(vscode.Uri.joinPath(webviewRoot, 'main.js'))
      .toString();
    const styleUri = panel.webview
      .asWebviewUri(vscode.Uri.joinPath(webviewRoot, 'styles.css'))
      .toString();

    panel.webview.html = buildWebviewHtml({
      cspSource: panel.webview.cspSource,
      nonce,
      scriptUri,
      styleUri,
    });

    this.isWebviewReady = false;

    panel.webview.onDidReceiveMessage(async (rawMessage: unknown) => {
      await this.handleMessage(panel, rawMessage);
    });

    panel.onDidDispose(() => {
      this.panel = undefined;
      this.isWebviewReady = false;
    });

    this.panel = panel;
    return panel;
  }

  private async handleMessage(
    panel: vscode.WebviewPanel,
    rawMessage: unknown,
  ): Promise<void> {
    const message = parseWebviewMessage(rawMessage);
    if (!message) {
      this.logger.warn('Ignored invalid message from QueryAutopsy Webview');
      return;
    }

    switch (message.type) {
      case 'READY': {
        this.isWebviewReady = true;
        if (this.latestReport) {
          await this.postReport(panel, this.latestReport);
        }
        break;
      }
      case 'COPY_SQL': {
        await vscode.env.clipboard.writeText(message.payload.sql);
        void vscode.window.showInformationMessage(
          'QueryAutopsy: Copied SQL to clipboard.',
        );
        break;
      }
      case 'RERUN_QUERY': {
        if (!this.onRerunQuery) {
          return;
        }
        try {
          await this.onRerunQuery(message.payload.sql, message.payload.mode);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.error('Webview re-run failed', { message: msg });
          void vscode.window.showErrorMessage(`QueryAutopsy: ${msg}`);
        }
        break;
      }
    }
  }

  private async postReport(
    panel: vscode.WebviewPanel,
    report: InspectionReport,
  ): Promise<void> {
    const msg: ExtensionToWebviewMessage = {
      type: 'RENDER_REPORT',
      payload: report,
    };
    await panel.webview.postMessage(msg);
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
    this.isWebviewReady = false;
  }
}
