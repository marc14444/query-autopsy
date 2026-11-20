import { describe, expect, it, vi } from 'vitest';
import { InspectQueryService } from '../../src/application/usecases/inspectQueryService.js';
import {
  MissingConnectionError,
  MissingParametersError,
  UnsafeQueryError,
} from '../../src/domain/errors/domainErrors.js';
import type { ConnectionProfile } from '../../src/domain/models/connectionProfile.js';
import type { InspectionReport } from '../../src/domain/models/diagnostic.js';
import type {
  ConnectionConfigPort,
  RuntimeSettings,
} from '../../src/domain/ports/outbound/connectionConfigPort.js';
import type { LoggerPort } from '../../src/domain/ports/outbound/loggerPort.js';
import type { QueryExecutorPort } from '../../src/domain/ports/outbound/queryExecutorPort.js';
import type { ReportPresenterPort } from '../../src/domain/ports/outbound/reportPresenterPort.js';

function createMocks(options?: {
  connectionString?: string | undefined;
  activeProfile?: ConnectionProfile | undefined;
  settings?: Partial<RuntimeSettings>;
}) {
  const defaultSettings: RuntimeSettings = {
    statementTimeoutMs: 5000,
    allowWriteAnalyze: false,
    seqScanRowThreshold: 1000,
    showRawJson: false,
    ...options?.settings,
  };

  const connectionConfig: ConnectionConfigPort = {
    getConnectionString: vi
      .fn()
      .mockResolvedValue(
        options && 'connectionString' in options
          ? options.connectionString
          : 'postgresql://postgres@localhost:5432/test',
      ),
    saveConnectionString: vi.fn().mockResolvedValue(undefined),
    clearConnectionString: vi.fn().mockResolvedValue(undefined),
    getActiveProfile: vi.fn().mockResolvedValue(options?.activeProfile),
    listProfiles: vi
      .fn()
      .mockResolvedValue(options?.activeProfile ? [options.activeProfile] : []),
    saveProfile: vi.fn(),
    setActiveProfile: vi.fn().mockResolvedValue(undefined),
    setProfileReadOnlyLock: vi.fn().mockResolvedValue(undefined),
    deleteProfile: vi.fn().mockResolvedValue(undefined),
    getRuntimeSettings: vi.fn().mockReturnValue(defaultSettings),
  };

  const sampleRawPlan = [
    {
      Plan: {
        'Node Type': 'Seq Scan',
        'Relation Name': 'orders',
        'Startup Cost': 0,
        'Total Cost': 1500,
        'Plan Rows': 5000,
        'Plan Width': 32,
        'Actual Startup Time': 0.01,
        'Actual Total Time': 12.5,
        'Actual Rows': 5000,
        'Actual Loops': 1,
        Filter: '(user_id = 42)',
        'Shared Hit Blocks': 400,
        'Shared Read Blocks': 0,
      },
      'Planning Time': 0.1,
      'Execution Time': 12.7,
    },
  ];

  const queryExecutor: QueryExecutorPort = {
    executeExplain: vi.fn().mockResolvedValue(sampleRawPlan),
    executeCreateIndex: vi.fn().mockResolvedValue(undefined),
    simulateHypotheticalIndex: vi.fn(),
    testConnection: vi.fn().mockResolvedValue({ serverVersion: 'PostgreSQL 16' }),
    dispose: vi.fn().mockResolvedValue(undefined),
  };

  let presentedReport: InspectionReport | undefined;
  const reportPresenter: ReportPresenterPort = {
    present: vi.fn(async (report) => {
      presentedReport = report;
    }),
  };

  const logger: LoggerPort = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  return {
    service: new InspectQueryService({
      connectionConfig,
      queryExecutor,
      reportPresenter,
      logger,
    }),
    connectionConfig,
    queryExecutor,
    reportPresenter,
    getPresentedReport: () => presentedReport,
  };
}

