import {
  MissingConnectionError,
  MissingParametersError,
  UnsafeQueryError,
} from '../../domain/errors/domainErrors.js';
import { getEngineAdapter } from '../../domain/engines/engineRegistry.js';
import { resolveProfileEngine } from '../../domain/models/connectionProfile.js';
import {
  detectDatabaseEngineFromUri,
  formatEngineLabel,
} from '../../domain/models/databaseEngine.js';
import type { InspectionReport } from '../../domain/models/diagnostic.js';
import type { InspectQueryInput } from '../../domain/models/queryRequest.js';
import type { InspectQueryUseCase } from '../../domain/ports/inbound/inspectQueryUseCase.js';
import type { ConnectionConfigPort } from '../../domain/ports/outbound/connectionConfigPort.js';
import type { LoggerPort } from '../../domain/ports/outbound/loggerPort.js';
import type { QueryExecutorPort } from '../../domain/ports/outbound/queryExecutorPort.js';
import type { ReportPresenterPort } from '../../domain/ports/outbound/reportPresenterPort.js';

export interface InspectQueryDependencies {
  readonly connectionConfig: ConnectionConfigPort;
  readonly queryExecutor: QueryExecutorPort;
  readonly reportPresenter: ReportPresenterPort;
  readonly logger: LoggerPort;
}

export class InspectQueryService implements InspectQueryUseCase {
  constructor(private readonly deps: InspectQueryDependencies) {}

  async execute(input: InspectQueryInput): Promise<InspectionReport> {
    const settings = this.deps.connectionConfig.getRuntimeSettings();
    const [activeProfile, connectionString] = await Promise.all([
      this.deps.connectionConfig.getActiveProfile(),
      this.deps.connectionConfig.getConnectionString(),
    ]);

    const engine = activeProfile
      ? resolveProfileEngine(activeProfile)
      : connectionString
        ? detectDatabaseEngineFromUri(connectionString)
        : 'postgresql';
    const adapter = getEngineAdapter(engine);

    const classified = adapter.classifySql(input.rawSql);
    const isReadOnlyLocked = activeProfile?.readOnlyLocked ?? false;
    const effectiveAllowWriteAnalyze =
      settings.allowWriteAnalyze && !isReadOnlyLocked;

    if (classified.kind === 'DDL') {
      throw new UnsafeQueryError(
        'DDL statements (CREATE, ALTER, DROP, TRUNCATE, etc.) cannot be inspected via EXPLAIN.',
      );
    }

    if (classified.kind === 'UNKNOWN') {
      throw new UnsafeQueryError(
        'Unsupported SQL statement. QueryAutopsy supports SELECT, WITH, VALUES, and DML (INSERT/UPDATE/DELETE).',
      );
    }

    if (
      classified.kind === 'WRITE' &&
      input.mode === 'analyze' &&
      !effectiveAllowWriteAnalyze
    ) {
      if (isReadOnlyLocked && activeProfile) {
        throw new UnsafeQueryError(
          `Active profile "${activeProfile.name}" is Read-Only locked. EXPLAIN ANALYZE on write queries is blocked; use "Estimate Plan" instead.`,
        );
      }
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

    if (!connectionString) {
      throw new MissingConnectionError();
    }

    const startedAt = Date.now();
    this.deps.logger.info(
      `Executing ${formatEngineLabel(engine)} EXPLAIN inspection`,
      {
        engine,
        mode: input.mode,
        statementKind: classified.kind,
        parameterCount: classified.parameterIndices.length,
        timeoutMs: settings.statementTimeoutMs,
      },
    );

    const rawPlan = await this.deps.queryExecutor.executeExplain(
      connectionString,
      {
        engine,
        sql: classified.normalizedSql,
        kind: classified.kind,
        mode: input.mode,
        parameters,
        statementTimeoutMs: settings.statementTimeoutMs,
        allowWriteAnalyze: effectiveAllowWriteAnalyze,
      },
    );

    const plan = adapter.parsePlan(rawPlan, input.mode);
    const diagnostics = adapter.analyzePlan(plan, {
      seqScanRowThreshold: settings.seqScanRowThreshold,
      sql: classified.normalizedSql,
    });

    const report: InspectionReport = {
      engine,
      sql: classified.normalizedSql,
      statementKind: classified.kind,
      mode: input.mode,
      plan,
      diagnostics,
      inspectedAtIso: new Date().toISOString(),
      profileName: activeProfile?.name,
      readOnlyLocked: activeProfile?.readOnlyLocked,
    };

    await this.deps.reportPresenter.present(report);

    this.deps.logger.info('Inspection completed', {
      engine,
      durationMs: Date.now() - startedAt,
      diagnosticsCount: diagnostics.length,
      executionTimeMs: plan.executionTimeMs,
    });

    return report;
  }
}
