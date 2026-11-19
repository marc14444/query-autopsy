import type { ExplainExecutionRequest } from '../../models/queryRequest.js';

export interface QueryExecutorPort {
  executeExplain(
    connectionString: string,
    request: ExplainExecutionRequest,
  ): Promise<unknown>;

  testConnection(connectionString: string): Promise<{ serverVersion: string }>;

  dispose(): Promise<void>;
}
