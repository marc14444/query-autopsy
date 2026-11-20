import {
  buildNodeExplanationMap,
  parsePostgreSqlPlan,
} from '@query-autopsy/core';
import { describe, expect, it } from 'vitest';

describe('nodeExplainer', () => {
  it('generates clear plain-English explanations for each node in the plan', () => {
    const plan = parsePostgreSqlPlan(
      [
        {
          Plan: {
            'Node Type': 'Gather',
            'Startup Cost': 1000,
            'Total Cost': 5000,
            'Plan Rows': 15,
            'Plan Width': 25,
            'Actual Startup Time': 0.2,
            'Actual Total Time': 8.5,
            'Actual Rows': 15,
            'Actual Loops': 1,
            'Workers Launched': 2,
            Plans: [
              {
                'Node Type': 'Seq Scan',
                'Relation Name': 'orders',
                'Parallel Aware': true,
                'Startup Cost': 0,
                'Total Cost': 4000,
                'Plan Rows': 6,
                'Plan Width': 25,
                'Actual Startup Time': 0.1,
                'Actual Total Time': 5.0,
                'Actual Rows': 5,
                'Actual Loops': 3,
                'Rows Removed by Filter': 49995,
              },
            ],
          },
          'Execution Time': 8.6,
        },
      ],
      'analyze',
    );

    const explanations = buildNodeExplanationMap(plan);
    expect(explanations['0']).toContain('2 parallel worker(s)');
    expect(explanations['0.0']).toContain('150,000 rows in "orders"');
    expect(explanations['0.0']).toContain('discarded 100.0%');
  });
});
