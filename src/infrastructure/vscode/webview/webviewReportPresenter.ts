import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { InspectionReport } from '../../../domain/models/diagnostic.js';
import type { ExplainMode } from '../../../domain/models/queryRequest.js';
import type { SimulateIndexResult } from '../../../domain/ports/inbound/simulateIndexUseCase.js';
import type { LoggerPort } from '../../../domain/ports/outbound/loggerPort.js';
import type { ReportPresenterPort } from '../../../domain/ports/outbound/reportPresenterPort.js';
import { formatMarkdownPrReport } from '../../../domain/services/markdownReportFormatter.js';
import { buildNodeExplanationMap } from '../../../domain/services/nodeExplainer.js';
import {
  computePlanDiff,
  normalizeSqlFingerprint,
  type PlanComparisonSummary,
} from '../../../domain/services/planDiff.js';
import type {
  BaselineRunOption,
  ExtensionToWebviewMessage,
  WebviewRenderPayload,
  WebviewToExtensionMessage,
} from './contracts.js';
import { buildWebviewHtml } from './webviewHtml.js';

export type RerunQueryHandler = (
  sql: string,
  mode: ExplainMode,
) => Promise<void>;

export type SimulateIndexHandler = (
  querySql: string,
  indexSql: string,
  baselineCost: number,
) => Promise<SimulateIndexResult>;

const MAX_HISTORY_PER_QUERY = 5;

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
  if (msg['type'] === 'COPY_MARKDOWN_REPORT') {
    return { type: 'COPY_MARKDOWN_REPORT' };
  }
  if (
    msg['type'] === 'SELECT_BASELINE' &&
    typeof msg['payload'] === 'object' &&
    msg['payload'] !== null
  ) {
    const payload = msg['payload'] as Record<string, unknown>;
    if (
      typeof payload['index'] === 'number' &&
      Number.isInteger(payload['index'])
    ) {
      return {
        type: 'SELECT_BASELINE',
        payload: { index: payload['index'] },
      };
    }
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
    msg['type'] === 'SIMULATE_INDEX' &&
    typeof msg['payload'] === 'object' &&
    msg['payload'] !== null
  ) {
    const payload = msg['payload'] as Record<string, unknown>;
    if (
      typeof payload['querySql'] === 'string' &&
      typeof payload['indexSql'] === 'string'
    ) {
      return {
        type: 'SIMULATE_INDEX',
        payload: {
          querySql: payload['querySql'],
          indexSql: payload['indexSql'],
        },
      };
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
  private latestComparison: PlanComparisonSummary | undefined;
  private selectedBaselineIndex: number | undefined;
  private readonly historyBySql = new Map<string, InspectionReport[]>();
  private isWebviewReady = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly logger: LoggerPort,
    private readonly onRerunQuery?: RerunQueryHandler,
    private readonly onSimulateIndex?: SimulateIndexHandler,
  ) {}

  async present(report: InspectionReport): Promise<void> {
    this.latestReport = report;
    const key = normalizeSqlFingerprint(report.sql);
    const existing = this.historyBySql.get(key) ?? [];
    const updated = [...existing, report].slice(-MAX_HISTORY_PER_QUERY);
    this.historyBySql.set(key, updated);

    // Default comparison against the previous run (index length - 2)
    this.selectedBaselineIndex =
      updated.length >= 2 ? updated.length - 2 : undefined;

    const panel = this.ensurePanel();
    panel.reveal(vscode.ViewColumn.Beside, true);

    if (this.isWebviewReady) {
      await this.postCurrentRenderPayload(panel);
    }
  }

  private buildRenderPayload(
    report: InspectionReport,
  ): WebviewRenderPayload {
    const key = normalizeSqlFingerprint(report.sql);
    const runs = this.historyBySql.get(key) ?? [report];
    const previousRunsCount = Math.max(0, runs.length - 1);

    const baselineOptions: BaselineRunOption[] = runs
      .slice(0, previousRunsCount)
      .map((run, idx) => {
        const timeStr = new Date(run.inspectedAtIso).toLocaleTimeString();
        const metric =
          run.plan.executionTimeMs !== undefined
            ? `${run.plan.executionTimeMs.toFixed(2)} ms`
            : `cost ${run.plan.root.totalCost.toFixed(1)}`;
        return {
          index: idx,
          label: `Run #${idx + 1} (${timeStr} — ${metric})`,
        };
      });

    let comparison: PlanComparisonSummary | undefined;
    let validBaselineIdx = this.selectedBaselineIndex;
    if (
      validBaselineIdx !== undefined &&
      validBaselineIdx >= 0 &&
      validBaselineIdx < previousRunsCount
    ) {
      const baselineRun = runs[validBaselineIdx];
      if (baselineRun) {
        comparison = computePlanDiff(baselineRun, report);
      }
    } else {
      validBaselineIdx = undefined;
    }

    this.latestComparison = comparison;

    return {
      report,
      nodeExplanations: buildNodeExplanationMap(report.plan),
      comparison,
      baselineOptions,
      selectedBaselineIndex: validBaselineIdx,
    };
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
          await this.postCurrentRenderPayload(panel);
        }
        break;
      }
      case 'SELECT_BASELINE': {
        this.selectedBaselineIndex = message.payload.index;
        if (this.latestReport) {
          await this.postCurrentRenderPayload(panel);
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
      case 'COPY_MARKDOWN_REPORT': {
        if (!this.latestReport) {
          return;
        }
        const markdown = formatMarkdownPrReport(
          this.latestReport,
          this.latestComparison,
        );
        await vscode.env.clipboard.writeText(markdown);
        void vscode.window.showInformationMessage(
          'QueryAutopsy: Copied Markdown PR report to clipboard.',
        );
        break;
      }
      case 'SIMULATE_INDEX': {
        if (!this.onSimulateIndex || !this.latestReport) {
          return;
        }
        try {
          const result = await this.onSimulateIndex(
            message.payload.querySql,
            message.payload.indexSql,
            this.latestReport.plan.root.totalCost,
          );
          const simMsg: ExtensionToWebviewMessage = {
            type: 'SIMULATION_RESULT',
            payload: result,
          };
          await panel.webview.postMessage(simMsg);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.error('HypoPG simulation failed', { message: msg });
          await panel.webview.postMessage({
            type: 'SIMULATION_RESULT',
            payload: {
              supported: false,
              indexSql: message.payload.indexSql,
              message: msg,
            },
          } satisfies ExtensionToWebviewMessage);
        }
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

  private async postCurrentRenderPayload(
    panel: vscode.WebviewPanel,
  ): Promise<void> {
    if (!this.latestReport) {
      return;
    }
    const msg: ExtensionToWebviewMessage = {
      type: 'RENDER_REPORT',
      payload: this.buildRenderPayload(this.latestReport),
    };
    await panel.webview.postMessage(msg);
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
    this.isWebviewReady = false;
  }
}
