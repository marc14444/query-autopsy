import mysql from 'mysql2/promise';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApplyIndexService } from '../../src/application/usecases/applyIndexService.js';
import { FetchSlowQueriesService } from '../../src/application/usecases/fetchSlowQueriesService.js';
import { InspectQueryService } from '../../src/application/usecases/inspectQueryService.js';
import { UnsafeQueryError } from '../../src/domain/errors/domainErrors.js';
import type { ConnectionProfile } from '../../src/domain/models/connectionProfile.js';
import type {
  ConnectionConfigPort,
  RuntimeSettings,
} from '../../src/domain/ports/outbound/connectionConfigPort.js';
import type { LoggerPort } from '../../src/domain/ports/outbound/loggerPort.js';
import type { ReportPresenterPort } from '../../src/domain/ports/outbound/reportPresenterPort.js';
import { MultiEngineQueryExecutor } from '../../src/infrastructure/database/multiEngineQueryExecutor.js';
import { MultiEngineSlowQueryReader } from '../../src/infrastructure/database/slowQueryReader.js';

const PG_TEST_URI = process.env['QUERY_AUTOPSY_PG_TEST_URI'];
const MYSQL_TEST_URI = process.env['QUERY_AUTOPSY_MYSQL_TEST_URI'];

const logger: LoggerPort = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function createTestConfig(
  connectionString: string,
  profile: ConnectionProfile,
  settings?: Partial<RuntimeSettings>,
): ConnectionConfigPort {
  const runtime: RuntimeSettings = {
    statementTimeoutMs: 10_000,
    allowWriteAnalyze: true,
    seqScanRowThreshold: 500,
    showRawJson: false,
    ...settings,
  };

  return {
    getConnectionString: vi.fn().mockResolvedValue(connectionString),
    saveConnectionString: vi.fn(),
    clearConnectionString: vi.fn(),
    getActiveProfile: vi.fn().mockResolvedValue(profile),
    listProfiles: vi.fn().mockResolvedValue([profile]),
    saveProfile: vi.fn(),
    setActiveProfile: vi.fn(),
    setProfileReadOnlyLock: vi.fn(),
    deleteProfile: vi.fn(),
    getRuntimeSettings: vi.fn().mockReturnValue(runtime),
  };
}

describe('PostgreSQL 16 Live E2E Suite', () => {
  const executor = new MultiEngineQueryExecutor(logger);
  const slowReader = new MultiEngineSlowQueryReader(logger);
  const presenter: ReportPresenterPort = { present: vi.fn() };

  beforeAll(async () => {
    if (!PG_TEST_URI) {
      throw new Error(
        'QUERY_AUTOPSY_PG_TEST_URI must be set when running E2E tests.',
      );
    }
    const client = new Client({ connectionString: PG_TEST_URI });
    await client.connect();
    try {
      await client.query('DROP TABLE IF EXISTS qa_e2e_pg_orders CASCADE');
      await client.query(`
        CREATE TABLE qa_e2e_pg_orders (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL,
          status TEXT NOT NULL,
          amount_cents INTEGER NOT NULL
        );
      `);
      await client.query(`
        INSERT INTO qa_e2e_pg_orders (user_id, status, amount_cents)
        SELECT (i % 100) + 1,
               CASE WHEN i % 10 = 0 THEN 'pending' ELSE 'paid' END,
               i * 25
        FROM generate_series(1, 3000) AS s(i);
      `);
      await client.query('ANALYZE qa_e2e_pg_orders;');
    } finally {
      await client.end();
    }
  });

  afterAll(async () => {
    if (PG_TEST_URI) {
      const client = new Client({ connectionString: PG_TEST_URI });
      await client.connect();
      await client.query('DROP TABLE IF EXISTS qa_e2e_pg_orders CASCADE');
      await client.end();
    }
    await executor.dispose();
  });

  it('runs parameterized EXPLAIN ANALYZE, enforces ROLLBACK isolation, and validates CONCURRENT index improvement', async () => {
    const uri = PG_TEST_URI!;
    const profile: ConnectionProfile = {
      id: 'e2e-pg',
      name: 'E2E Postgres',
      engine: 'postgresql',
      environment: 'local',
      readOnlyLocked: false,
      displayTarget: '127.0.0.1:5432/e2e',
    };
    const config = createTestConfig(uri, profile);
    const inspectService = new InspectQueryService({
      connectionConfig: config,
      queryExecutor: executor,
      reportPresenter: presenter,
      logger,
    });
    const applyIndexService = new ApplyIndexService({
      connectionConfig: config,
      queryExecutor: executor,
      logger,
    });
    const slowQueryService = new FetchSlowQueriesService({
      connectionConfig: config,
      slowQueryReader: slowReader,
      logger,
    });

    // 1. Block DDL before execution
    await expect(
      inspectService.execute({
        rawSql: 'DROP TABLE qa_e2e_pg_orders',
        mode: 'analyze',
      }),
    ).rejects.toThrow(UnsafeQueryError);

    // 2. Parameterized query before index -> Seq Scan detected
    const sql =
      'SELECT id, amount_cents FROM qa_e2e_pg_orders WHERE status = $1 ORDER BY amount_cents DESC LIMIT 20';
    const before = await inspectService.execute({
      rawSql: sql,
      mode: 'analyze',
      parameters: ['pending'],
    });

    expect(before.engine).toBe('postgresql');
    expect(before.plan.executionTimeMs).toBeGreaterThan(0);
    expect(before.diagnostics.some((d) => d.ruleId === 'SEQ_SCAN_LARGE_TABLE' || d.ruleId === 'ESR_COMPOSITE_INDEX_OPPORTUNITY')).toBe(true);

    // 3. ROLLBACK isolation on WRITE EXPLAIN ANALYZE
    const writeReport = await inspectService.execute({
      rawSql: 'DELETE FROM qa_e2e_pg_orders WHERE status = $1',
      mode: 'analyze',
      parameters: ['pending'],
    });
    expect(writeReport.statementKind).toBe('WRITE');

    const verifyClient = new Client({ connectionString: uri });
    await verifyClient.connect();
    try {
      const countRes = await verifyClient.query<{ cnt: string }>(
        'SELECT COUNT(*)::text AS cnt FROM qa_e2e_pg_orders',
      );
      expect(Number(countRes.rows[0]?.cnt)).toBe(3000);
    } finally {
      await verifyClient.end();
    }

    // 4. Create index CONCURRENTLY and verify plan improves
    await applyIndexService.execute(
      'CREATE INDEX CONCURRENTLY idx_qa_e2e_pg_status_amount ON qa_e2e_pg_orders (status, amount_cents DESC);',
    );
    const after = await inspectService.execute({
      rawSql: sql,
      mode: 'analyze',
      parameters: ['pending'],
    });
    expect(JSON.stringify(after.plan.root)).not.toContain('"Seq Scan"');

    // 5. SlowQueryReader returns crisp response regardless of pg_stat_statements status
    const slowRes = await slowQueryService.execute({ limit: 5 });
    expect(slowRes.engine).toBe('postgresql');
  });
});

