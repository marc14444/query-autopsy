import type { InspectionReport } from '../../../domain/models/diagnostic.js';
import type { ExplainMode } from '../../../domain/models/queryRequest.js';
import type { SimulateIndexResult } from '../../../domain/ports/inbound/simulateIndexUseCase.js';
import type { PlanComparisonSummary } from '../../../domain/services/planDiff.js';

export interface BaselineRunOption {
  readonly index: number;
  readonly label: string;
}

export interface WebviewRenderPayload {
  readonly report: InspectionReport;
  readonly nodeExplanations: Record<string, string>;
  readonly comparison?: PlanComparisonSummary | undefined;
  readonly baselineOptions: readonly BaselineRunOption[];
  readonly selectedBaselineIndex?: number | undefined;
}

export type ExtensionToWebviewMessage =
  | {
      readonly type: 'RENDER_REPORT';
      readonly payload: WebviewRenderPayload;
    }
  | {
      readonly type: 'SIMULATION_RESULT';
      readonly payload: SimulateIndexResult;
    };

export type WebviewToExtensionMessage =
  | { readonly type: 'READY' }
  | { readonly type: 'COPY_SQL'; readonly payload: { readonly sql: string } }
  | { readonly type: 'COPY_MARKDOWN_REPORT' }
  | {
      readonly type: 'SELECT_BASELINE';
      readonly payload: { readonly index: number };
    }
  | {
      readonly type: 'SIMULATE_INDEX';
      readonly payload: {
        readonly querySql: string;
        readonly indexSql: string;
      };
    }
  | {
      readonly type: 'RERUN_QUERY';
      readonly payload: { readonly sql: string; readonly mode: ExplainMode };
    };
