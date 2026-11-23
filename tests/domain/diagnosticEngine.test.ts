import {
  analyzeExecutionPlan,
  extractFilterColumns,
  hasTopLevelSelectStar,
  parsePostgreSqlPlan,
} from '@query-autopsy/core';
import { describe, expect, it } from 'vitest';

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

  it('detects ESR composite index opportunity for Sort over filtered Seq Scan', () => {
    const rawPayload = [
      {
        Plan: {
          'Node Type': 'Sort',
          'Startup Cost': 6000,
          'Total Cost': 6100,
          'Plan Rows': 13500,
          'Plan Width': 64,
          'Actual Startup Time': 15,
          'Actual Total Time': 17,
          'Actual Rows': 13500,
          'Actual Loops': 1,
          'Sort Key': ['amount_cents DESC', 'payload'],
          'Sort Method': 'quicksort',
          'Sort Space Used': 2599,
          'Sort Space Type': 'Memory',
          Plans: [
            {
              'Node Type': 'Seq Scan',
              'Relation Name': 'orders',
              Alias: 'orders',
              'Startup Cost': 0,
              'Total Cost': 5000,
              'Plan Rows': 13500,
              'Plan Width': 64,
              'Actual Startup Time': 0.01,
              'Actual Total Time': 11,
              'Actual Rows': 13500,
              'Actual Loops': 1,
              Filter: "(status = 'pending'::text)",
              'Rows Removed by Filter': 136500,
            },
          ],
        },
        'Execution Time': 18,
      },
    ];

    const plan = parsePostgreSqlPlan(rawPayload, 'analyze');
    const findings = analyzeExecutionPlan(plan, { seqScanRowThreshold: 1000 });
    const esr = findings.find(
      (f) => f.ruleId === 'ESR_COMPOSITE_INDEX_OPPORTUNITY',
    );
    expect(esr).toBeDefined();
    expect(esr?.indexSuggestion?.sql).toBe(
      'CREATE INDEX CONCURRENTLY idx_orders_status_amount_cents_payload ON orders (status, amount_cents DESC, payload);',
    );
  });

  it('detects ESR composite index opportunity for Sort over Bitmap Heap Scan + child Bitmap Index Scan', () => {
    const rawPayload = [
      {
        Plan: {
          'Node Type': 'Sort',
          'Startup Cost': 4685.5,
          'Total Cost': 4717.91,
          'Plan Rows': 12965,
          'Plan Width': 138,
          'Actual Startup Time': 11.2,
          'Actual Total Time': 14.2,
          'Actual Rows': 13500,
          'Actual Loops': 1,
          'Sort Key': ['amount_cents DESC', 'payload'],
          'Sort Method': 'quicksort',
          'Sort Space Used': 2599,
          'Sort Space Type': 'Memory',
          Plans: [
            {
              'Node Type': 'Bitmap Heap Scan',
              'Relation Name': 'orders',
              Alias: 'orders',
              'Recheck Cond': "(status = 'pending'::text)",
              'Startup Cost': 140,
              'Total Cost': 4500,
              'Plan Rows': 12965,
              'Plan Width': 138,
              'Actual Startup Time': 0.9,
              'Actual Total Time': 8.28,
              'Actual Rows': 13500,
              'Actual Loops': 1,
              Plans: [
                {
                  'Node Type': 'Bitmap Index Scan',
                  'Index Name': 'idx_orders_status',
                  'Index Cond': "(status = 'pending'::text)",
                  'Startup Cost': 0,
                  'Total Cost': 135,
                  'Plan Rows': 12965,
                  'Plan Width': 0,
                  'Actual Startup Time': 0.78,
                  'Actual Total Time': 0.78,
                  'Actual Rows': 13500,
                  'Actual Loops': 1,
                },
              ],
            },
          ],
        },
        'Execution Time': 14.96,
      },
    ];

    const plan = parsePostgreSqlPlan(rawPayload, 'analyze');
    const findings = analyzeExecutionPlan(plan, { seqScanRowThreshold: 1000 });
    const esr = findings.find(
      (f) => f.ruleId === 'ESR_COMPOSITE_INDEX_OPPORTUNITY',
    );
    expect(esr).toBeDefined();
    expect(esr?.severity).toBe('warning');
    expect(esr?.indexSuggestion?.sql).toBe(
      'CREATE INDEX CONCURRENTLY idx_orders_status_amount_cents_payload ON orders (status, amount_cents DESC, payload);',
    );
  });

  it('detects non-SARGable predicates, correlated SubPlans, and lossy bitmap heap blocks', () => {
    const rawPayload = [
      {
        Plan: {
          'Node Type': 'Bitmap Heap Scan',
          'Relation Name': 'users',
          'Startup Cost': 10,
          'Total Cost': 800,
          'Plan Rows': 500,
          'Plan Width': 32,
          'Actual Startup Time': 1,
          'Actual Total Time': 12,
          'Actual Rows': 450,
          'Actual Loops': 1,
          Filter: "(lower(email) = 'alice@example.com'::text)",
          'Exact Heap Blocks': 20,
          'Lossy Heap Blocks': 150,
          Plans: [
            {
              'Node Type': 'Index Scan',
              'Subplan Name': 'SubPlan 1',
              'Relation Name': 'orders',
              'Startup Cost': 0.4,
              'Total Cost': 4.5,
              'Plan Rows': 1,
              'Plan Width': 8,
              'Actual Startup Time': 0.02,
              'Actual Total Time': 0.03,
              'Actual Rows': 1,
              'Actual Loops': 1200,
              Filter: "((user_id)::text = '42'::text)",
            },
          ],
        },
        'Execution Time': 48,
      },
    ];

    const plan = parsePostgreSqlPlan(rawPayload, 'analyze');
    const findings = analyzeExecutionPlan(plan, { seqScanRowThreshold: 1000 });

    const nonSargable = findings.filter(
      (f) => f.ruleId === 'NON_SARGABLE_PREDICATE',
    );
    expect(nonSargable).toHaveLength(2);
    expect(nonSargable.some((f) => f.indexSuggestion?.sql.includes('lower(email)'))).toBe(true);

    const subPlan = findings.find((f) => f.ruleId === 'CORRELATED_SUBPLAN');
    expect(subPlan?.severity).toBe('critical');

    const lossy = findings.find((f) => f.ruleId === 'BITMAP_LOSSY_BLOCKS');
    expect(lossy?.severity).toBe('critical');
  });

  it('detects top-level SELECT * accurately while ignoring COUNT(*) and arithmetic *', () => {
    expect(hasTopLevelSelectStar('SELECT * FROM orders')).toBe(true);
    expect(hasTopLevelSelectStar('SELECT o.*, u.id FROM orders o JOIN users u ON u.id = o.user_id')).toBe(true);
    expect(hasTopLevelSelectStar('WITH raw AS (SELECT * FROM events) SELECT count(*) FROM raw')).toBe(true);
    expect(hasTopLevelSelectStar('SELECT COUNT(*) FROM orders')).toBe(false);
    expect(hasTopLevelSelectStar('SELECT price * quantity AS total FROM order_items')).toBe(false);
  });

  it('flags OLAP diagnostics (SELECT_STAR_WIDE_SCAN, MISSING_PARTITION_PRUNING, HASH_AGG_OR_JOIN_DISK_SPILL, CARTESIAN_OR_UNBOUNDED_JOIN)', () => {
    const rawPayload = [
      {
        Plan: {
          'Node Type': 'HashAggregate',
          'Startup Cost': 25000,
          'Total Cost': 30000,
          'Plan Rows': 50000,
          'Plan Width': 320,
          'Actual Startup Time': 400,
          'Actual Total Time': 680,
          'Actual Rows': 45000,
          'Actual Loops': 1,
          'Hash Batches': 8,
          'Temp Read Blocks': 1200,
          'Temp Written Blocks': 1200,
          Plans: [
            {
              'Node Type': 'Append',
              'Startup Cost': 0,
              'Total Cost': 22000,
              'Plan Rows': 120000,
              'Plan Width': 320,
              'Actual Startup Time': 0.05,
              'Actual Total Time': 210,
              'Actual Rows': 120000,
              'Actual Loops': 1,
              'Subplans Removed': 0,
              Plans: [
                {
                  'Node Type': 'Seq Scan',
                  'Relation Name': 'events_2026_01',
                  'Startup Cost': 0,
                  'Total Cost': 11000,
                  'Plan Rows': 60000,
                  'Plan Width': 320,
                  'Actual Startup Time': 0.02,
                  'Actual Total Time': 105,
                  'Actual Rows': 60000,
                  'Actual Loops': 1,
                },
                {
                  'Node Type': 'Seq Scan',
                  'Relation Name': 'events_2026_02',
                  'Startup Cost': 0,
                  'Total Cost': 11000,
                  'Plan Rows': 60000,
                  'Plan Width': 320,
                  'Actual Startup Time': 0.02,
                  'Actual Total Time': 105,
                  'Actual Rows': 60000,
                  'Actual Loops': 1,
                },
              ],
            },
          ],
        },
        'Execution Time': 690,
      },
    ];

    const plan = parsePostgreSqlPlan(rawPayload, 'analyze');
    const findings = analyzeExecutionPlan(plan, {
      seqScanRowThreshold: 1000,
      sql: 'SELECT * FROM events WHERE true',
      workloadProfile: 'analytics',
    });

    // workloadProfile='analytics' suppresses unfiltered OLTP SEQ_SCAN_LARGE_TABLE noise under HashAggregate
    expect(findings.some((f) => f.ruleId === 'SEQ_SCAN_LARGE_TABLE')).toBe(false);

    // Hash spill maps to HASH_AGG_OR_JOIN_DISK_SPILL without duplicate EXTERNAL_DISK_SPILL
    expect(findings.filter((f) => f.ruleId === 'HASH_AGG_OR_JOIN_DISK_SPILL')).toHaveLength(1);
    expect(findings.some((f) => f.ruleId === 'EXTERNAL_DISK_SPILL')).toBe(false);

    expect(findings.some((f) => f.ruleId === 'MISSING_PARTITION_PRUNING')).toBe(true);
    expect(findings.filter((f) => f.ruleId === 'SELECT_STAR_WIDE_SCAN')).toHaveLength(2);

    // Ensure pruned Append (Subplans Removed > 0) does NOT false-positive
    const prunedPlan = parsePostgreSqlPlan(
      [
        {
          Plan: {
            'Node Type': 'Append',
            'Startup Cost': 0,
            'Total Cost': 500,
            'Plan Rows': 2000,
            'Plan Width': 32,
            'Subplans Removed': 11,
            Plans: [
              {
                'Node Type': 'Seq Scan',
                'Relation Name': 'events_2026_12',
                'Startup Cost': 0,
                'Total Cost': 500,
                'Plan Rows': 2000,
                'Plan Width': 32,
              },
              {
                'Node Type': 'Seq Scan',
                'Relation Name': 'events_default',
                'Startup Cost': 0,
                'Total Cost': 1,
                'Plan Rows': 1,
                'Plan Width': 32,
              },
            ],
          },
        },
      ],
      'estimate',
    );
    expect(
      analyzeExecutionPlan(prunedPlan, {
        seqScanRowThreshold: 1000,
        sql: 'SELECT COUNT(*) FROM events',
      }).some(
        (f) =>
          f.ruleId === 'MISSING_PARTITION_PRUNING' ||
          f.ruleId === 'SELECT_STAR_WIDE_SCAN',
      ),
    ).toBe(false);

    // Cartesian Nested Loop detected cleanly in estimate mode
    const cartesianPlan = parsePostgreSqlPlan(
      [
        {
          Plan: {
            'Node Type': 'Nested Loop',
            'Join Type': 'Inner',
            'Startup Cost': 0,
            'Total Cost': 50000,
            'Plan Rows': 250000,
            'Plan Width': 64,
            Plans: [
              {
                'Node Type': 'Seq Scan',
                'Relation Name': 'users',
                'Startup Cost': 0,
                'Total Cost': 20,
                'Plan Rows': 500,
                'Plan Width': 32,
              },
              {
                'Node Type': 'Seq Scan',
                'Relation Name': 'countries',
                'Startup Cost': 0,
                'Total Cost': 20,
                'Plan Rows': 500,
                'Plan Width': 32,
              },
            ],
          },
        },
      ],
      'estimate',
    );
    const cartFindings = analyzeExecutionPlan(cartesianPlan, {
      seqScanRowThreshold: 1000,
    });
    expect(cartFindings.some((f) => f.ruleId === 'CARTESIAN_OR_UNBOUNDED_JOIN')).toBe(
      true,
    );
  });
});
