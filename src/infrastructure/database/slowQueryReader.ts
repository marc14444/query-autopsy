import mysql, { type RowDataPacket } from 'mysql2/promise';
import { Client } from 'pg';
import type { DatabaseEngine } from '../../domain/models/databaseEngine.js';
import type {
  SlowQueryEntry,
  SlowQueryFetchResult,
} from '../../domain/models/slowQuery.js';
import type { LoggerPort } from '../../domain/ports/outbound/loggerPort.js';
import type {
  FetchSlowQueriesOptions,
  SlowQueryPort,
} from '../../domain/ports/outbound/slowQueryPort.js';
import { mapMysqlError } from '../mysql/mysqlErrors.js';
import { buildMysqlConnectionOptions } from '../mysql/mysqlQueryExecutor.js';
import { mapPostgresError } from '../postgres/pgErrors.js';
import { buildPgPoolConfig } from '../postgres/pgQueryExecutor.js';

export class MultiEngineSlowQueryReader implements SlowQueryPort {
  constructor(private readonly logger: LoggerPort) {}

  async fetchTopSlowQueries(
    connectionString: string,
    engine: DatabaseEngine,
    options: FetchSlowQueriesOptions,
  ): Promise<SlowQueryFetchResult> {
    switch (engine) {
      case 'postgresql':
        return this.fetchPostgresSlowQueries(connectionString, options);
      case 'mysql':
        return this.fetchMysqlSlowQueries(connectionString, options);
      case 'sqlite':
        return {
          supported: false,
          engine: 'sqlite',
          reason:
            'SQLite does not persist server-side execution statistics. Use CodeLens or right-click EXPLAIN directly on SQL statements.',
        };
    }
  }

