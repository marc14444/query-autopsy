import type { ExecutionPlan } from './executionPlan.js';
import type { ExplainMode, SqlStatementKind } from './queryRequest.js';

export type DiagnosticSeverity = 'critical' | 'warning' | 'info';

export type DiagnosticRuleId =
  | 'SEQ_SCAN_LARGE_TABLE'
  | 'EXTERNAL_DISK_SPILL'
  | 'PLANNER_ROW_MISESTIMATE'
  | 'LOW_CACHE_HIT_RATIO'
  | 'NESTED_LOOP_HIGH_LOOPS';

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
  readonly sql: string;
  readonly statementKind: SqlStatementKind;
  readonly mode: ExplainMode;
  readonly plan: ExecutionPlan;
  readonly diagnostics: readonly DiagnosticFinding[];
  readonly inspectedAtIso: string;
}
