import {
  MissingConnectionError,
  UnsafeQueryError,
} from '../../domain/errors/domainErrors.js';
import { getEngineAdapter } from '../../domain/engines/engineRegistry.js';
import {
  assertSafeProfileConnection,
  resolveProfileEngine,
} from '../../domain/models/connectionProfile.js';
import {
  detectDatabaseEngineFromUri,
  formatEngineLabel,
} from '../../domain/models/databaseEngine.js';
import type { ApplyIndexUseCase } from '../../domain/ports/inbound/applyIndexUseCase.js';
import type { ConnectionConfigPort } from '../../domain/ports/outbound/connectionConfigPort.js';
import type { LoggerPort } from '../../domain/ports/outbound/loggerPort.js';
import type { QueryExecutorPort } from '../../domain/ports/outbound/queryExecutorPort.js';

export interface ApplyIndexDependencies {
  readonly connectionConfig: ConnectionConfigPort;
  readonly queryExecutor: QueryExecutorPort;
  readonly logger: LoggerPort;
}

export class ApplyIndexService implements ApplyIndexUseCase {
  constructor(private readonly deps: ApplyIndexDependencies) {}

  async execute(indexSql: string): Promise<void> {
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

    const validatedSql = adapter.validateSafeCreateIndexSql(indexSql);
    if (activeProfile?.readOnlyLocked) {
      throw new UnsafeQueryError(
        `Active profile "${activeProfile.name}" is Read-Only locked. Creating indexes directly from QueryAutopsy is disabled.`,
      );
    }

    if (!connectionString) {
      throw new MissingConnectionError();
    }

    assertSafeProfileConnection(activeProfile, connectionString);

    const label = formatEngineLabel(engine);
    this.deps.logger.info(`Applying user-confirmed ${label} index`, {
      engine,
      statement: validatedSql,
    });
    await this.deps.queryExecutor.executeCreateIndex(
      connectionString,
      validatedSql,
    );
    this.deps.logger.info(`${label} index created successfully`);
  }
}
