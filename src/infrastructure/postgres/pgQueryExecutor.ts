import { Client, type PoolConfig, Pool } from 'pg';
import { InvalidPlanError } from '../../domain/errors/domainErrors.js';
import type { ExplainExecutionRequest } from '../../domain/models/queryRequest.js';
import type { LoggerPort } from '../../domain/ports/outbound/loggerPort.js';
import type {
  HypotheticalSimulationOutput,
  QueryExecutorPort,
} from '../../domain/ports/outbound/queryExecutorPort.js';
import { mapPostgresError } from './pgErrors.js';

function buildPoolConfig(connectionString: string): PoolConfig {
  try {
    const parsed = new URL(connectionString);
    const sslMode = parsed.searchParams.get('sslmode')?.toLowerCase();
    if (sslMode === 'no-verify') {
      parsed.searchParams.delete('sslmode');
      return {
        connectionString: parsed.toString(),
        ssl: { rejectUnauthorized: false },
      };
    }
  } catch {
    // Fallback to raw connectionString
  }
  return { connectionString };
}

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

    const baseConfig = buildPoolConfig(connectionString);
    const nextPool = new Pool({
      ...baseConfig,
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

  async executeCreateIndex(
    connectionString: string,
    indexSql: string,
  ): Promise<void> {
    const pool = await this.getPool(connectionString);
    const client = await pool.connect().catch((err) => {
      throw mapPostgresError(err);
    });

    try {
      // CREATE INDEX CONCURRENTLY cannot execute inside a transaction block.
      await client.query(indexSql);
    } catch (err) {
      throw mapPostgresError(err);
    } finally {
      client.release();
    }
  }

  async simulateHypotheticalIndex(
    connectionString: string,
    querySql: string,
    indexSql: string,
    parameters: readonly unknown[],
  ): Promise<HypotheticalSimulationOutput> {
    const pool = await this.getPool(connectionString);
    const client = await pool.connect().catch((err) => {
      throw mapPostgresError(err);
    });

    try {
      const extCheck = await client.query<{ installed: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'hypopg') AS installed",
      );
      if (!extCheck.rows[0]?.installed) {
        return {
          supported: false,
          reason:
            'PostgreSQL extension "hypopg" is not installed on this database. Run "CREATE EXTENSION IF NOT EXISTS hypopg;" in dev to simulate indexes with zero disk writes.',
        };
      }

      await client.query('SELECT hypopg_reset()');
      await client.query('SELECT * FROM hypopg_create_index($1)', [indexSql]);

      const explainSql = `EXPLAIN (COSTS, VERBOSE, FORMAT JSON) ${querySql}`;
      const res =
        parameters.length > 0
          ? await client.query(explainSql, [...parameters])
          : await client.query(explainSql);

      const firstRow = res.rows[0] as Record<string, unknown> | undefined;
      const queryPlan = firstRow?.['QUERY PLAN'];
      if (queryPlan === undefined) {
        throw new InvalidPlanError(
          'PostgreSQL did not return a "QUERY PLAN" column during simulation.',
        );
      }

      return {
        supported: true,
        rawPlan: queryPlan,
      };
    } catch (err) {
      if (err instanceof InvalidPlanError) {
        throw err;
      }
      throw mapPostgresError(err);
    } finally {
      await client.query('SELECT hypopg_reset()').catch(() => undefined);
      client.release();
    }
  }

  async testConnection(
    connectionString: string,
  ): Promise<{ serverVersion: string }> {
    const baseConfig = buildPoolConfig(connectionString);
    const client = new Client({
      ...baseConfig,
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
