import { describe, expect, it } from 'vitest';
import type { InspectionReport } from '../../src/domain/models/diagnostic.js';
import { formatMarkdownPrReport } from '../../src/domain/services/markdownReportFormatter.js';
import {
  computePlanDiff,
  selectDefaultBaselineIndex,
} from '../../src/domain/services/planDiff.js';
import { parsePostgreSqlPlan } from '../../src/domain/services/planParser.js';

describe('planDiff & markdownReportFormatter', () => {
  const beforePlan = parsePostgreSqlPlan(
    [
      {
        Plan: {
          'Node Type': 'Seq Scan',
          'Relation Name': 'orders',
          'Startup Cost': 0,
          'Total Cost': 5000,
          'Plan Rows': 15,
          'Plan Width': 24,
          'Actual Startup Time': 0.02,
          'Actual Total Time': 14.0,
          'Actual Rows': 15,
          'Actual Loops': 1,
          'Shared Hit Blocks': 3489,
          'Shared Read Blocks': 0,
        },
        'Planning Time': 0.2,
        'Execution Time': 14.2,
      },
    ],
    'analyze',
  );

  const afterPlan = parsePostgreSqlPlan(
    [
      {
        Plan: {
          'Node Type': 'Bitmap Heap Scan',
          'Relation Name': 'orders',
          'Startup Cost': 4.4,
          'Total Cost': 61.6,
          'Plan Rows': 15,
          'Plan Width': 24,
          'Actual Startup Time': 0.02,
          'Actual Total Time': 0.05,
          'Actual Rows': 15,
          'Actual Loops': 1,
          'Shared Hit Blocks': 20,
          'Shared Read Blocks': 0,
          Plans: [
            {
              'Node Type': 'Bitmap Index Scan',
              'Index Name': 'idx_orders_user_id',
              'Startup Cost': 0,
              'Total Cost': 4.4,
              'Plan Rows': 15,
              'Plan Width': 0,
              'Actual Startup Time': 0.01,
              'Actual Total Time': 0.01,
              'Actual Rows': 15,
              'Actual Loops': 1,
            },
          ],
        },
        'Planning Time': 0.2,
        'Execution Time': 0.1,
      },
    ],
    'analyze',
  );

  const beforeReport: InspectionReport = {
    sql: 'SELECT * FROM orders WHERE user_id = 42',
    statementKind: 'READ',
    mode: 'analyze',
    plan: beforePlan,
    diagnostics: [
      {
        ruleId: 'SEQ_SCAN_LARGE_TABLE',
        severity: 'critical',
        nodeId: '0',
        nodeType: 'Seq Scan',
        relationName: 'orders',
        title: 'Sequential Scan on "orders"',
        detail: '...',
        recommendation: '...',
      },
    ],
    inspectedAtIso: '2026-11-19T14:00:00.000Z',
  };

  const afterReport: InspectionReport = {
    sql: 'SELECT * FROM orders WHERE user_id = 42',
    statementKind: 'READ',
    mode: 'analyze',
    plan: afterPlan,
    diagnostics: [],
    inspectedAtIso: '2026-11-19T14:05:00.000Z',
    profileName: 'local-dev',
  };

  it('computes before/after execution, cost, buffer, and plan shape deltas', () => {
    const diff = computePlanDiff(beforeReport, afterReport);
    expect(diff.executionTimeDeltaPercent).toBeLessThan(-95);
    expect(diff.costDeltaPercent).toBeLessThan(-95);
    expect(diff.blocksDeltaPercent).toBeLessThan(-95);
    expect(diff.previousPlanSummary).toBe('Seq Scan(orders)');
    expect(diff.currentPlanSummary).toBe(
      'Bitmap Heap Scan(orders) → Bitmap Index Scan(idx_orders_user_id)',
    );
    expect(diff.previousDiagnosticsCount).toBe(1);
    expect(diff.currentDiagnosticsCount).toBe(0);
  });

  it('formats a clean GitHub PR Markdown report with before/after comparison table', () => {
    const diff = computePlanDiff(beforeReport, afterReport);
    const md = formatMarkdownPrReport(afterReport, diff);
    expect(md).toContain('### QueryAutopsy PostgreSQL Performance Report');
    expect(md).toContain('#### Before / After Comparison');
    expect(md).toContain('14.20 ms | 0.10 ms');
    expect(md).toContain('No performance bottlenecks detected.');
  });

  it('flags sub-ms timing and minor buffer jitter instead of alarming percentages', () => {
    const fastRunA: InspectionReport = {
      ...afterReport,
      plan: { ...afterPlan, executionTimeMs: 0.23 },
    };
    const fastRunB: InspectionReport = {
      ...afterReport,
      plan: {
        ...afterPlan,
        executionTimeMs: 0.59,
        totalBuffers: { ...afterPlan.totalBuffers, sharedHitBlocks: 17 },
      },
    };

    const diff = computePlanDiff(fastRunA, fastRunB);
    expect(diff.executionTimeIsNoise).toBe(true);
    expect(diff.blocksDeltaIsNoise).toBe(true);

    const md = formatMarkdownPrReport(fastRunB, diff);
    expect(md).toContain('sub-ms jitter');
    expect(md).toContain('minor jitter');
    expect(md).not.toContain('+156.5%');
  });

  it('selects pre-optimization baseline automatically across repeated post-index re-runs', () => {
    const fastRunAgain: InspectionReport = {
      ...afterReport,
      inspectedAtIso: '2026-11-19T14:06:00.000Z',
    };
    expect(selectDefaultBaselineIndex([beforeReport, afterReport, fastRunAgain])).toBe(0);
    expect(selectDefaultBaselineIndex([afterReport, fastRunAgain])).toBe(0);
    expect(selectDefaultBaselineIndex([beforeReport])).toBeUndefined();
  });
});
