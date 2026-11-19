import type { ExplainMode } from './queryRequest.js';

export interface BufferMetrics {
  readonly sharedHitBlocks: number;
  readonly sharedReadBlocks: number;
  readonly sharedDirtiedBlocks: number;
  readonly sharedWrittenBlocks: number;
  readonly localHitBlocks: number;
  readonly localReadBlocks: number;
  readonly tempReadBlocks: number;
  readonly tempWrittenBlocks: number;
  readonly cacheHitRatio: number | null;
}

export interface SortMetrics {
  readonly sortKey?: readonly string[] | undefined;
  readonly sortMethod?: string | undefined;
  readonly sortSpaceUsedKb?: number | undefined;
  readonly sortSpaceType?: string | undefined;
}

export interface PlanNode {
  readonly id: string;
  readonly nodeType: string;
  readonly parentRelationship?: string | undefined;
  readonly relationName?: string | undefined;
  readonly schema?: string | undefined;
  readonly alias?: string | undefined;
  readonly indexName?: string | undefined;
  readonly joinType?: string | undefined;
  readonly startupCost: number;
  readonly totalCost: number;
  readonly planRows: number;
  readonly planWidth: number;
  readonly actualStartupTimeMs?: number | undefined;
  readonly actualTotalTimeMs?: number | undefined;
  readonly actualRows?: number | undefined;
  readonly actualLoops?: number | undefined;
  readonly inclusiveTimeMs?: number | undefined;
  readonly exclusiveTimeMs?: number | undefined;
  readonly exclusiveTimePercent?: number | undefined;
  readonly filter?: string | undefined;
  readonly indexCond?: string | undefined;
  readonly hashCond?: string | undefined;
  readonly rowsRemovedByFilter?: number | undefined;
  readonly hashBatches?: number | undefined;
  readonly subplanName?: string | undefined;
  readonly exactHeapBlocks?: number | undefined;
  readonly lossyHeapBlocks?: number | undefined;
  readonly parallelAware: boolean;
  readonly workersPlanned?: number | undefined;
  readonly workersLaunched?: number | undefined;
  readonly buffers: BufferMetrics;
  readonly sort?: SortMetrics | undefined;
  readonly children: readonly PlanNode[];
}

export interface ExecutionPlan {
  readonly mode: ExplainMode;
  readonly root: PlanNode;
  readonly planningTimeMs?: number | undefined;
  readonly executionTimeMs?: number | undefined;
  readonly planningBuffers?: BufferMetrics | undefined;
  readonly totalBuffers: BufferMetrics;
  readonly rawJson: unknown;
}
