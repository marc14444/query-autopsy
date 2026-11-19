import {
  MissingConnectionError,
  MissingParametersError,
  UnsafeQueryError,
} from '../../domain/errors/domainErrors.js';
import type {
  SimulateIndexInput,
  SimulateIndexResult,
  SimulateIndexUseCase,
} from '../../domain/ports/inbound/simulateIndexUseCase.js';
import type { ConnectionConfigPort } from '../../domain/ports/outbound/connectionConfigPort.js';
import type { LoggerPort } from '../../domain/ports/outbound/loggerPort.js';
import type { QueryExecutorPort } from '../../domain/ports/outbound/queryExecutorPort.js';
import { summarizePlanChain } from '../../domain/services/planDiff.js';
import { parsePostgreSqlPlan } from '../../domain/services/planParser.js';
import {
  classifySqlStatement,
  validateSafeCreateIndexSql,
} from '../../domain/services/sqlClassifier.js';

export interface SimulateIndexDependencies {
  readonly connectionConfig: ConnectionConfigPort;
  readonly queryExecutor: QueryExecutorPort;
  readonly logger: LoggerPort;
}

export class SimulateIndexService implements SimulateIndexUseCase {
  constructor(private readonly deps: SimulateIndexDependencies) {}

  async execute(input: SimulateIndexInput): Promise<SimulateIndexResult> {
    const classified = classifySqlStatement(input.querySql);
    if (classified.kind === 'DDL' || classified.kind === 'UNKNOWN') {
      throw new UnsafeQueryError(
        'Cannot simulate index for unsupported or DDL statement.',
      );
    }

    const validatedIndexSql = validateSafeCreateIndexSql(input.indexSql);
    const parameters = input.parameters ?? [];
    if (classified.parameterIndices.length > 0) {
      const highestIndex =
        classified.parameterIndices[classified.parameterIndices.length - 1]!;
      if (parameters.length < highestIndex) {
        throw new MissingParametersError(classified.parameterIndices);
      }
    }

    const connectionString =
      await this.deps.connectionConfig.getConnectionString();
    if (!connectionString) {
      throw new MissingConnectionError();
    }

    this.deps.logger.info('Running HypoPG What-If simulation', {
      statement: validatedIndexSql,
    });

    const outcome = await this.deps.queryExecutor.simulateHypotheticalIndex(
      connectionString,
      classified.normalizedSql,
      validatedIndexSql,
      parameters,
    );

    if (!outcome.supported || outcome.rawPlan === undefined) {
      return {
        supported: false,
        indexSql: validatedIndexSql,
        message:
          outcome.reason ??
          'HypoPG extension is not available on this PostgreSQL server.',
      };
    }

    const simulatedPlan = parsePostgreSqlPlan(outcome.rawPlan, 'estimate');
    const simulatedCost = simulatedPlan.root.totalCost;
    const costDeltaPercent =
      input.baselineCost > 0
        ? ((simulatedCost - input.baselineCost) / input.baselineCost) * 100
        : 0;
    const simulatedPlanSummary = summarizePlanChain(simulatedPlan.root);

    const sign = costDeltaPercent > 0 ? '+' : '';
    return {
      supported: true,
      indexSql: validatedIndexSql,
      simulatedCost,
      costDeltaPercent,
      simulatedPlanSummary,
      message: `Simulated Cost: ${input.baselineCost.toFixed(1)} → ${simulatedCost.toFixed(1)} (${sign}${costDeltaPercent.toFixed(1)}%) | Plan: ${simulatedPlanSummary}`,
    };
  }
}
