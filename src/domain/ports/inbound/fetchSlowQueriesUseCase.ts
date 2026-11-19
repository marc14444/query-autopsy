import type {
  SlowQueryFetchResult,
  SlowQuerySortBy,
} from '../../models/slowQuery.js';

export interface FetchSlowQueriesInput {
  readonly limit?: number | undefined;
  readonly sortBy?: SlowQuerySortBy | undefined;
}

export interface FetchSlowQueriesUseCase {
  execute(input?: FetchSlowQueriesInput): Promise<SlowQueryFetchResult>;
}
