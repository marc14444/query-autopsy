import type { DatabaseEngineAdapter } from '../engineRegistry.js';
import {
  classifySqlStatement,
  validateSafeCreateIndexSql,
} from '../../services/sqlClassifier.js';
import { analyzeMySqlPlan } from './mysqlDiagnostics.js';
import { parseMySqlPlan } from './mysqlPlanParser.js';

export const mysqlEngineAdapter: DatabaseEngineAdapter = {
  engine: 'mysql',
  capabilities: {
    supportsHypotheticalIndexes: false,
    supportsTransactionalWriteAnalyze: true,
    indexCreationKeyword: 'CREATE INDEX',
  },
  classifySql: (rawSql) => classifySqlStatement(rawSql, 'mysql'),
  validateSafeCreateIndexSql: (rawSql) =>
    validateSafeCreateIndexSql(rawSql, 'mysql'),
  parsePlan: (rawPayload, mode) => parseMySqlPlan(rawPayload, mode),
  analyzePlan: (plan, config) => analyzeMySqlPlan(plan, config),
};
