import type { DatabaseEngine } from './databaseEngine.js';
import type { ExecutionPlan } from './executionPlan.js';
import type { ExplainMode, SqlStatementKind } from './queryRequest.js';

export type DiagnosticSeverity = 'critical' | 'warning' | 'info';

export type WorkloadProfile = 'auto' | 'oltp' | 'analytics';

export type DiagnosticRuleId =
  | 'SEQ_SCAN_LARGE_TABLE'
  | 'ESR_COMPOSITE_INDEX_OPPORTUNITY'
  | 'NON_SARGABLE_PREDICATE'
  | 'CORRELATED_SUBPLAN'
  | 'BITMAP_LOSSY_BLOCKS'
  | 'EXTERNAL_DISK_SPILL'
  | 'HASH_AGG_OR_JOIN_DISK_SPILL'
  | 'SELECT_STAR_WIDE_SCAN'
  | 'MISSING_PARTITION_PRUNING'
  | 'CARTESIAN_OR_UNBOUNDED_JOIN'
  | 'PLANNER_ROW_MISESTIMATE'
  | 'LOW_CACHE_HIT_RATIO'
  | 'NESTED_LOOP_HIGH_LOOPS'
  | 'MYSQL_FULL_TABLE_SCAN'
  | 'MYSQL_USING_FILESORT'
  | 'MYSQL_USING_TEMPORARY'
  | 'SQLITE_FULL_TABLE_SCAN'
  | 'SQLITE_TEMP_BTREE_SORT'
  | 'PARQUET_PROJECTION_MISS'
  | 'PARQUET_PREDICATE_PUSHDOWN_MISS'
  | 'DUCKDB_OUT_OF_CORE_SPILL';

export interface IndexSuggestion {
  readonly table: string;
  readonly columns: readonly string[];
  readonly sql: string;
}

export interface DiagnosticFinding {
  readonly ruleId: DiagnosticRuleId;
  readonly severity: DiagnosticSeverity;
  readonly nodeId: string;
  readonly nodeType: string;
  readonly relationName?: string | undefined;
  readonly title: string;
  readonly detail: string;
  readonly recommendation: string;
  readonly indexSuggestion?: IndexSuggestion | undefined;
}

export interface InspectionReport {
  readonly engine?: DatabaseEngine | undefined;
  readonly sql: string;
  readonly statementKind: SqlStatementKind;
  readonly mode: ExplainMode;
  readonly plan: ExecutionPlan;
  readonly diagnostics: readonly DiagnosticFinding[];
  readonly inspectedAtIso: string;
  readonly profileName?: string | undefined;
  readonly readOnlyLocked?: boolean | undefined;
}
