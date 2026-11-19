import { Client, Pool } from 'pg';
import { InvalidPlanError } from '../../domain/errors/domainErrors.js';
import type { ExplainExecutionRequest } from '../../domain/models/queryRequest.js';
import type { LoggerPort } from '../../domain/ports/outbound/loggerPort.js';
import type { QueryExecutorPort } from '../../domain/ports/outbound/queryExecutorPort.js';
import { mapPostgresError } from './pgErrors.js';

export class PgQueryExecutor implements QueryExecutorPort {
  private pool: Pool | undefined;
  private activeConnectionString: string | undefined;

  constructor(private readonly logger: LoggerPort) {}

  private async getPool(connectionString: string): Promise<Pool> {
    if (this.pool && this.activeConnectionString === connectionString) {
      return this.pool;
    }

    if (this.pool) {
      await this.pool.end().catch((err) => {
        this.logger.warn('Failed to close previous pg pool cleanly', {
          error: String(err),
        });
      });
    }

    const nextPool = new Pool({
      connectionString,
      max: 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });

    nextPool.on('error', (err) => {
      this.logger.error('Unexpected idle PostgreSQL client error', {
        message: err.message,
      });
    });

    this.pool = nextPool;
    this.activeConnectionString = connectionString;
    return nextPool;
  }

  async executeExplain(
    connectionString: string,
    request: ExplainExecutionRequest,
  ): Promise<unknown> {
    const pool = await this.getPool(connectionString);
    const timeoutMs = Math.min(
      120_000,
      Math.max(100, Math.trunc(request.statementTimeoutMs)),
    );

    const explainPrefix =
      request.mode === 'analyze'
        ? 'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)'
        : 'EXPLAIN (COSTS, VERBOSE, FORMAT JSON)';

    const explainSql = `${explainPrefix} ${request.sql}`;

    const client = await pool.connect().catch((err) => {
      throw mapPostgresError(err);
    });

    try {
      const beginSql =
        request.mode === 'analyze' && request.kind === 'READ'
          ? 'BEGIN READ ONLY'
          : 'BEGIN';

      await client.query(beginSql);
      await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);

      const result =
        request.parameters.length > 0
          ? await client.query(explainSql, [...request.parameters])
          : await client.query(explainSql);

      const firstRow = result.rows[0] as
        | Record<string, unknown>
        | undefined;
      const queryPlan = firstRow?.['QUERY PLAN'];
      if (queryPlan === undefined) {
        throw new InvalidPlanError(
          'PostgreSQL did not return a "QUERY PLAN" column.',
        );
      }

      return queryPlan;
    } catch (err) {
      if (err instanceof InvalidPlanError) {
        throw err;
      }
      throw mapPostgresError(err);
    } finally {
      await client.query('ROLLBACK').catch((rollbackErr) => {
        this.logger.warn('Rollback warning during EXPLAIN cleanup', {
          error: String(rollbackErr),
        });
      });
      client.release();
    }
  }

  async testConnection(
    connectionString: string,
  ): Promise<{ serverVersion: string }> {
    const client = new Client({
      connectionString,
      connectionTimeoutMillis: 5_000,
    });

    try {
      await client.connect();
      const res = await client.query<{ version: string }>(
        'SELECT version() AS version',
      );
      return { serverVersion: res.rows[0]?.version ?? 'PostgreSQL (unknown)' };
    } catch (err) {
      throw mapPostgresError(err);
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  async dispose(): Promise<void> {
    if (this.pool) {
      const currentPool = this.pool;
      this.pool = undefined;
      this.activeConnectionString = undefined;
      await currentPool.end();
    }
  }
}
