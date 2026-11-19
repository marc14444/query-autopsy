import { describe, expect, it } from 'vitest';
import { getEngineAdapter } from '../../src/domain/engines/engineRegistry.js';
import { explainPlanNode } from '../../src/domain/services/nodeExplainer.js';

describe('SQLite Engine Adapter (v0.4.0)', () => {
  const sqlite = getEngineAdapter('sqlite');

  it('classifies ?, ?1, $1, [bracket] identifiers, and CREATE INDEX IF NOT EXISTS', () => {
    const classified = sqlite.classifySql(
      'SELECT * FROM [orders] WHERE user_id = ?1 AND status = ? ORDER BY created_at DESC;',
    );
    expect(classified.kind).toBe('READ');
    expect(classified.parameterIndices).toEqual([1, 2]);

    const normalizedIdx = sqlite.validateSafeCreateIndexSql(
      'CREATE INDEX IF NOT EXISTS idx_orders_user ON orders (user_id, created_at DESC)',
    );
    expect(normalizedIdx).toBe(
      'CREATE INDEX IF NOT EXISTS idx_orders_user ON orders (user_id, created_at DESC);',
    );
  });

  it('parses EXPLAIN QUERY PLAN hierarchy and generates index suggestions from SQL predicates', () => {
    const rawEqp = {
      eqpRows: [
        { id: 3, parent: 0, detail: 'SCAN orders' },
        { id: 12, parent: 0, detail: 'USE TEMP B-TREE FOR ORDER BY' },
      ],
      executionTimeMs: 4.2,
      actualRows: 2500,
    };

    const plan = sqlite.parsePlan(rawEqp, 'analyze');
    expect(plan.engine).toBe('sqlite');
    expect(plan.executionTimeMs).toBeCloseTo(4.2, 2);
    expect(plan.root.nodeType).toBe('Query Plan');
    expect(plan.root.children).toHaveLength(2);
    expect(plan.root.children[0]?.nodeType).toBe('Full Table Scan');
    expect(plan.root.children[1]?.nodeType).toBe('Temp B-Tree (ORDER BY)');
    expect(explainPlanNode(plan.root.children[1]!, 'analyze')).toContain(
      'temporary B-Tree',
    );

    const findings = sqlite.analyzePlan(plan, {
      seqScanRowThreshold: 1000,
      sql: "SELECT * FROM orders WHERE status = 'pending' ORDER BY created_at DESC",
    });

    expect(findings.map((f) => f.ruleId)).toEqual(
      expect.arrayContaining([
        'SQLITE_FULL_TABLE_SCAN',
        'SQLITE_TEMP_BTREE_SORT',
      ]),
    );

    const sortFinding = findings.find(
      (f) => f.ruleId === 'SQLITE_TEMP_BTREE_SORT',
    );
    expect(sortFinding?.indexSuggestion?.sql).toBe(
      'CREATE INDEX IF NOT EXISTS idx_orders_status_created_at ON orders (status, created_at DESC);',
    );
  });
});
