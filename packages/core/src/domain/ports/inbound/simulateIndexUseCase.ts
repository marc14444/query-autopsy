export interface SimulateIndexInput {
  readonly querySql: string;
  readonly indexSql: string;
  readonly baselineCost: number;
  readonly parameters?: readonly unknown[] | undefined;
}

export interface SimulateIndexResult {
  readonly supported: boolean;
  readonly indexSql: string;
  readonly message: string;
  readonly simulatedCost?: number | undefined;
  readonly costDeltaPercent?: number | undefined;
  readonly simulatedPlanSummary?: string | undefined;
}

export interface SimulateIndexUseCase {
  execute(input: SimulateIndexInput): Promise<SimulateIndexResult>;
}
