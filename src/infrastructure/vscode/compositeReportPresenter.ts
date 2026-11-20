import type {
  InspectionReport,
  ReportPresenterPort,
} from '@query-autopsy/core';

export class CompositeReportPresenter implements ReportPresenterPort {
  constructor(private readonly presenters: readonly ReportPresenterPort[]) {}

  async present(report: InspectionReport): Promise<void> {
    await Promise.all(
      this.presenters.map((presenter) => presenter.present(report)),
    );
  }
}
