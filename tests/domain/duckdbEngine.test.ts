import {
  detectDatabaseEngineFromUri,
  duckdbEngineAdapter,
  formatEngineLabel,
  parseDuckDbPlan,
  sanitizeConnectionDisplayTarget,
} from '@query-autopsy/core';
import { describe, expect, it } from 'vitest';

describe('DuckDB & Parquet domain engine adapter', () => {
  it('detects DuckDB URIs, .duckdb/.ddb paths, and strips path prefixes cleanly', () => {
    expect(detectDatabaseEngineFromUri('duckdb:///tmp/analytics.duckdb')).toBe(
      'duckdb',
    );
    expect(detectDatabaseEngineFromUri('./warehouse/events.ddb')).toBe('duckdb');
    expect(detectDatabaseEngineFromUri(':memory:duckdb')).toBe('duckdb');
    expect(formatEngineLabel('duckdb')).toBe('DuckDB');
    expect(
      sanitizeConnectionDisplayTarget(
        'duckdb:///workspace/analytics/events.duckdb',
        'duckdb',
      ),
    ).toBe('events.duckdb');
  });

  it('rejects DuckDB extension-loading DDL and dangerous file/secret functions', () => {
    expect(duckdbEngineAdapter.classifySql('INSTALL httpfs;').kind).toBe('DDL');
    expect(duckdbEngineAdapter.classifySql('LOAD parquet;').kind).toBe('DDL');
    expect(
      duckdbEngineAdapter.classifySql("EXPORT DATABASE '/tmp/out';").kind,
    ).toBe('DDL');
    expect(() =>
      duckdbEngineAdapter.classifySql('SELECT * FROM duckdb_secrets();'),
    ).toThrow(/dangerous SQL construct/i);
    expect(() =>
      duckdbEngineAdapter.classifySql("SELECT read_text('/etc/passwd');"),
    ).toThrow(/dangerous SQL construct/i);
  });

  it('parses DuckDB CLI -json EXPLAIN (FORMAT JSON) and flags PARQUET_PROJECTION_MISS, PARQUET_PREDICATE_PUSHDOWN_MISS, and DUCKDB_OUT_OF_CORE_SPILL', () => {
    const cliEnvelopePayload = [
      {
        explain_key: 'physical_plan',
        explain_value: JSON.stringify([
          {
            name: 'HASH_GROUP_BY',
            extra_info: {
              'Estimated Cardinality': '250000',
              Spill: 'out-of-core temp_dir',
            },
            children: [
              {
                name: 'FILTER',
                extra_info: {
                  'Estimated Cardinality': '50000',
                  Expression: "(CAST(event_ts AS DATE) >= '2026-01-01')",
                },
                children: [
                  {
                    name: 'PARQUET_SCAN ',
                    extra_info: {
                      File: 'data/events_2026.parquet',
                      'Estimated Cardinality': '250000',
                      Projections: Array.from(
                        { length: 14 },
                        (_, idx) => `col_${idx}`,
                      ),
                    },
                    children: [],
                  },
                ],
              },
            ],
          },
        ]),
      },
    ];

    const plan = parseDuckDbPlan(cliEnvelopePayload, 'estimate');
    expect(plan.engine).toBe('duckdb');
    expect(plan.root.nodeType).toBe('HASH_GROUP_BY');
    expect(plan.totalBuffers.tempWrittenBlocks).toBe(1);

    const findings = duckdbEngineAdapter.analyzePlan(plan, {
      seqScanRowThreshold: 1000,
      sql: "SELECT * FROM read_parquet('data/events_2026.parquet') WHERE CAST(event_ts AS DATE) >= '2026-01-01'",
    });

    expect(findings.some((f) => f.ruleId === 'PARQUET_PROJECTION_MISS')).toBe(
      true,
    );
    expect(
      findings.some((f) => f.ruleId === 'PARQUET_PREDICATE_PUSHDOWN_MISS'),
    ).toBe(true);
    expect(findings.some((f) => f.ruleId === 'DUCKDB_OUT_OF_CORE_SPILL')).toBe(
      true,
    );
  });

  it('parses EXPLAIN (ANALYZE, FORMAT JSON) operator timings and catches CROSS_PRODUCT joins', () => {
    const analyzePayload = {
      query_name: 'cross_test',
      latency: 0.42,
      rows_returned: 120000,
      children: [
        {
          operator_name: 'CROSS_PRODUCT',
          operator_type: 'CROSS_PRODUCT',
          operator_timing: 0.35,
          operator_cardinality: 120000,
          children: [
            {
              operator_name: 'PARQUET_SCAN',
              operator_timing: 0.04,
              operator_cardinality: 400,
              operator_rows_scanned: 400,
              extra_info: {
                File: 'dim_users.parquet',
                Projections: ['user_id'],
              },
              children: [],
            },
            {
              operator_name: 'PARQUET_SCAN',
              operator_timing: 0.03,
              operator_cardinality: 300,
              operator_rows_scanned: 300,
              extra_info: {
                File: 'dim_regions.parquet',
                Projections: ['region_id'],
              },
              children: [],
            },
          ],
        },
      ],
    };

    const plan = parseDuckDbPlan(analyzePayload, 'analyze');
    expect(plan.mode).toBe('analyze');
    expect(plan.executionTimeMs).toBeCloseTo(420, 1);
    expect(plan.root.actualRows).toBe(120000);

    const findings = duckdbEngineAdapter.analyzePlan(plan, {
      seqScanRowThreshold: 1000,
      sql: "SELECT user_id, region_id FROM read_parquet('dim_users.parquet'), read_parquet('dim_regions.parquet')",
    });
    expect(findings.some((f) => f.ruleId === 'CARTESIAN_OR_UNBOUNDED_JOIN')).toBe(
      true,
    );
    expect(findings.some((f) => f.ruleId === 'PARQUET_PROJECTION_MISS')).toBe(
      false,
    );
  });
});