  private async fetchPostgresSlowQueries(
    connectionString: string,
    options: FetchSlowQueriesOptions,
  ): Promise<SlowQueryFetchResult> {
    const client = new Client({
      ...buildPgPoolConfig(connectionString),
      connectionTimeoutMillis: 5_000,
    });

    try {
      await client.connect();
      await client.query('SET statement_timeout = 5000');

      const extRes = await client.query<{ installed: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') AS installed",
      );
      if (!extRes.rows[0]?.installed) {
        return {
          supported: false,
          engine: 'postgresql',
          reason:
            'pg_stat_statements extension is not enabled. Set shared_preload_libraries = pg_stat_statements and run CREATE EXTENSION IF NOT EXISTS pg_stat_statements;',
        };
      }

      const colCheck = await client.query<{ has_exec_time: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'pg_stat_statements' AND column_name = 'total_exec_time') AS has_exec_time",
      );
      const usesModernCols = colCheck.rows[0]?.has_exec_time === true;
      const totalCol = usesModernCols ? 'total_exec_time' : 'total_time';
      const meanCol = usesModernCols ? 'mean_exec_time' : 'mean_time';
      const orderCol =
        options.sortBy === 'total_exec_time' ? totalCol : meanCol;

      const sql = `
        SELECT
          queryid::text AS query_id,
          query,
          calls::bigint AS calls,
          ${totalCol}::double precision AS total_exec_time_ms,
          ${meanCol}::double precision AS mean_exec_time_ms,
          rows::bigint AS rows,
          shared_blks_hit::bigint AS shared_blks_hit,
          shared_blks_read::bigint AS shared_blks_read
        FROM pg_stat_statements
        WHERE calls > 0
          AND query IS NOT NULL
          AND query NOT ILIKE 'EXPLAIN%'
          AND query NOT ILIKE '%pg_stat_statements%'
          AND query NOT ILIKE 'BEGIN%'
          AND query NOT ILIKE 'ROLLBACK%'
          AND query NOT ILIKE 'SET %'
        ORDER BY ${orderCol} DESC
        LIMIT $1
      `;

      const res = await client.query<{
        query_id: string | null;
        query: string;
        calls: string | number;
        total_exec_time_ms: number;
        mean_exec_time_ms: number;
        rows: string | number;
        shared_blks_hit: string | number;
        shared_blks_read: string | number;
      }>(sql, [options.limit]);

      const entries: SlowQueryEntry[] = res.rows.map((r, idx) => ({
        queryId: r.query_id ?? `pg-${idx}`,
        query: r.query.trim(),
        calls: Number(r.calls) || 0,
        totalExecTimeMs: Number(r.total_exec_time_ms) || 0,
        meanExecTimeMs: Number(r.mean_exec_time_ms) || 0,
        rows: Number(r.rows) || 0,
        sharedBlksHit: Number(r.shared_blks_hit) || 0,
        sharedBlksRead: Number(r.shared_blks_read) || 0,
      }));

      return {
        supported: true,
        engine: 'postgresql',
        entries,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes('shared_preload_libraries') ||
        msg.includes('permission denied')
      ) {
        this.logger.warn('pg_stat_statements inaccessible', { message: msg });
        return {
          supported: false,
          engine: 'postgresql',
          reason: msg,
        };
      }
      throw mapPostgresError(err);
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  private async fetchMysqlSlowQueries(
    connectionString: string,
    options: FetchSlowQueriesOptions,
  ): Promise<SlowQueryFetchResult> {
    const conn = await mysql
      .createConnection(buildMysqlConnectionOptions(connectionString))
      .catch((err) => {
        throw mapMysqlError(err);
      });

    try {
      const orderCol =
        options.sortBy === 'total_exec_time'
          ? 'SUM_TIMER_WAIT'
          : 'AVG_TIMER_WAIT';

      const [rows] = await conn.query<RowDataPacket[]>(
        `
        SELECT
          DIGEST AS digest_id,
          DIGEST_TEXT AS query_text,
          COUNT_STAR AS calls,
          SUM_TIMER_WAIT / 1000000000 AS total_exec_time_ms,
          AVG_TIMER_WAIT / 1000000000 AS mean_exec_time_ms,
          SUM_ROWS_SENT AS rows_sent
        FROM performance_schema.events_statements_summary_by_digest
        WHERE COUNT_STAR > 0
          AND DIGEST_TEXT IS NOT NULL
          AND UPPER(DIGEST_TEXT) NOT LIKE 'EXPLAIN%'
          AND UPPER(DIGEST_TEXT) NOT LIKE 'SHOW %'
          AND DIGEST_TEXT NOT LIKE '%performance_schema%'
        ORDER BY ${orderCol} DESC
        LIMIT ?
        `,
        [options.limit],
      );

      const entries: SlowQueryEntry[] = rows.map((row, idx) => {
        const rec = row as Record<string, unknown>;
        return {
          queryId:
            typeof rec['digest_id'] === 'string'
              ? rec['digest_id']
              : `mysql-${idx}`,
          query: String(rec['query_text'] ?? '').trim(),
          calls: Number(rec['calls'] ?? 0) || 0,
          totalExecTimeMs: Number(rec['total_exec_time_ms'] ?? 0) || 0,
          meanExecTimeMs: Number(rec['mean_exec_time_ms'] ?? 0) || 0,
          rows: Number(rec['rows_sent'] ?? 0) || 0,
          sharedBlksHit: 0,
          sharedBlksRead: 0,
        };
      });

      return {
        supported: true,
        engine: 'mysql',
        entries,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code =
        typeof err === 'object' && err !== null && 'code' in err
          ? String((err as { code?: unknown }).code)
          : '';
      if (
        code === 'ER_TABLEACCESS_DENIED_ERROR' ||
        code === 'ER_NO_SUCH_TABLE' ||
        code === 'ER_DBACCESS_DENIED_ERROR'
      ) {
        this.logger.warn('MySQL performance_schema unavailable', {
          message: msg,
        });
        return {
          supported: false,
          engine: 'mysql',
          reason:
            'MySQL performance_schema.events_statements_summary_by_digest is not enabled or accessible for this user.',
        };
      }
      throw mapMysqlError(err);
    } finally {
      await conn.end().catch(() => undefined);
    }
  }
}
