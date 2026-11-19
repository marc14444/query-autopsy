import { formatEngineLabel } from '../models/databaseEngine.js';
import type { InspectionReport } from '../models/diagnostic.js';
import type { PlanComparisonSummary } from './planDiff.js';

function formatDeltaPct(pct: number | undefined): string {
  if (pct === undefined) {
    return 'N/A';
  }
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

export function formatMarkdownPrReport(
  report: InspectionReport,
  comparison?: PlanComparisonSummary,
): string {
  const lines: string[] = [];
  const { plan } = report;
  const hitRatio =
    plan.totalBuffers.cacheHitRatio !== null
      ? `${(plan.totalBuffers.cacheHitRatio * 100).toFixed(1)}%`
      : 'N/A';

  const engineLabel = formatEngineLabel(report.engine ?? 'postgresql');
  lines.push(`### QueryAutopsy ${engineLabel} Performance Report`);
  lines.push('');
  lines.push(
    `- **Mode**: \`${report.mode.toUpperCase()}\` (${report.statementKind})${report.profileName ? ` | **Profile**: \`${report.profileName}\`` : ''}`,
  );
  lines.push(
    `- **Execution Time**: ${plan.executionTimeMs !== undefined ? `**${plan.executionTimeMs.toFixed(2)} ms**` : 'N/A (estimate)'} (Planning: ${plan.planningTimeMs !== undefined ? `${plan.planningTimeMs.toFixed(2)} ms` : 'N/A'})`,
  );
  lines.push(`- **Total Cost**: \`${plan.root.totalCost.toFixed(2)}\``);
  lines.push(
    `- **Buffers**: Hit \`${plan.totalBuffers.sharedHitBlocks.toLocaleString('en-US')}\` | Read \`${plan.totalBuffers.sharedReadBlocks.toLocaleString('en-US')}\` | Temp Written \`${plan.totalBuffers.tempWrittenBlocks.toLocaleString('en-US')}\` (Cache Hit: ${hitRatio})`,
  );

  if (comparison) {
    lines.push('');
    lines.push('#### Before / After Comparison');
    lines.push('| Metric | Before | After | Delta |');
    lines.push('| :--- | :--- | :--- | :--- |');
    if (
      comparison.previousExecutionTimeMs !== undefined &&
      comparison.currentExecutionTimeMs !== undefined
    ) {
      lines.push(
        `| Execution Time | ${comparison.previousExecutionTimeMs.toFixed(2)} ms | ${comparison.currentExecutionTimeMs.toFixed(2)} ms | **${formatDeltaPct(comparison.executionTimeDeltaPercent)}** |`,
      );
    }
    lines.push(
      `| Total Cost | ${comparison.previousCost.toFixed(1)} | ${comparison.currentCost.toFixed(1)} | **${formatDeltaPct(comparison.costDeltaPercent)}** |`,
    );
    lines.push(
      `| Total Buffers | ${comparison.previousSharedBlocks.toLocaleString('en-US')} | ${comparison.currentSharedBlocks.toLocaleString('en-US')} | **${formatDeltaPct(comparison.blocksDeltaPercent)}** |`,
    );
    lines.push(
      `| Plan Shape | \`${comparison.previousPlanSummary}\` | \`${comparison.currentPlanSummary}\` | Issues: ${comparison.previousDiagnosticsCount} → ${comparison.currentDiagnosticsCount} |`,
    );
  }

  lines.push('');
  lines.push('```sql');
  lines.push(report.sql);
  lines.push('```');

  if (report.diagnostics.length > 0) {
    lines.push('');
    lines.push(`#### Diagnostics (${report.diagnostics.length})`);
    for (const d of report.diagnostics) {
      lines.push(`- **[${d.severity.toUpperCase()}]** ${d.title}`);
      if (d.indexSuggestion) {
        lines.push(`  - Suggested index: \`${d.indexSuggestion.sql}\``);
      }
    }
  } else {
    lines.push('');
    lines.push('✅ **No performance bottlenecks detected.**');
  }

  return lines.join('\n');
}
