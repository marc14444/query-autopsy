import type { DatabaseEngine } from '../models/databaseEngine.js';
import type { DiagnosticFinding } from '../models/diagnostic.js';
import type { ExecutionPlan } from '../models/executionPlan.js';
import type { ClassifiedSql, ExplainMode } from '../models/queryRequest.js';
import type { DiagnosticConfig } from '../services/diagnosticEngine.js';
import { mysqlEngineAdapter } from './mysql/mysqlEngineAdapter.js';
import { postgresEngineAdapter } from './postgres/postgresEngineAdapter.js';
import { sqliteEngineAdapter } from './sqlite/sqliteEngineAdapter.js';

export interface DatabaseEngineCapabilities {
  readonly supportsHypotheticalIndexes: boolean;
  readonly supportsTransactionalWriteAnalyze: boolean;
  readonly indexCreationKeyword: string;
}

export interface DatabaseEngineAdapter {
  readonly engine: DatabaseEngine;
  readonly capabilities: DatabaseEngineCapabilities;
  classifySql(rawSql: string): ClassifiedSql;
  validateSafeCreateIndexSql(rawSql: string): string;
  parsePlan(rawPayload: unknown, mode: ExplainMode): ExecutionPlan;
  analyzePlan(
    plan: ExecutionPlan,
    config: DiagnosticConfig,
  ): readonly DiagnosticFinding[];
}

const ADAPTERS: Record<DatabaseEngine, DatabaseEngineAdapter> = {
  postgresql: postgresEngineAdapter,
  mysql: mysqlEngineAdapter,
  sqlite: sqliteEngineAdapter,
};

export function getEngineAdapter(
  engine: DatabaseEngine = 'postgresql',
): DatabaseEngineAdapter {
  return ADAPTERS[engine];
}
