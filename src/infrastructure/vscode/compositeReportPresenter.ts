import type { InspectionReport } from '../../domain/models/diagnostic.js';
import type { ReportPresenterPort } from '../../domain/ports/outbound/reportPresenterPort.js';

export class CompositeReportPresenter implements ReportPresenterPort {
  constructor(private readonly presenters: readonly ReportPresenterPort[]) {}

  async present(report: InspectionReport): Promise<void> {
    await Promise.all(
      this.presenters.map((presenter) => presenter.present(report)),
    );
  }
}
