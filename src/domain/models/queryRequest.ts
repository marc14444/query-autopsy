export type ExplainMode = 'analyze' | 'estimate';

export type SqlStatementKind = 'READ' | 'WRITE' | 'DDL' | 'EXPLAIN' | 'UNKNOWN';

export interface ClassifiedSql {
  readonly normalizedSql: string;
  readonly kind: SqlStatementKind;
  readonly parameterIndices: readonly number[];
}

export interface InspectQueryInput {
  readonly rawSql: string;
  readonly mode: ExplainMode;
  readonly parameters?: readonly unknown[] | undefined;
}

export interface ExplainExecutionRequest {
  readonly sql: string;
  readonly kind: SqlStatementKind;
  readonly mode: ExplainMode;
  readonly parameters: readonly unknown[];
  readonly statementTimeoutMs: number;
  readonly allowWriteAnalyze: boolean;
}
