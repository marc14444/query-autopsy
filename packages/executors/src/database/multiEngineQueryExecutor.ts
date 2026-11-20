import {
  type DatabaseEngine,
  detectDatabaseEngineFromUri,
  type ExplainExecutionRequest,
  type HypotheticalSimulationOutput,
  type LoggerPort,
  type QueryExecutorPort,
} from '@query-autopsy/core';
import { MysqlQueryExecutor } from '../mysql/mysqlQueryExecutor.js';
import { PgQueryExecutor } from '../postgres/pgQueryExecutor.js';
import {
  type SqliteExecutorOptions,
  SqliteQueryExecutor,
} from '../sqlite/sqliteQueryExecutor.js';

export class MultiEngineQueryExecutor implements QueryExecutorPort {
  private readonly executors: Record<DatabaseEngine, QueryExecutorPort>;

  constructor(logger: LoggerPort, sqliteOptions?: SqliteExecutorOptions) {
    this.executors = {
      postgresql: new PgQueryExecutor(logger),
      mysql: new MysqlQueryExecutor(logger),
      sqlite: new SqliteQueryExecutor(logger, sqliteOptions),
    };
  }

  private resolveExecutor(
    connectionString: string,
    explicitEngine?: DatabaseEngine,
  ): QueryExecutorPort {
    const engine = explicitEngine ?? detectDatabaseEngineFromUri(connectionString);
    return this.executors[engine];
  }

  executeExplain(
    connectionString: string,
    request: ExplainExecutionRequest,
  ): Promise<unknown> {
    return this.resolveExecutor(connectionString, request.engine).executeExplain(
      connectionString,
      request,
    );
  }

  executeCreateIndex(
    connectionString: string,
    indexSql: string,
  ): Promise<void> {
    return this.resolveExecutor(connectionString).executeCreateIndex(
      connectionString,
      indexSql,
    );
  }

  simulateHypotheticalIndex(
    connectionString: string,
    querySql: string,
    indexSql: string,
    parameters: readonly unknown[],
  ): Promise<HypotheticalSimulationOutput> {
    return this.resolveExecutor(connectionString).simulateHypotheticalIndex(
      connectionString,
      querySql,
      indexSql,
      parameters,
    );
  }

  testConnection(
    connectionString: string,
  ): Promise<{
    serverVersion: string;
    isSuperuser?: boolean | undefined;
  }> {
    return this.resolveExecutor(connectionString).testConnection(
      connectionString,
    );
  }

  async dispose(): Promise<void> {
    await Promise.all(
      Object.values(this.executors).map((executor) => executor.dispose()),
    );
  }
}
