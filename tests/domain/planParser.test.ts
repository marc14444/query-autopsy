import { InvalidPlanError, parsePostgreSqlPlan } from '@query-autopsy/core';
import { describe, expect, it } from 'vitest';

describe('parsePostgreSqlPlan', () => {
  it('parses a nested EXPLAIN ANALYZE payload and computes exclusive node times without double counting buffers', () => {
    const rawPayload = [
      {
        Plan: {
          'Node Type': 'Sort',
          'Startup Cost': 3500.5,
          'Total Cost': 3620.75,
          'Plan Rows': 15000,
          'Plan Width': 32,
          'Actual Startup Time': 24.1,
          'Actual Total Time': 30.0,
          'Actual Rows': 14920,
          'Actual Loops': 1,
          'Sort Key': ['amount_cents DESC'],
          'Sort Method': 'external merge',
          'Sort Space Used': 2048,
          'Sort Space Type': 'Disk',
          'Shared Hit Blocks': 200,
          'Shared Read Blocks': 1200,
          'Temp Read Blocks': 256,
          'Temp Written Blocks': 256,
          Plans: [
            {
              'Node Type': 'Seq Scan',
              'Parent Relationship': 'Outer',
              'Relation Name': 'orders',
              Alias: 'orders',
              'Startup Cost': 0.0,
              'Total Cost': 2800.0,
              'Plan Rows': 15000,
              'Plan Width': 32,
              'Actual Startup Time': 0.02,
              'Actual Total Time': 18.0,
              'Actual Rows': 14920,
              'Actual Loops': 1,
              Filter: "(status = 'pending'::text)",
              'Rows Removed by Filter': 135080,
              'Shared Hit Blocks': 200,
              'Shared Read Blocks': 1200,
            },
          ],
        },
        'Planning Time': 0.25,
        'Execution Time': 30.0,
      },
    ];

    const plan = parsePostgreSqlPlan(rawPayload, 'analyze');

    expect(plan.mode).toBe('analyze');
    expect(plan.planningTimeMs).toBe(0.25);
    expect(plan.executionTimeMs).toBe(30.0);

    // Root Sort inclusive = 30ms, child Seq Scan inclusive = 18ms -> Sort exclusive = 12ms (40%)
    expect(plan.root.nodeType).toBe('Sort');
    expect(plan.root.inclusiveTimeMs).toBeCloseTo(30.0);
    expect(plan.root.exclusiveTimeMs).toBeCloseTo(12.0);
    expect(plan.root.exclusiveTimePercent).toBeCloseTo(40.0);
    expect(plan.root.sort?.sortSpaceType).toBe('Disk');

    const child = plan.root.children[0]!;
    expect(child.nodeType).toBe('Seq Scan');
    expect(child.exclusiveTimeMs).toBeCloseTo(18.0);
    expect(child.exclusiveTimePercent).toBeCloseTo(60.0);

    // Root buffers equal total execution buffers (200 / 1400)
    expect(plan.totalBuffers.sharedHitBlocks).toBe(200);
    expect(plan.totalBuffers.sharedReadBlocks).toBe(1200);
    expect(plan.totalBuffers.cacheHitRatio).toBeCloseTo(200 / 1400);
  });

  it('clamps exclusiveTimeMs to zero for parallel Gather nodes with overlapping worker times', () => {
    const rawPayload = [
      {
        Plan: {
          'Node Type': 'Gather',
          'Startup Cost': 1000,
          'Total Cost': 5000,
          'Plan Rows': 1000,
          'Plan Width': 16,
          'Actual Startup Time': 1,
          'Actual Total Time': 20,
          'Actual Rows': 1000,
          'Actual Loops': 1,
          'Workers Planned': 2,
          'Workers Launched': 2,
          Plans: [
            {
              'Node Type': 'Seq Scan',
              'Relation Name': 'orders',
              'Parallel Aware': true,
              'Startup Cost': 0,
              'Total Cost': 4000,
              'Plan Rows': 500,
              'Plan Width': 16,
              'Actual Startup Time': 0.5,
              'Actual Total Time': 15,
              'Actual Rows': 333,
              'Actual Loops': 3,
            },
          ],
        },
        'Execution Time': 20,
      },
    ];

    const plan = parsePostgreSqlPlan(rawPayload, 'analyze');
    expect(plan.root.exclusiveTimeMs).toBe(0);
    expect(plan.root.buffers.cacheHitRatio).toBeNull();
  });

  it('throws InvalidPlanError on malformed payloads', () => {
    expect(() => parsePostgreSqlPlan({}, 'analyze')).toThrow(InvalidPlanError);
    expect(() =>
      parsePostgreSqlPlan([{ Plan: { 'Startup Cost': 0 } }], 'analyze'),
    ).toThrow(InvalidPlanError);
  });
});
