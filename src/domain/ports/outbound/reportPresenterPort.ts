import type { InspectionReport } from '../../models/diagnostic.js';

export interface ReportPresenterPort {
  present(report: InspectionReport): Promise<void>;
}
