import { describe, expect, it, vi } from 'vitest';
import { SimulateIndexService } from '../../src/application/usecases/simulateIndexService.js';
import { UnsafeQueryError } from '../../src/domain/errors/domainErrors.js';
import type { ConnectionConfigPort } from '../../src/domain/ports/outbound/connectionConfigPort.js';
import type { LoggerPort } from '../../src/domain/ports/outbound/loggerPort.js';
import type { QueryExecutorPort } from '../../src/domain/ports/outbound/queryExecutorPort.js';

function createMocks(options?: { supported?: boolean }) {
  const connectionConfig: ConnectionConfigPort = {
    getConnectionString: vi
      .fn()
      .mockResolvedValue('postgresql://postgres@localhost:5432/test'),
    saveConnectionString: vi.fn(),
    clearConnectionString: vi.fn(),
    getActiveProfile: vi.fn(),
    listProfiles: vi.fn().mockResolvedValue([]),
    saveProfile: vi.fn(),
    setActiveProfile: vi.fn(),
    setProfileReadOnlyLock: vi.fn(),
    deleteProfile: vi.fn(),
    getRuntimeSettings: vi.fn(),
  };

  const simRawPlan = [
    {
      Plan: {
        'Node Type': 'Bitmap Heap Scan',
        'Relation Name': 'orders',
        'Startup Cost': 4.4,
        'Total Cost': 60.0,
        'Plan Rows': 15,
        'Plan Width': 25,
        Plans: [
          {
            'Node Type': 'Bitmap Index Scan',
            'Index Name': '<hypopg>_idx_orders_user_id',
            'Startup Cost': 0,
            'Total Cost': 4.4,
            'Plan Rows': 15,
            'Plan Width': 0,
          },
        ],
      },
    },
  ];

  const queryExecutor: QueryExecutorPort = {
    executeExplain: vi.fn(),
    executeCreateIndex: vi.fn(),
    simulateHypotheticalIndex: vi.fn().mockResolvedValue(
      options?.supported === false
        ? { supported: false, reason: 'hypopg missing' }
        : { supported: true, rawPlan: simRawPlan },
    ),
    testConnection: vi.fn(),
    dispose: vi.fn(),
  };

  const logger: LoggerPort = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  return {
    service: new SimulateIndexService({
      connectionConfig,
      queryExecutor,
      logger,
    }),
    queryExecutor,
  };
}

describe('SimulateIndexService', () => {
  it('computes simulated cost reduction and plan summary when HypoPG is installed', async () => {
    const { service } = createMocks({ supported: true });
    const result = await service.execute({
      querySql: 'SELECT * FROM orders WHERE user_id = 42',
      indexSql: 'CREATE INDEX CONCURRENTLY idx_orders_user_id ON orders (user_id);',
      baselineCost: 5000,
    });

    expect(result.supported).toBe(true);
    expect(result.simulatedCost).toBe(60);
    expect(result.costDeltaPercent).toBeCloseTo(-98.8);
    expect(result.simulatedPlanSummary).toContain('Bitmap Heap Scan(orders)');
  });

  it('returns clear non-fatal notice when HypoPG extension is unavailable', async () => {
    const { service } = createMocks({ supported: false });
    const result = await service.execute({
      querySql: 'SELECT * FROM orders WHERE user_id = 42',
      indexSql: 'CREATE INDEX CONCURRENTLY idx_orders_user_id ON orders (user_id);',
      baselineCost: 5000,
    });

    expect(result.supported).toBe(false);
    expect(result.message).toBe('hypopg missing');
  });

  it('blocks unsafe non-index SQL in simulation input', async () => {
    const { service, queryExecutor } = createMocks();
    await expect(
      service.execute({
        querySql: 'SELECT 1',
        indexSql: 'DROP TABLE orders;',
        baselineCost: 1,
      }),
    ).rejects.toThrow(UnsafeQueryError);
    expect(queryExecutor.simulateHypotheticalIndex).not.toHaveBeenCalled();
  });

  it('returns unsupported notice cleanly for non-PostgreSQL engines (MySQL/SQLite)', async () => {
    const connectionConfig: ConnectionConfigPort = {
      getConnectionString: vi.fn().mockResolvedValue('mysql://root@127.0.0.1:3306/app'),
      saveConnectionString: vi.fn(),
      clearConnectionString: vi.fn(),
      getActiveProfile: vi.fn().mockResolvedValue({
        id: 'mysql-dev',
        name: 'MySQL Dev',
        engine: 'mysql',
        environment: 'local',
        readOnlyLocked: false,
        displayTarget: '127.0.0.1:3306/app',
      }),
      listProfiles: vi.fn().mockResolvedValue([]),
      saveProfile: vi.fn(),
      setActiveProfile: vi.fn(),
      setProfileReadOnlyLock: vi.fn(),
      deleteProfile: vi.fn(),
      getRuntimeSettings: vi.fn(),
    };
    const queryExecutor: QueryExecutorPort = {
      executeExplain: vi.fn(),
      executeCreateIndex: vi.fn(),
      simulateHypotheticalIndex: vi.fn(),
      testConnection: vi.fn(),
      dispose: vi.fn(),
    };
    const service = new SimulateIndexService({
      connectionConfig,
      queryExecutor,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const outcome = await service.execute({
      querySql: 'SELECT * FROM orders',
      indexSql: 'CREATE INDEX idx_orders_user_id ON orders (user_id);',
      baselineCost: 100,
    });

    expect(outcome.supported).toBe(false);
    expect(outcome.message).toContain('only available for PostgreSQL');
    expect(queryExecutor.simulateHypotheticalIndex).not.toHaveBeenCalled();
  });
});
