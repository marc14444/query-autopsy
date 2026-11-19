import type * as vscode from 'vscode';
import type {
  DiagnosticFinding,
  DiagnosticSeverity,
  InspectionReport,
} from '../../domain/models/diagnostic.js';
import type { PlanNode } from '../../domain/models/executionPlan.js';
import type { ConnectionConfigPort } from '../../domain/ports/outbound/connectionConfigPort.js';
import type { ReportPresenterPort } from '../../domain/ports/outbound/reportPresenterPort.js';

const SEVERITY_BADGE: Record<DiagnosticSeverity, string> = {
  critical: '[CRITICAL]',
  warning: '[WARNING]',
  info: '[INFO]',
};

export interface OutputChannelPresenterOptions {
  readonly revealOnPresent?: boolean;
}

export class OutputChannelReportPresenter implements ReportPresenterPort {
  constructor(
    private readonly channel: vscode.OutputChannel,
    private readonly connectionConfig: ConnectionConfigPort,
    private readonly options: OutputChannelPresenterOptions = {},
  ) {}

  async present(report: InspectionReport): Promise<void> {
    const { showRawJson } = this.connectionConfig.getRuntimeSettings();
    this.channel.clear();

    this.channel.appendLine(
      '========================================================================',
    );
    this.channel.appendLine(
      ` QueryAutopsy Report | Mode: ${report.mode.toUpperCase()} | Type: ${report.statementKind} | ${report.inspectedAtIso}`,
    );
    this.channel.appendLine(
      '========================================================================',
    );
    this.channel.appendLine('');

    this.writeSummary(report);
    this.writeDiagnostics(report.diagnostics);
    this.writePlanTree(report.plan.root, report.mode === 'analyze');

    if (showRawJson) {
      this.channel.appendLine('');
      this.channel.appendLine('--- RAW EXPLAIN JSON ---');
      this.channel.appendLine(JSON.stringify(report.plan.rawJson, null, 2));
    }

    if (this.options.revealOnPresent ?? true) {
      this.channel.show(true);
    }
  }

  private writeSummary(report: InspectionReport): void {
    const { plan } = report;
    const hitPct =
      plan.totalBuffers.cacheHitRatio !== null
        ? `${(plan.totalBuffers.cacheHitRatio * 100).toFixed(1)}%`
        : 'N/A';

    this.channel.appendLine('SUMMARY');
    this.channel.appendLine(
      `  Execution Time : ${plan.executionTimeMs !== undefined ? `${plan.executionTimeMs.toFixed(3)} ms` : 'N/A (estimate only)'}`,
    );
    this.channel.appendLine(
      `  Planning Time  : ${plan.planningTimeMs !== undefined ? `${plan.planningTimeMs.toFixed(3)} ms` : 'N/A'}`,
    );
    this.channel.appendLine(
      `  Total Cost     : ${plan.root.totalCost.toFixed(2)}`,
    );
    this.channel.appendLine(
      `  Buffers (exec) : hit=${plan.totalBuffers.sharedHitBlocks}, read=${plan.totalBuffers.sharedReadBlocks}, temp_written=${plan.totalBuffers.tempWrittenBlocks}, cache_hit=${hitPct}`,
    );
    this.channel.appendLine('');
  }

  private writeDiagnostics(diagnostics: readonly DiagnosticFinding[]): void {
    this.channel.appendLine(`DIAGNOSTICS (${diagnostics.length})`);
    if (diagnostics.length === 0) {
      this.channel.appendLine(
        '  [OK] No performance bottlenecks detected by current rules.',
      );
      this.channel.appendLine('');
      return;
    }

    for (const finding of diagnostics) {
      this.channel.appendLine(
        `  ${SEVERITY_BADGE[finding.severity]} [${finding.ruleId}] (node #${finding.nodeId}) ${finding.title}`,
      );
      this.channel.appendLine(`    Detail         : ${finding.detail}`);
      this.channel.appendLine(
        `    Recommendation : ${finding.recommendation}`,
      );
      if (finding.indexSuggestion) {
        this.channel.appendLine(
          `    Suggested SQL  : ${finding.indexSuggestion.sql}`,
        );
      }
    }
    this.channel.appendLine('');
  }

  private writePlanTree(root: PlanNode, isAnalyze: boolean): void {
    this.channel.appendLine('EXECUTION TREE');
    this.renderNode(root, 0, isAnalyze);
  }

  private renderNode(node: PlanNode, depth: number, isAnalyze: boolean): void {
    const indent = '  '.repeat(depth + 1);
    const relation = node.relationName
      ? ` on ${node.relationName}${node.alias && node.alias !== node.relationName ? ` (${node.alias})` : ''}`
      : '';
    const index = node.indexName ? ` using ${node.indexName}` : '';

    const timingPart =
      isAnalyze && node.exclusiveTimeMs !== undefined
        ? ` | self=${node.exclusiveTimeMs.toFixed(3)}ms (${(node.exclusiveTimePercent ?? 0).toFixed(1)}%) | total=${(node.inclusiveTimeMs ?? 0).toFixed(3)}ms`
        : '';

    const rowsPart =
      isAnalyze && node.actualRows !== undefined
        ? `rows=${node.actualRows} (est ${node.planRows}) loops=${node.actualLoops ?? 1}`
        : `est_rows=${node.planRows}`;

    const buffersPart =
      node.buffers.sharedHitBlocks +
        node.buffers.sharedReadBlocks +
        node.buffers.tempWrittenBlocks >
      0
        ? ` | buf[hit=${node.buffers.sharedHitBlocks}, read=${node.buffers.sharedReadBlocks}, temp_w=${node.buffers.tempWrittenBlocks}]`
        : '';

    this.channel.appendLine(
      `${indent}-> [#${node.id}] ${node.nodeType}${relation}${index} | cost=${node.startupCost.toFixed(2)}..${node.totalCost.toFixed(2)} | ${rowsPart}${timingPart}${buffersPart}`,
    );

    if (node.filter) {
      this.channel.appendLine(`${indent}   Filter: ${node.filter}`);
    }
    if (node.indexCond) {
      this.channel.appendLine(`${indent}   Index Cond: ${node.indexCond}`);
    }
    if (node.sort?.sortMethod) {
      this.channel.appendLine(
        `${indent}   Sort Method: ${node.sort.sortMethod} (${node.sort.sortSpaceUsedKb ?? 0} KB ${node.sort.sortSpaceType ?? ''})`,
      );
    }

    for (const child of node.children) {
      this.renderNode(child, depth + 1, isAnalyze);
    }
  }
}
