import type { ExplainExecutionRequest } from '../../models/queryRequest.js';

export interface HypotheticalSimulationOutput {
  readonly supported: boolean;
  readonly rawPlan?: unknown;
  readonly reason?: string | undefined;
}

export interface QueryExecutorPort {
  executeExplain(
    connectionString: string,
    request: ExplainExecutionRequest,
  ): Promise<unknown>;

  executeCreateIndex(
    connectionString: string,
    indexSql: string,
  ): Promise<void>;

  simulateHypotheticalIndex(
    connectionString: string,
    querySql: string,
    indexSql: string,
    parameters: readonly unknown[],
  ): Promise<HypotheticalSimulationOutput>;

  testConnection(
    connectionString: string,
  ): Promise<{
    serverVersion: string;
    isSuperuser?: boolean | undefined;
  }>;

  dispose(): Promise<void>;
}
