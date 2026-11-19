import { describe, expect, it } from 'vitest';
import { getEngineAdapter } from '../../src/domain/engines/engineRegistry.js';
import { UnsafeQueryError } from '../../src/domain/errors/domainErrors.js';
import { explainPlanNode } from '../../src/domain/services/nodeExplainer.js';

describe('MySQL Engine Adapter (v0.4.0)', () => {
  const mysql = getEngineAdapter('mysql');

  it('classifies ? placeholders, # comments, backticks, and CREATE INDEX syntax', () => {
    const classified = mysql.classifySql(`
      # Find pending orders for tenant
      SELECT * FROM \`orders\`
      WHERE status = ? AND amount_cents >= ?
      ORDER BY created_at DESC;
    `);

    expect(classified.kind).toBe('READ');
    expect(classified.parameterIndices).toEqual([1, 2]);

    const replaceWrite = mysql.classifySql('REPLACE INTO cache (k, v) VALUES (?, ?)');
    expect(replaceWrite.kind).toBe('WRITE');

    expect(
      mysql.validateSafeCreateIndexSql(
        'CREATE INDEX idx_orders_status ON `orders` (status, created_at DESC);',
      ),
    ).toBe('CREATE INDEX idx_orders_status ON `orders` (status, created_at DESC);');

    expect(() =>
      mysql.validateSafeCreateIndexSql(
        'CREATE INDEX CONCURRENTLY idx_bad ON orders (status);',
      ),
    ).toThrow(UnsafeQueryError);
  });

  it('parses MySQL EXPLAIN FORMAT=JSON (ordering_operation + filesort + Table Scan ALL) and emits actionable rules', () => {
    const rawJson = JSON.stringify({
      query_block: {
        select_id: 1,
        cost_info: { query_cost: '842.50' },
        ordering_operation: {
          using_filesort: true,
          using_temporary_table: true,
          table: {
            table_name: 'orders',
            access_type: 'ALL',
            rows_examined_per_scan: 12000,
            rows_produced_per_join: 1500,
            cost_info: {
              read_cost: '620.00',
              eval_cost: '150.00',
              prefix_cost: '770.00',
            },
            attached_condition: "((`app`.`orders`.`status` = 'pending') and (`app`.`orders`.`user_id` = 42))",
          },
        },
      },
    });

    const plan = mysql.parsePlan(rawJson, 'estimate');
    expect(plan.engine).toBe('mysql');
    expect(plan.root.nodeType).toBe('Filesort');
    expect(plan.root.children[0]?.nodeType).toBe('Temporary Table');
    expect(plan.root.children[0]?.children[0]?.nodeType).toBe('Table Scan (ALL)');

    const findings = mysql.analyzePlan(plan, {
      seqScanRowThreshold: 1000,
      sql: "SELECT * FROM orders WHERE status = 'pending' AND user_id = 42 ORDER BY amount_cents DESC",
    });

    const ids = findings.map((f) => f.ruleId);
    expect(ids).toContain('MYSQL_FULL_TABLE_SCAN');
    expect(ids).toContain('MYSQL_USING_FILESORT');
    expect(ids).toContain('MYSQL_USING_TEMPORARY');

    const fullScan = findings.find((f) => f.ruleId === 'MYSQL_FULL_TABLE_SCAN');
    expect(fullScan?.indexSuggestion?.sql).toContain('CREATE INDEX ');
    expect(fullScan?.indexSuggestion?.sql).not.toContain('CONCURRENTLY');
    expect(fullScan?.indexSuggestion?.columns).toEqual(['status', 'user_id']);
  });

  it('parses MySQL 8+ EXPLAIN ANALYZE FORMAT=TREE with inclusive/exclusive timings and never executed branches', () => {
    const treeOutput = [
      '-> Sort: orders.amount_cents DESC  (cost=1240.50 rows=5000) (actual time=18.20..19.45 rows=500 loops=1)',
      "    -> Filter: (orders.status = 'pending')  (cost=620.00 rows=5000) (actual time=0.10..15.10 rows=500 loops=1)",
      '        -> Table scan on orders  (cost=620.00 rows=50000) (actual time=0.08..11.20 rows=50000 loops=1)',
    ].join('\n');

    const plan = mysql.parsePlan(treeOutput, 'analyze');
    expect(plan.engine).toBe('mysql');
    expect(plan.executionTimeMs).toBeCloseTo(19.45, 2);
    expect(plan.root.nodeType).toBe('Filesort');
    expect(plan.root.exclusiveTimeMs).toBeCloseTo(19.45 - 15.1, 2);

    const scanNode = plan.root.children[0]?.children[0];
    expect(scanNode?.nodeType).toBe('Table Scan (ALL)');
    expect(scanNode?.relationName).toBe('orders');
    expect(explainPlanNode(scanNode!, 'analyze')).toContain('MySQL table "orders"');

    const findings = mysql.analyzePlan(plan, { seqScanRowThreshold: 1000 });
    expect(findings.some((f) => f.ruleId === 'PLANNER_ROW_MISESTIMATE')).toBe(
      true,
    );
    expect(findings.some((f) => f.ruleId === 'MYSQL_FULL_TABLE_SCAN')).toBe(
      true,
    );
  });
});
