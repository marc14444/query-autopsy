import { describe, expect, it } from 'vitest';
import {
  analyzeExecutionPlan,
  extractFilterColumns,
} from '../../src/domain/services/diagnosticEngine.js';
import { parsePostgreSqlPlan } from '../../src/domain/services/planParser.js';

describe('extractFilterColumns', () => {
  it('extracts columns cleanly across Postgres type casts and operators', () => {
    const filter =
      "((o.status = 'pending'::text AND o.user_id = 42) AND (o.created_at >= '2026-01-01'::timestamp with time zone))";
    expect(extractFilterColumns(filter, 'o')).toEqual([
      'status',
      'user_id',
      'created_at',
    ]);
  });
});

describe('analyzeExecutionPlan', () => {
  it('flags large Seq Scan, disk spill on Sort only, row misestimates, and low buffer cache hits', () => {
    const rawPayload = [
      {
        Plan: {
          'Node Type': 'Limit',
          'Startup Cost': 3600,
          'Total Cost': 3610,
          'Plan Rows': 50,
          'Plan Width': 48,
          'Actual Startup Time': 45,
          'Actual Total Time': 45.2,
          'Actual Rows': 50,
          'Actual Loops': 1,
          'Shared Hit Blocks': 100,
          'Shared Read Blocks': 1200,
          'Temp Read Blocks': 300,
          'Temp Written Blocks': 300,
          Plans: [
            {
              'Node Type': 'Sort',
              'Startup Cost': 3500,
              'Total Cost': 3600,
              'Plan Rows': 100,
              'Plan Width': 48,
              'Actual Startup Time': 44,
              'Actual Total Time': 45,
              'Actual Rows': 15000,
              'Actual Loops': 1,
              'Sort Key': ['amount_cents DESC'],
              'Sort Method': 'external merge',
              'Sort Space Used': 2400,
              'Sort Space Type': 'Disk',
              'Shared Hit Blocks': 100,
              'Shared Read Blocks': 1200,
              'Temp Read Blocks': 300,
              'Temp Written Blocks': 300,
              Plans: [
                {
                  'Node Type': 'Seq Scan',
                  'Relation Name': 'orders',
                  Alias: 'orders',
                  'Startup Cost': 0,
                  'Total Cost': 2800,
                  'Plan Rows': 100,
                  'Plan Width': 48,
                  'Actual Startup Time': 0.02,
                  'Actual Total Time': 22,
                  'Actual Rows': 15000,
                  'Actual Loops': 1,
                  Filter: "((status = 'pending'::text) AND (user_id = 42))",
                  'Rows Removed by Filter': 135000,
                  'Shared Hit Blocks': 100,
                  'Shared Read Blocks': 1200,
                },
              ],
            },
          ],
        },
        'Execution Time': 45.5,
      },
    ];

    const plan = parsePostgreSqlPlan(rawPayload, 'analyze');
    const findings = analyzeExecutionPlan(plan, { seqScanRowThreshold: 1000 });

    const seqFindings = findings.filter(
      (f) => f.ruleId === 'SEQ_SCAN_LARGE_TABLE',
    );
    expect(seqFindings).toHaveLength(1);
    expect(seqFindings[0]?.severity).toBe('critical');
    expect(seqFindings[0]?.indexSuggestion?.sql).toBe(
      'CREATE INDEX CONCURRENTLY idx_orders_status_user_id ON orders (status, user_id);',
    );

    // Ensure disk spill is flagged ONLY on Sort (#0.0), not duplicated on parent Limit (#0)
    const spillFindings = findings.filter(
      (f) => f.ruleId === 'EXTERNAL_DISK_SPILL',
    );
    expect(spillFindings).toHaveLength(1);
    expect(spillFindings[0]?.nodeId).toBe('0.0');

    // Low cache hit ratio should pinpoint leaf Seq Scan (#0.0.0)
    const cacheFindings = findings.filter(
      (f) => f.ruleId === 'LOW_CACHE_HIT_RATIO',
    );
    expect(cacheFindings).toHaveLength(1);
    expect(cacheFindings[0]?.nodeId).toBe('0.0.0');

    // Planner misestimate (100 est vs 15000 actual = 150x)
    const estimateFindings = findings.filter(
      (f) => f.ruleId === 'PLANNER_ROW_MISESTIMATE',
    );
    expect(estimateFindings.length).toBeGreaterThanOrEqual(1);
  });

  it('flags Nested Loop with high inner loop count', () => {
    const rawPayload = [
      {
        Plan: {
          'Node Type': 'Nested Loop',
          'Startup Cost': 0,
          'Total Cost': 5000,
          'Plan Rows': 2000,
          'Plan Width': 32,
          'Actual Startup Time': 0.1,
          'Actual Total Time': 40,
          'Actual Rows': 2000,
          'Actual Loops': 1,
          Plans: [
            {
              'Node Type': 'Seq Scan',
              'Relation Name': 'users',
              'Startup Cost': 0,
              'Total Cost': 100,
              'Plan Rows': 2000,
              'Plan Width': 16,
              'Actual Startup Time': 0.01,
              'Actual Total Time': 2,
              'Actual Rows': 2000,
              'Actual Loops': 1,
            },
            {
              'Node Type': 'Index Scan',
              'Relation Name': 'orders',
              'Index Name': 'orders_pkey',
              'Startup Cost': 0.4,
              'Total Cost': 2.1,
              'Plan Rows': 1,
              'Plan Width': 16,
              'Actual Startup Time': 0.01,
              'Actual Total Time': 0.015,
              'Actual Rows': 1,
              'Actual Loops': 2000,
            },
          ],
        },
        'Execution Time': 40.2,
      },
    ];

    const plan = parsePostgreSqlPlan(rawPayload, 'analyze');
    const findings = analyzeExecutionPlan(plan, { seqScanRowThreshold: 5000 });
    expect(findings.some((f) => f.ruleId === 'NESTED_LOOP_HIGH_LOOPS')).toBe(
      true,
    );
  });
});
