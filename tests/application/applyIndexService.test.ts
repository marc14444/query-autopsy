import { describe, expect, it, vi } from 'vitest';
import { ApplyIndexService } from '../../src/application/usecases/applyIndexService.js';
import {
  MissingConnectionError,
  UnsafeQueryError,
} from '../../src/domain/errors/domainErrors.js';
import type { ConnectionProfile } from '../../src/domain/models/connectionProfile.js';
import type { ConnectionConfigPort } from '../../src/domain/ports/outbound/connectionConfigPort.js';
import type { LoggerPort } from '../../src/domain/ports/outbound/loggerPort.js';
import type { QueryExecutorPort } from '../../src/domain/ports/outbound/queryExecutorPort.js';

function createDeps(options?: {
  connectionString?: string | undefined;
  activeProfile?: ConnectionProfile | undefined;
}) {
  const connectionConfig: ConnectionConfigPort = {
    getConnectionString: vi.fn().mockResolvedValue(options?.connectionString),
    saveConnectionString: vi.fn().mockResolvedValue(undefined),
    clearConnectionString: vi.fn().mockResolvedValue(undefined),
    getActiveProfile: vi.fn().mockResolvedValue(options?.activeProfile),
    listProfiles: vi.fn().mockResolvedValue([]),
    saveProfile: vi.fn(),
    setActiveProfile: vi.fn().mockResolvedValue(undefined),
    setProfileReadOnlyLock: vi.fn().mockResolvedValue(undefined),
    deleteProfile: vi.fn().mockResolvedValue(undefined),
    getRuntimeSettings: vi.fn(),
  };
  const queryExecutor: QueryExecutorPort = {
    executeExplain: vi.fn(),
    executeCreateIndex: vi.fn().mockResolvedValue(undefined),
    simulateHypotheticalIndex: vi.fn(),
    testConnection: vi.fn(),
    dispose: vi.fn(),
  };
  const logger: LoggerPort = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  return {
    service: new ApplyIndexService({ connectionConfig, queryExecutor, logger }),
    queryExecutor,
  };
}

describe('ApplyIndexService', () => {
  it('validates and executes CREATE INDEX CONCURRENTLY via QueryExecutorPort', async () => {
    const { service, queryExecutor } = createDeps({
      connectionString: 'postgresql://postgres@localhost:5432/test',
    });
    await service.execute(
      'CREATE INDEX CONCURRENTLY idx_orders_status ON orders (status);',
    );
    expect(queryExecutor.executeCreateIndex).toHaveBeenCalledWith(
      'postgresql://postgres@localhost:5432/test',
      'CREATE INDEX CONCURRENTLY idx_orders_status ON orders (status);',
    );
  });

  it('rejects unsafe SQL before resolving connection', async () => {
    const { service, queryExecutor } = createDeps({
      connectionString: 'postgresql://postgres@localhost:5432/test',
    });
    await expect(service.execute('DROP TABLE orders')).rejects.toThrow(
      UnsafeQueryError,
    );
    expect(queryExecutor.executeCreateIndex).not.toHaveBeenCalled();
  });

  it('blocks index creation when active profile is Read-Only locked', async () => {
    const { service, queryExecutor } = createDeps({
      connectionString: 'postgresql://postgres@localhost:5432/prod',
      activeProfile: {
        id: 'prod',
        name: 'prod-ro',
        environment: 'production',
        readOnlyLocked: true,
        displayTarget: 'prod:5432/app',
      },
    });
    await expect(
      service.execute(
        'CREATE INDEX CONCURRENTLY idx_orders_status ON orders (status);',
      ),
    ).rejects.toThrow(/Read-Only locked/);
    expect(queryExecutor.executeCreateIndex).not.toHaveBeenCalled();
  });

  it('throws MissingConnectionError when unconfigured', async () => {
    const { service } = createDeps({ connectionString: undefined });
    await expect(
      service.execute(
        'CREATE INDEX CONCURRENTLY idx_orders_status ON orders (status);',
      ),
    ).rejects.toThrow(MissingConnectionError);
  });
});
