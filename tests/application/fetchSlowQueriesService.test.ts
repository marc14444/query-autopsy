import { describe, expect, it, vi } from 'vitest';
import { FetchSlowQueriesService } from '../../src/application/usecases/fetchSlowQueriesService.js';
import { MissingConnectionError } from '../../src/domain/errors/domainErrors.js';
import type { ConnectionProfile } from '../../src/domain/models/connectionProfile.js';
import type { SlowQueryFetchResult } from '../../src/domain/models/slowQuery.js';
import type { ConnectionConfigPort } from '../../src/domain/ports/outbound/connectionConfigPort.js';
import type { LoggerPort } from '../../src/domain/ports/outbound/loggerPort.js';
import type { SlowQueryPort } from '../../src/domain/ports/outbound/slowQueryPort.js';

function createMocks(options?: {
  connectionString?: string | undefined;
  activeProfile?: ConnectionProfile | undefined;
  result?: SlowQueryFetchResult;
}) {
  const connectionConfig: ConnectionConfigPort = {
    getConnectionString: vi
      .fn()
      .mockResolvedValue(
        options && 'connectionString' in options
          ? options.connectionString
          : 'postgresql://postgres@127.0.0.1:5432/app',
      ),
    saveConnectionString: vi.fn(),
    clearConnectionString: vi.fn(),
    getActiveProfile: vi.fn().mockResolvedValue(options?.activeProfile),
    listProfiles: vi.fn().mockResolvedValue([]),
    saveProfile: vi.fn(),
    setActiveProfile: vi.fn(),
    setProfileReadOnlyLock: vi.fn(),
    deleteProfile: vi.fn(),
    getRuntimeSettings: vi.fn(),
  };

  const defaultResult: SlowQueryFetchResult = {
    supported: true,
    engine: 'postgresql',
    entries: [
      {
        queryId: '101',
        query: 'SELECT * FROM orders WHERE user_id = $1',
        calls: 250,
        totalExecTimeMs: 4200,
        meanExecTimeMs: 16.8,
        rows: 5000,
        sharedBlksHit: 1800,
        sharedBlksRead: 200,
      },
    ],
  };

  const slowQueryReader: SlowQueryPort = {
    fetchTopSlowQueries: vi
      .fn()
      .mockResolvedValue(options?.result ?? defaultResult),
  };

  const logger: LoggerPort = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  return {
    service: new FetchSlowQueriesService({
      connectionConfig,
      slowQueryReader,
      logger,
    }),
    slowQueryReader,
  };
}

describe('FetchSlowQueriesService', () => {
  it('throws MissingConnectionError when no connection is configured', async () => {
    const { service } = createMocks({ connectionString: undefined });
    await expect(service.execute()).rejects.toThrow(MissingConnectionError);
  });

  it('delegates to slowQueryReader with active profile engine and clamped options', async () => {
    const { service, slowQueryReader } = createMocks({
      connectionString: 'mysql://root@127.0.0.1:3306/shop',
      activeProfile: {
        id: 'mysql-prod',
        name: 'MySQL Prod',
        engine: 'mysql',
        environment: 'production',
        readOnlyLocked: true,
        displayTarget: '127.0.0.1:3306/shop',
      },
    });

    const outcome = await service.execute({
      limit: 100,
      sortBy: 'total_exec_time',
    });

    expect(outcome.supported).toBe(true);
    expect(slowQueryReader.fetchTopSlowQueries).toHaveBeenCalledWith(
      'mysql://root@127.0.0.1:3306/shop',
      'mysql',
      { limit: 50, sortBy: 'total_exec_time' },
    );
  });
});