describe('InspectQueryService (Application Use Case)', () => {
  it('orchestrates classification, execution, parsing, diagnostics, and presentation', async () => {
    const { service, queryExecutor, getPresentedReport } = createMocks();

    const report = await service.execute({
      rawSql: 'SELECT * FROM orders WHERE user_id = 42;',
      mode: 'analyze',
    });

    expect(queryExecutor.executeExplain).toHaveBeenCalledOnce();
    expect(report.diagnostics).toHaveLength(1);
    expect(report.diagnostics[0]?.ruleId).toBe('SEQ_SCAN_LARGE_TABLE');
    expect(getPresentedReport()).toEqual(report);
  });

  it('blocks EXPLAIN ANALYZE on WRITE statements unless allowWriteAnalyze is enabled', async () => {
    const { service, queryExecutor } = createMocks({
      settings: { allowWriteAnalyze: false },
    });

    await expect(
      service.execute({
        rawSql: "DELETE FROM orders WHERE status = 'failed'",
        mode: 'analyze',
      }),
    ).rejects.toThrow(UnsafeQueryError);
    expect(queryExecutor.executeExplain).not.toHaveBeenCalled();

    const estimateReport = await service.execute({
      rawSql: "DELETE FROM orders WHERE status = 'failed'",
      mode: 'estimate',
    });
    expect(estimateReport.statementKind).toBe('WRITE');
  });

  it('always blocks DDL statements', async () => {
    const { service } = createMocks();
    await expect(
      service.execute({ rawSql: 'DROP TABLE orders', mode: 'estimate' }),
    ).rejects.toThrow(UnsafeQueryError);
  });

  it('throws MissingParametersError when positional parameters lack values', async () => {
    const { service } = createMocks();
    await expect(
      service.execute({
        rawSql: 'SELECT * FROM orders WHERE user_id = $1 AND status = $2',
        mode: 'analyze',
      }),
    ).rejects.toThrow(MissingParametersError);
  });

  it('throws MissingConnectionError when no PostgreSQL connection is configured', async () => {
    const { service } = createMocks({ connectionString: undefined });
    await expect(
      service.execute({ rawSql: 'SELECT 1', mode: 'analyze' }),
    ).rejects.toThrow(MissingConnectionError);
  });

  it('blocks WRITE EXPLAIN ANALYZE on readOnlyLocked profiles even when allowWriteAnalyze is true', async () => {
    const { service, queryExecutor } = createMocks({
      settings: { allowWriteAnalyze: true },
      activeProfile: {
        id: 'prod-ro',
        name: 'prod-replica',
        environment: 'production',
        readOnlyLocked: true,
        displayTarget: 'prod.db:5432/app',
      },
    });

    await expect(
      service.execute({
        rawSql: "DELETE FROM orders WHERE status = 'failed'",
        mode: 'analyze',
      }),
    ).rejects.toThrow(/Read-Only locked/);
    expect(queryExecutor.executeExplain).not.toHaveBeenCalled();
  });

  it('dispatches to MySQL engine adapter when active profile engine is mysql', async () => {
    const mysqlTree = [
      '-> Sort: orders.created_at DESC  (cost=150.0 rows=2000) (actual time=8.5..9.1 rows=200 loops=1)',
      '    -> Table scan on orders  (cost=120.0 rows=2000) (actual time=0.1..6.2 rows=2000 loops=1)',
    ].join('\n');

    const { service, queryExecutor } = createMocks({
      connectionString: 'mysql://root:pass@127.0.0.1:3306/app',
      activeProfile: {
        id: 'mysql-local',
        name: 'MySQL Local',
        engine: 'mysql',
        environment: 'local',
        readOnlyLocked: false,
        displayTarget: '127.0.0.1:3306/app',
      },
    });
    vi.mocked(queryExecutor.executeExplain).mockResolvedValueOnce(mysqlTree);

    const report = await service.execute({
      rawSql: 'SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC',
      mode: 'analyze',
      parameters: [42],
    });

    expect(report.engine).toBe('mysql');
    expect(report.diagnostics.map((d) => d.ruleId)).toEqual(
      expect.arrayContaining(['MYSQL_FULL_TABLE_SCAN', 'MYSQL_USING_FILESORT']),
    );
  });

  it('blocks dangerous SQL functions, blocks remote no-verify TLS on production, and redacts literals when privacy setting is enabled', async () => {
    const { service: pgGuardService, queryExecutor: guardExec } = createMocks();
    await expect(
      pgGuardService.execute({
        rawSql: "SELECT pg_read_file('/etc/passwd')",
        mode: 'estimate',
      }),
    ).rejects.toThrow(UnsafeQueryError);
    expect(guardExec.executeExplain).not.toHaveBeenCalled();

    const { service: prodTlsService, queryExecutor: prodExec } = createMocks({
      connectionString:
        'postgresql://user:pw@prod-db.internal:5432/app?sslmode=no-verify',
      activeProfile: {
        id: 'prod',
        name: 'Production',
        engine: 'postgresql',
        environment: 'production',
        readOnlyLocked: true,
        displayTarget: 'prod-db.internal:5432/app',
      },
    });
    await expect(
      prodTlsService.execute({
        rawSql: 'SELECT * FROM orders WHERE user_id = 42',
        mode: 'estimate',
      }),
    ).rejects.toThrow(/sslmode=no-verify/);
    expect(prodExec.executeExplain).not.toHaveBeenCalled();

    const { service: redactService, queryExecutor: redactExec } = createMocks({
      settings: { redactLiteralsInReports: true },
    });
    vi.mocked(redactExec.executeExplain).mockResolvedValueOnce([
      {
        Plan: {
          'Node Type': 'Seq Scan',
          'Relation Name': 'orders',
          'Startup Cost': 0,
          'Total Cost': 1500,
          'Plan Rows': 5000,
          'Plan Width': 32,
          'Actual Startup Time': 0.01,
          'Actual Total Time': 12.5,
          'Actual Rows': 5000,
          'Actual Loops': 1,
          Filter: "(email = 'alice@corp.com'::text)",
        },
        'Execution Time': 12.7,
      },
    ]);

    const redactedReport = await redactService.execute({
      rawSql: "SELECT id FROM orders WHERE email = 'alice@corp.com';",
      mode: 'analyze',
    });
    expect(redactedReport.sql).not.toContain('alice@corp.com');
    expect(redactedReport.sql).toContain("'[REDACTED]'");
    expect(redactedReport.plan.root.filter).not.toContain('alice@corp.com');
    expect(redactedReport.diagnostics[0]?.detail).not.toContain(
      'alice@corp.com',
    );
  });
});
