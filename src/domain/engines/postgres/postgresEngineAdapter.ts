import type { DatabaseEngineAdapter } from '../engineRegistry.js';
import { analyzeExecutionPlan } from '../../services/diagnosticEngine.js';
import { parsePostgreSqlPlan } from '../../services/planParser.js';
import {
  classifySqlStatement,
  validateSafeCreateIndexSql,
} from '../../services/sqlClassifier.js';

export const postgresEngineAdapter: DatabaseEngineAdapter = {
  engine: 'postgresql',
  capabilities: {
    supportsHypotheticalIndexes: true,
    supportsTransactionalWriteAnalyze: true,
    indexCreationKeyword: 'CREATE INDEX CONCURRENTLY',
  },
  classifySql: (rawSql) => classifySqlStatement(rawSql, 'postgresql'),
  validateSafeCreateIndexSql: (rawSql) =>
    validateSafeCreateIndexSql(rawSql, 'postgresql'),
  parsePlan: (rawPayload, mode) => ({
    ...parsePostgreSqlPlan(rawPayload, mode),
    engine: 'postgresql',
  }),
  analyzePlan: (plan, config) => analyzeExecutionPlan(plan, config),
};
