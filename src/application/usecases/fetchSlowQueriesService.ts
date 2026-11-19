import { MissingConnectionError } from '../../domain/errors/domainErrors.js';
import { resolveProfileEngine } from '../../domain/models/connectionProfile.js';
import { detectDatabaseEngineFromUri } from '../../domain/models/databaseEngine.js';
import type { SlowQueryFetchResult } from '../../domain/models/slowQuery.js';
import type {
  FetchSlowQueriesInput,
  FetchSlowQueriesUseCase,
} from '../../domain/ports/inbound/fetchSlowQueriesUseCase.js';
import type { ConnectionConfigPort } from '../../domain/ports/outbound/connectionConfigPort.js';
import type { LoggerPort } from '../../domain/ports/outbound/loggerPort.js';
import type { SlowQueryPort } from '../../domain/ports/outbound/slowQueryPort.js';

export interface FetchSlowQueriesDependencies {
  readonly connectionConfig: ConnectionConfigPort;
  readonly slowQueryReader: SlowQueryPort;
  readonly logger: LoggerPort;
}

export class FetchSlowQueriesService implements FetchSlowQueriesUseCase {
  constructor(private readonly deps: FetchSlowQueriesDependencies) {}

  async execute(
    input?: FetchSlowQueriesInput,
  ): Promise<SlowQueryFetchResult> {
    const [activeProfile, connectionString] = await Promise.all([
      this.deps.connectionConfig.getActiveProfile(),
      this.deps.connectionConfig.getConnectionString(),
    ]);

    if (!connectionString) {
      throw new MissingConnectionError();
    }

    const engine = activeProfile
      ? resolveProfileEngine(activeProfile)
      : detectDatabaseEngineFromUri(connectionString);

    const limit = Math.min(50, Math.max(1, input?.limit ?? 10));
    const sortBy = input?.sortBy ?? 'mean_exec_time';

    this.deps.logger.info('Fetching server top slow queries', {
      engine,
      limit,
      sortBy,
    });

    return this.deps.slowQueryReader.fetchTopSlowQueries(
      connectionString,
      engine,
      { limit, sortBy },
    );
  }
}