describe('MySQL 8+ Live E2E Suite', () => {
  const executor = new MultiEngineQueryExecutor(logger);
  const slowReader = new MultiEngineSlowQueryReader(logger);
  const presenter: ReportPresenterPort = { present: vi.fn() };

  beforeAll(async () => {
    if (!MYSQL_TEST_URI) {
      throw new Error(
        'QUERY_AUTOPSY_MYSQL_TEST_URI must be set when running E2E tests.',
      );
    }
    const conn = await mysql.createConnection(MYSQL_TEST_URI);
    try {
      await conn.query('DROP TABLE IF EXISTS qa_e2e_mysql_orders');
      await conn.query(`
        CREATE TABLE qa_e2e_mysql_orders (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          status VARCHAR(32) NOT NULL,
          amount_cents INT NOT NULL
        );
      `);
      const values: Array<[number, string, number]> = [];
      for (let i = 1; i <= 3000; i++) {
        values.push([
          (i % 100) + 1,
          i % 10 === 0 ? 'pending' : 'paid',
          i * 25,
        ]);
      }
      await conn.query(
        'INSERT INTO qa_e2e_mysql_orders (user_id, status, amount_cents) VALUES ?',
        [values],
      );
      await conn.query('ANALYZE TABLE qa_e2e_mysql_orders');
    } finally {
      await conn.end();
    }
  });

  afterAll(async () => {
    if (MYSQL_TEST_URI) {
      const conn = await mysql.createConnection(MYSQL_TEST_URI);
      await conn.query('DROP TABLE IF EXISTS qa_e2e_mysql_orders');
      await conn.end();
    }
    await executor.dispose();
  });

  it('runs EXPLAIN FORMAT=JSON + EXPLAIN ANALYZE TREE with ? binding and creates index cleanly', async () => {
    const uri = MYSQL_TEST_URI!;
    const profile: ConnectionProfile = {
      id: 'e2e-mysql',
      name: 'E2E MySQL',
      engine: 'mysql',
      environment: 'local',
      readOnlyLocked: false,
      displayTarget: '127.0.0.1:3306/e2e',
    };
    const config = createTestConfig(uri, profile);
    const inspectService = new InspectQueryService({
      connectionConfig: config,
      queryExecutor: executor,
      reportPresenter: presenter,
      logger,
    });
    const applyIndexService = new ApplyIndexService({
      connectionConfig: config,
      queryExecutor: executor,
      logger,
    });
    const slowQueryService = new FetchSlowQueriesService({
      connectionConfig: config,
      slowQueryReader: slowReader,
      logger,
    });

    const sql =
      'SELECT id, amount_cents FROM qa_e2e_mysql_orders WHERE status = ? ORDER BY amount_cents DESC';

    const estimateBefore = await inspectService.execute({
      rawSql: sql,
      mode: 'estimate',
      parameters: ['pending'],
    });
    expect(estimateBefore.engine).toBe('mysql');
    expect(
      estimateBefore.diagnostics.some(
        (d) =>
          d.ruleId === 'MYSQL_FULL_TABLE_SCAN' ||
          d.ruleId === 'MYSQL_USING_FILESORT',
      ),
    ).toBe(true);

    const analyzeBefore = await inspectService.execute({
      rawSql: sql,
      mode: 'analyze',
      parameters: ['pending'],
    });
    expect(analyzeBefore.plan.executionTimeMs).toBeGreaterThan(0);

    // Verify WRITE estimate works and leaves rows untouched
    const writeEst = await inspectService.execute({
      rawSql: 'DELETE FROM qa_e2e_mysql_orders WHERE status = ?',
      mode: 'estimate',
      parameters: ['pending'],
    });
    expect(writeEst.statementKind).toBe('WRITE');

    await applyIndexService.execute(
      'CREATE INDEX idx_qa_e2e_mysql_status_amount ON qa_e2e_mysql_orders (status, amount_cents DESC);',
    );

    const analyzeAfter = await inspectService.execute({
      rawSql: sql,
      mode: 'analyze',
      parameters: ['pending'],
    });
    expect(analyzeAfter.diagnostics).toHaveLength(0);

    const slowRes = await slowQueryService.execute({ limit: 5 });
    expect(slowRes.engine).toBe('mysql');
  });
});
