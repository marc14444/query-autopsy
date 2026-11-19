import type { DatabaseEngine } from './databaseEngine.js';

export type SlowQuerySortBy = 'mean_exec_time' | 'total_exec_time';

export interface SlowQueryEntry {
  readonly queryId: string;
  readonly query: string;
  readonly calls: number;
  readonly totalExecTimeMs: number;
  readonly meanExecTimeMs: number;
  readonly rows: number;
  readonly sharedBlksHit: number;
  readonly sharedBlksRead: number;
}

export type SlowQueryFetchResult =
  | {
      readonly supported: true;
      readonly engine: DatabaseEngine;
      readonly entries: readonly SlowQueryEntry[];
    }
  | {
      readonly supported: false;
      readonly engine: DatabaseEngine;
      readonly reason: string;
    };
