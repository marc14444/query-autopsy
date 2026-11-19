import type { InspectionReport } from '../../../domain/models/diagnostic.js';
import type { ExplainMode } from '../../../domain/models/queryRequest.js';

export type ExtensionToWebviewMessage = {
  readonly type: 'RENDER_REPORT';
  readonly payload: InspectionReport;
};

export type WebviewToExtensionMessage =
  | { readonly type: 'READY' }
  | { readonly type: 'COPY_SQL'; readonly payload: { readonly sql: string } }
  | {
      readonly type: 'RERUN_QUERY';
      readonly payload: { readonly sql: string; readonly mode: ExplainMode };
    };
