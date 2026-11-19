import type { ExecutionPlan, PlanNode } from '../models/executionPlan.js';
import type { ExplainMode } from '../models/queryRequest.js';

export function explainPlanNode(node: PlanNode, mode: ExplainMode): string {
  const rel = node.relationName ? `"${node.relationName}"` : 'the input';
  const loops = node.actualLoops ?? 1;
  const rows =
    mode === 'analyze' && node.actualRows !== undefined
      ? Math.round(node.actualRows * loops)
      : Math.round(node.planRows);
  const removed =
    node.rowsRemovedByFilter !== undefined
      ? Math.round(node.rowsRemovedByFilter * loops)
      : 0;

  switch (node.nodeType) {
    case 'Seq Scan': {
      const totalScanned = rows + removed;
      if (mode === 'analyze' && removed > 0 && totalScanned > 0) {
        const discardPct = ((removed / totalScanned) * 100).toFixed(1);
        return `Read all ${totalScanned.toLocaleString('en-US')} rows in ${rel} sequentially and discarded ${discardPct}% (${removed.toLocaleString('en-US')} rows) via filter.`;
      }
      return `Scanned ${rel} sequentially page-by-page without an index (${rows.toLocaleString('en-US')} rows).`;
    }
    case 'Index Scan':
      return `Traversed B-Tree index ${node.indexName ?? ''} to fetch ${rows.toLocaleString('en-US')} matching rows from ${rel} heap pages.`;
    case 'Index Only Scan':
      return `Resolved ${rows.toLocaleString('en-US')} rows directly from index ${node.indexName ?? ''} without visiting table heap pages (fastest index path).`;
    case 'Bitmap Index Scan':
      return `Scanned index ${node.indexName ?? ''} to build an in-memory page bitmap matching ${rows.toLocaleString('en-US')} candidate rows.`;
    case 'Bitmap Heap Scan': {
      const lossy = node.lossyHeapBlocks ?? 0;
      const exact = node.exactHeapBlocks ?? 0;
      if (lossy > 0) {
        return `Fetched ${rows.toLocaleString('en-US')} rows from ${rel}; bitmap overflowed work_mem (${lossy} lossy blocks vs ${exact} exact), forcing extra rechecks.`;
      }
      return `Fetched ${rows.toLocaleString('en-US')} rows sequentially across ${exact} heap pages identified by the bitmap index.`;
    }
    case 'Gather':
    case 'Gather Merge':
      return `Coordinated ${node.workersLaunched ?? node.workersPlanned ?? 0} parallel worker(s) and merged ${rows.toLocaleString('en-US')} rows (worker times can overlap wall-clock time).`;
    case 'Sort': {
      const keys = node.sort?.sortKey?.join(', ') ?? 'sort key';
      const space = node.sort?.sortSpaceUsedKb
        ? `${node.sort.sortSpaceUsedKb.toLocaleString('en-US')} KB in ${node.sort.sortSpaceType ?? 'memory'}`
        : 'memory';
      return `Sorted ${rows.toLocaleString('en-US')} rows by (${keys}) using ${node.sort?.sortMethod ?? 'sort'} (${space}).`;
    }
    case 'Hash Join':
      return `Built an in-memory hash table on the inner input and probed outer rows (${rows.toLocaleString('en-US')} output rows).`;
    case 'Hash':
      return `Materialized ${rows.toLocaleString('en-US')} rows into an in-memory hash table${(node.hashBatches ?? 1) > 1 ? ` (spilled across ${node.hashBatches} batches)` : ''}.`;
    case 'Nested Loop':
      return `Joined outer and inner inputs by repeating the inner subtree once per outer match (${rows.toLocaleString('en-US')} total rows).`;
    case 'Merge Join':
      return `Joined two pre-sorted inputs in a single synchronized pass (${rows.toLocaleString('en-US')} output rows).`;
    case 'Limit':
      return `Stopped reading child nodes as soon as ${rows.toLocaleString('en-US')} rows were produced.`;
    case 'Aggregate':
    case 'GroupAggregate':
    case 'HashAggregate':
      return `Grouped and aggregated input rows down to ${rows.toLocaleString('en-US')} result rows.`;
    default:
      if (node.subplanName) {
        return `Executed ${node.subplanName} (${node.nodeType}) ${loops.toLocaleString('en-US')} time(s) producing ${rows.toLocaleString('en-US')} rows.`;
      }
      return `Executed ${node.nodeType}${node.relationName ? ` on ${rel}` : ''} (${rows.toLocaleString('en-US')} rows).`;
  }
}

export function buildNodeExplanationMap(
  plan: ExecutionPlan,
): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (node: PlanNode): void => {
    result[node.id] = explainPlanNode(node, plan.mode);
    for (const child of node.children) {
      visit(child);
    }
  };
  visit(plan.root);
  return result;
}
