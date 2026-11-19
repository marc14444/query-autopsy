import {
  MissingConnectionError,
  MissingParametersError,
  UnsafeQueryError,
} from '../../domain/errors/domainErrors.js';
import type { InspectionReport } from '../../domain/models/diagnostic.js';
import type { InspectQueryInput } from '../../domain/models/queryRequest.js';
import type { InspectQueryUseCase } from '../../domain/ports/inbound/inspectQueryUseCase.js';
import type { ConnectionConfigPort } from '../../domain/ports/outbound/connectionConfigPort.js';
import type { LoggerPort } from '../../domain/ports/outbound/loggerPort.js';
import type { QueryExecutorPort } from '../../domain/ports/outbound/queryExecutorPort.js';
import type { ReportPresenterPort } from '../../domain/ports/outbound/reportPresenterPort.js';
import { analyzeExecutionPlan } from '../../domain/services/diagnosticEngine.js';
import { parsePostgreSqlPlan } from '../../domain/services/planParser.js';
import { classifySqlStatement } from '../../domain/services/sqlClassifier.js';

export interface InspectQueryDependencies {
  readonly connectionConfig: ConnectionConfigPort;
  readonly queryExecutor: QueryExecutorPort;
  readonly reportPresenter: ReportPresenterPort;
  readonly logger: LoggerPort;
}

export class InspectQueryService implements InspectQueryUseCase {
  constructor(private readonly deps: InspectQueryDependencies) {}

  async execute(input: InspectQueryInput): Promise<InspectionReport> {
    const classified = classifySqlStatement(input.rawSql);
    const settings = this.deps.connectionConfig.getRuntimeSettings();

    if (classified.kind === 'DDL') {
      throw new UnsafeQueryError(
        'DDL statements (CREATE, ALTER, DROP, TRUNCATE, etc.) cannot be inspected via EXPLAIN.',
      );
    }

    if (classified.kind === 'UNKNOWN') {
      throw new UnsafeQueryError(
        'Unsupported SQL statement. QueryAutopsy supports SELECT, WITH, VALUES, TABLE, and DML (INSERT/UPDATE/DELETE/MERGE).',
      );
    }

    if (
      classified.kind === 'WRITE' &&
      input.mode === 'analyze' &&
      !settings.allowWriteAnalyze
    ) {
      throw new UnsafeQueryError(
        'EXPLAIN ANALYZE on write queries (INSERT/UPDATE/DELETE/MERGE) is disabled by default. Use "Inspect Query Plan Only" or enable "queryAutopsy.postgres.allowWriteAnalyze" (executes inside a ROLLBACK-only transaction).',
      );
    }

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

    const startedAt = Date.now();
    this.deps.logger.info('Executing PostgreSQL EXPLAIN inspection', {
      mode: input.mode,
      statementKind: classified.kind,
      parameterCount: classified.parameterIndices.length,
      timeoutMs: settings.statementTimeoutMs,
    });

    const rawPlan = await this.deps.queryExecutor.executeExplain(
      connectionString,
      {
        sql: classified.normalizedSql,
        kind: classified.kind,
        mode: input.mode,
        parameters,
        statementTimeoutMs: settings.statementTimeoutMs,
        allowWriteAnalyze: settings.allowWriteAnalyze,
      },
    );

    const plan = parsePostgreSqlPlan(rawPlan, input.mode);
    const diagnostics = analyzeExecutionPlan(plan, {
      seqScanRowThreshold: settings.seqScanRowThreshold,
    });

    const report: InspectionReport = {
      sql: classified.normalizedSql,
      statementKind: classified.kind,
      mode: input.mode,
      plan,
      diagnostics,
      inspectedAtIso: new Date().toISOString(),
    };

    await this.deps.reportPresenter.present(report);

    this.deps.logger.info('Inspection completed', {
      durationMs: Date.now() - startedAt,
      diagnosticsCount: diagnostics.length,
      executionTimeMs: plan.executionTimeMs,
    });

    return report;
  }
}
