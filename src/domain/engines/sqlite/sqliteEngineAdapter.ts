import type { DatabaseEngineAdapter } from '../engineRegistry.js';
import {
  classifySqlStatement,
  validateSafeCreateIndexSql,
} from '../../services/sqlClassifier.js';
import { analyzeSqlitePlan } from './sqliteDiagnostics.js';
import { parseSqlitePlan } from './sqlitePlanParser.js';

export const sqliteEngineAdapter: DatabaseEngineAdapter = {
  engine: 'sqlite',
  capabilities: {
    supportsHypotheticalIndexes: false,
    supportsTransactionalWriteAnalyze: true,
    indexCreationKeyword: 'CREATE INDEX IF NOT EXISTS',
  },
  classifySql: (rawSql) => classifySqlStatement(rawSql, 'sqlite'),
  validateSafeCreateIndexSql: (rawSql) =>
    validateSafeCreateIndexSql(rawSql, 'sqlite'),
  parsePlan: (rawPayload, mode) => parseSqlitePlan(rawPayload, mode),
  analyzePlan: (plan, config) => analyzeSqlitePlan(plan, config),
};
