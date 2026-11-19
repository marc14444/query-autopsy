import { describe, expect, it, vi } from 'vitest';
import type { InspectionReport } from '../../src/domain/models/diagnostic.js';
import type { ReportPresenterPort } from '../../src/domain/ports/outbound/reportPresenterPort.js';
import { CompositeReportPresenter } from '../../src/infrastructure/vscode/compositeReportPresenter.js';

describe('CompositeReportPresenter', () => {
  it('forwards InspectionReport to all registered presenters', async () => {
    const first: ReportPresenterPort = { present: vi.fn().mockResolvedValue(undefined) };
    const second: ReportPresenterPort = { present: vi.fn().mockResolvedValue(undefined) };

    const composite = new CompositeReportPresenter([first, second]);
    const dummyReport = { sql: 'SELECT 1' } as unknown as InspectionReport;

    await composite.present(dummyReport);

    expect(first.present).toHaveBeenCalledWith(dummyReport);
    expect(second.present).toHaveBeenCalledWith(dummyReport);
  });
});
