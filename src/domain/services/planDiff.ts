import type { InspectionReport } from '../models/diagnostic.js';
import type { PlanNode } from '../models/executionPlan.js';

export interface PlanComparisonSummary {
  readonly previousInspectedAtIso: string;
  readonly previousMode: InspectionReport['mode'];
  readonly previousExecutionTimeMs?: number | undefined;
  readonly currentExecutionTimeMs?: number | undefined;
  readonly executionTimeDeltaMs?: number | undefined;
  readonly executionTimeDeltaPercent?: number | undefined;
  readonly executionTimeIsNoise?: boolean | undefined;
  readonly previousCost: number;
  readonly currentCost: number;
  readonly costDeltaPercent: number;
  readonly previousSharedBlocks: number;
  readonly currentSharedBlocks: number;
  readonly blocksDeltaPercent?: number | undefined;
  readonly blocksDeltaIsNoise?: boolean | undefined;
  readonly previousPlanSummary: string;
  readonly currentPlanSummary: string;
  readonly previousDiagnosticsCount: number;
  readonly currentDiagnosticsCount: number;
}

export function normalizeSqlFingerprint(sql: string): string {
  return sql.trim().replace(/;+\s*$/, '').replace(/\s+/g, ' ');
}

export function summarizePlanChain(root: PlanNode, maxDepth = 3): string {
  const labels: string[] = [];
  let current: PlanNode | undefined = root;
  while (current && labels.length < maxDepth) {
    const suffix = current.relationName
      ? `(${current.relationName})`
      : current.indexName
        ? `(${current.indexName})`
        : '';
    labels.push(`${current.nodeType}${suffix}`);
    current = current.children[0];
  }
  return labels.join(' → ');
}

function percentDelta(prev: number, curr: number): number | undefined {
  if (prev <= 0) {
    return undefined;
  }
  return ((curr - prev) / prev) * 100;
}

export function computePlanDiff(
  previous: InspectionReport,
  current: InspectionReport,
): PlanComparisonSummary {
  const prevExec = previous.plan.executionTimeMs;
  const currExec = current.plan.executionTimeMs;
  const executionTimeDeltaMs =
    prevExec !== undefined && currExec !== undefined
      ? currExec - prevExec
      : undefined;
  const executionTimeDeltaPercent =
    prevExec !== undefined && currExec !== undefined
      ? percentDelta(prevExec, currExec)
      : undefined;

  const previousCost = previous.plan.root.totalCost;
  const currentCost = current.plan.root.totalCost;
  const costDeltaPercent = percentDelta(previousCost, currentCost) ?? 0;

  const previousSharedBlocks =
    previous.plan.totalBuffers.sharedHitBlocks +
    previous.plan.totalBuffers.sharedReadBlocks;
  const currentSharedBlocks =
    current.plan.totalBuffers.sharedHitBlocks +
    current.plan.totalBuffers.sharedReadBlocks;
  const blocksDeltaPercent = percentDelta(
    previousSharedBlocks,
    currentSharedBlocks,
  );

  const executionTimeIsNoise =
    prevExec !== undefined &&
    currExec !== undefined &&
    Math.abs(currExec - prevExec) < 1 &&
    Math.max(prevExec, currExec) < 2;

  const blocksDeltaIsNoise =
    Math.abs(currentSharedBlocks - previousSharedBlocks) < 5 &&
    Math.max(previousSharedBlocks, currentSharedBlocks) < 30;

  return {
    previousInspectedAtIso: previous.inspectedAtIso,
    previousMode: previous.mode,
    previousExecutionTimeMs: prevExec,
    currentExecutionTimeMs: currExec,
    executionTimeDeltaMs,
    executionTimeDeltaPercent,
    executionTimeIsNoise,
    previousCost,
    currentCost,
    costDeltaPercent,
    previousSharedBlocks,
    currentSharedBlocks,
    blocksDeltaPercent,
    blocksDeltaIsNoise,
    previousPlanSummary: summarizePlanChain(previous.plan.root),
    currentPlanSummary: summarizePlanChain(current.plan.root),
    previousDiagnosticsCount: previous.diagnostics.length,
    currentDiagnosticsCount: current.diagnostics.length,
  };
}

/**
 * Picks the most meaningful baseline run index in history:
 * prefers the most recent earlier run whose plan shape or cost differed meaningfully (>= 10%),
 * so repeated re-runs after adding an index still show the pre-index win by default.
 */
export function selectDefaultBaselineIndex(
  runs: readonly InspectionReport[],
): number | undefined {
  if (runs.length < 2) {
    return undefined;
  }

  const latest = runs[runs.length - 1]!;
  const latestCost = latest.plan.root.totalCost;
  const latestShape = summarizePlanChain(latest.plan.root);

  for (let i = runs.length - 2; i >= 0; i--) {
    const candidate = runs[i]!;
    const candidateCost = candidate.plan.root.totalCost;
    const candidateShape = summarizePlanChain(candidate.plan.root);
    const costDenom = Math.max(1, latestCost, candidateCost);
    const relativeCostDiff = Math.abs(candidateCost - latestCost) / costDenom;

    if (candidateShape !== latestShape || relativeCostDiff >= 0.1) {
      return i;
    }
  }

  return runs.length - 2;
}
