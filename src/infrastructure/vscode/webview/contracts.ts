import type {
  ExplainMode,
  InspectionReport,
  PlanComparisonSummary,
  SimulateIndexResult,
} from '@query-autopsy/core';

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
