import type { DatabaseEngineAdapter } from '../engineRegistry.js';
import {
  classifySqlStatement,
  validateSafeCreateIndexSql,
} from '../../services/sqlClassifier.js';
import { analyzeDuckDbPlan } from './duckdbDiagnostics.js';
import { parseDuckDbPlan } from './duckdbPlanParser.js';

export const duckdbEngineAdapter: DatabaseEngineAdapter = {
  engine: 'duckdb',
  capabilities: {
    supportsHypotheticalIndexes: false,
    supportsTransactionalWriteAnalyze: true,
    indexCreationKeyword: 'CREATE INDEX IF NOT EXISTS',
  },
  classifySql: (rawSql) => classifySqlStatement(rawSql, 'duckdb'),
  validateSafeCreateIndexSql: (rawSql) =>
    validateSafeCreateIndexSql(rawSql, 'duckdb'),
  parsePlan: (rawPayload, mode) => parseDuckDbPlan(rawPayload, mode),
  analyzePlan: (plan, config) => analyzeDuckDbPlan(plan, config),
};
