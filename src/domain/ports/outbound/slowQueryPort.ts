import type { DatabaseEngine } from '../../models/databaseEngine.js';
import type {
  SlowQueryFetchResult,
  SlowQuerySortBy,
} from '../../models/slowQuery.js';

export interface FetchSlowQueriesOptions {
  readonly limit: number;
  readonly sortBy: SlowQuerySortBy;
}

export interface SlowQueryPort {
  fetchTopSlowQueries(
    connectionString: string,
    engine: DatabaseEngine,
    options: FetchSlowQueriesOptions,
  ): Promise<SlowQueryFetchResult>;
}
