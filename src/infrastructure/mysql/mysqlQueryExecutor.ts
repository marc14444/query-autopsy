import mysql, {
  type ConnectionOptions,
  type Pool,
  type PoolOptions,
  type RowDataPacket,
} from 'mysql2/promise';
import { InvalidPlanError } from '../../domain/errors/domainErrors.js';
import type { ExplainExecutionRequest } from '../../domain/models/queryRequest.js';
import type { LoggerPort } from '../../domain/ports/outbound/loggerPort.js';
import type {
  HypotheticalSimulationOutput,
  QueryExecutorPort,
} from '../../domain/ports/outbound/queryExecutorPort.js';
import { mapMysqlError } from './mysqlErrors.js';

export function buildMysqlConnectionOptions(connectionString: string): ConnectionOptions {
  const normalized = connectionString.trim().replace(/^mysql2:\/\//i, 'mysql://');
  const parsed = new URL(normalized);
  const sslMode = parsed.searchParams.get('sslmode')?.toLowerCase();

  let ssl: ConnectionOptions['ssl'];
  if (sslMode === 'no-verify') {
    ssl = { rejectUnauthorized: false };
  } else if (sslMode === 'require' || sslMode === 'verify-ca' || sslMode === 'verify-full') {
    ssl = { rejectUnauthorized: true };
  }

  const database = parsed.pathname.replace(/^\/+/, '');
  return {
    host: parsed.hostname || '127.0.0.1',
    port: parsed.port ? Number(parsed.port) : 3306,
    user: parsed.username ? decodeURIComponent(parsed.username) : 'root',
    password: parsed.password ? decodeURIComponent(parsed.password) : '',
    ...(database ? { database: decodeURIComponent(database) } : {}),
    ...(ssl ? { ssl } : {}),
    connectTimeout: 5_000,
    multipleStatements: false,
  };
}

function extractExplainCell(rows: RowDataPacket[]): string {
  const first = rows[0] as Record<string, unknown> | undefined;
  if (!first) {
    throw new InvalidPlanError('MySQL EXPLAIN returned no rows.');
  }
  const value = first['EXPLAIN'] ?? Object.values(first)[0];
  if (typeof value !== 'string') {
    throw new InvalidPlanError(
      'MySQL EXPLAIN did not return a string plan payload.',
    );
  }
  return value;
}

export class MysqlQueryExecutor implements QueryExecutorPort {
  private pool: Pool | undefined;
  private activeConnectionString: string | undefined;

  constructor(private readonly logger: LoggerPort) {}

  private async getPool(connectionString: string): Promise<Pool> {
    if (this.pool && this.activeConnectionString === connectionString) {
      return this.pool;
    }

    if (this.pool) {
      await this.pool.end().catch((err) => {
        this.logger.warn('Failed to close previous MySQL pool cleanly', {
          error: String(err),
        });
      });
    }

    const poolOptions: PoolOptions = {
      ...buildMysqlConnectionOptions(connectionString),
      connectionLimit: 4,
      waitForConnections: true,
    };

    const nextPool = mysql.createPool(poolOptions);
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

    const conn = await pool.getConnection().catch((err) => {
      throw mapMysqlError(err);
    });

    try {
      await conn
        .query(`SET SESSION max_execution_time = ${timeoutMs}`)
        .catch(() => undefined);

      const beginSql =
        request.mode === 'analyze' && request.kind === 'READ'
          ? 'START TRANSACTION READ ONLY'
          : 'START TRANSACTION';
      await conn.query(beginSql);

      const explainSql =
        request.mode === 'analyze'
          ? `EXPLAIN ANALYZE ${request.sql}`
          : `EXPLAIN FORMAT=JSON ${request.sql}`;

      const [rows] = await conn.query<RowDataPacket[]>(
        explainSql,
        request.parameters.length > 0 ? [...request.parameters] : undefined,
      );

      return extractExplainCell(rows);
    } catch (err) {
      if (err instanceof InvalidPlanError) {
        throw err;
      }
      throw mapMysqlError(err);
    } finally {
      await conn.query('ROLLBACK').catch((rollbackErr) => {
        this.logger.warn('MySQL rollback warning during EXPLAIN cleanup', {
          error: String(rollbackErr),
        });
      });
      conn.release();
    }
  }

  async executeCreateIndex(
    connectionString: string,
    indexSql: string,
  ): Promise<void> {
    const pool = await this.getPool(connectionString);
    const conn = await pool.getConnection().catch((err) => {
      throw mapMysqlError(err);
    });

    try {
      await conn.query(indexSql);
    } catch (err) {
      throw mapMysqlError(err);
    } finally {
      conn.release();
    }
  }

  async simulateHypotheticalIndex(
    _connectionString: string,
    _querySql: string,
    _indexSql: string,
    _parameters: readonly unknown[],
  ): Promise<HypotheticalSimulationOutput> {
    return {
      supported: false,
      reason:
        'Hypothetical index simulation (HypoPG) is only supported on PostgreSQL.',
    };
  }

  async testConnection(
    connectionString: string,
  ): Promise<{ serverVersion: string }> {
    const conn = await mysql
      .createConnection(buildMysqlConnectionOptions(connectionString))
      .catch((err) => {
        throw mapMysqlError(err);
      });

    try {
      const [rows] = await conn.query<RowDataPacket[]>(
        'SELECT VERSION() AS version',
      );
      const rawVer = (rows[0] as Record<string, unknown> | undefined)?.[
        'version'
      ];
      return {
        serverVersion:
          typeof rawVer === 'string' ? `MySQL ${rawVer}` : 'MySQL (unknown)',
      };
    } catch (err) {
      throw mapMysqlError(err);
    } finally {
      await conn.end().catch(() => undefined);
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
