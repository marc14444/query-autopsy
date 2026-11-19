import type { InspectionReport } from '../../models/diagnostic.js';
import type { InspectQueryInput } from '../../models/queryRequest.js';

export interface InspectQueryUseCase {
  execute(input: InspectQueryInput): Promise<InspectionReport>;
}
