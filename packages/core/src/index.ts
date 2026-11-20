export * from './domain/errors/domainErrors.js';
export * from './domain/models/connectionProfile.js';
export * from './domain/models/databaseEngine.js';
export * from './domain/models/diagnostic.js';
export * from './domain/models/executionPlan.js';
export * from './domain/models/queryRequest.js';
export * from './domain/models/slowQuery.js';

export type { ApplyIndexUseCase } from './domain/ports/inbound/applyIndexUseCase.js';
export type {
  FetchSlowQueriesInput,
  FetchSlowQueriesUseCase,
} from './domain/ports/inbound/fetchSlowQueriesUseCase.js';
export type { InspectQueryUseCase } from './domain/ports/inbound/inspectQueryUseCase.js';
export type {
  SimulateIndexInput,
  SimulateIndexResult,
  SimulateIndexUseCase,
} from './domain/ports/inbound/simulateIndexUseCase.js';

export type {
  ConnectionConfigPort,
  RuntimeSettings,
} from './domain/ports/outbound/connectionConfigPort.js';
export type { LoggerPort } from './domain/ports/outbound/loggerPort.js';
export type {
  HypotheticalSimulationOutput,
  QueryExecutorPort,
} from './domain/ports/outbound/queryExecutorPort.js';
export type { ReportPresenterPort } from './domain/ports/outbound/reportPresenterPort.js';
export type {
  FetchSlowQueriesOptions,
  SlowQueryPort,
} from './domain/ports/outbound/slowQueryPort.js';

export * from './domain/engines/engineRegistry.js';
export { analyzeMySqlPlan } from './domain/engines/mysql/mysqlDiagnostics.js';
export { mysqlEngineAdapter } from './domain/engines/mysql/mysqlEngineAdapter.js';
export { parseMySqlPlan } from './domain/engines/mysql/mysqlPlanParser.js';
export { postgresEngineAdapter } from './domain/engines/postgres/postgresEngineAdapter.js';
export * from './domain/engines/sqlHintUtils.js';
export { analyzeSqlitePlan } from './domain/engines/sqlite/sqliteDiagnostics.js';
export { sqliteEngineAdapter } from './domain/engines/sqlite/sqliteEngineAdapter.js';
export {
  parseSqlitePlan,
  type SqliteEqpRow,
  type SqliteRawPlanPayload,
} from './domain/engines/sqlite/sqlitePlanParser.js';

export * from './domain/services/diagnosticEngine.js';
export * from './domain/services/envDiscovery.js';
export * from './domain/services/markdownReportFormatter.js';
export * from './domain/services/nodeExplainer.js';
export * from './domain/services/planDiff.js';
export * from './domain/services/planParser.js';
export * from './domain/services/sqlBlockExtractor.js';
export * from './domain/services/sqlClassifier.js';
export * from './domain/services/sqlSecurity.js';
export * from './domain/services/sqlTokenizer.js';

export * from './application/config/staticConnectionConfig.js';
export * from './application/usecases/applyIndexService.js';
export * from './application/usecases/fetchSlowQueriesService.js';
export * from './application/usecases/inspectQueryService.js';
export * from './application/usecases/simulateIndexService.js';
