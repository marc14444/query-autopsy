import {
  MissingConnectionError,
  UnsafeQueryError,
} from '../../domain/errors/domainErrors.js';
import type { ApplyIndexUseCase } from '../../domain/ports/inbound/applyIndexUseCase.js';
import type { ConnectionConfigPort } from '../../domain/ports/outbound/connectionConfigPort.js';
import type { LoggerPort } from '../../domain/ports/outbound/loggerPort.js';
import type { QueryExecutorPort } from '../../domain/ports/outbound/queryExecutorPort.js';
import { validateSafeCreateIndexSql } from '../../domain/services/sqlClassifier.js';

export interface ApplyIndexDependencies {
  readonly connectionConfig: ConnectionConfigPort;
  readonly queryExecutor: QueryExecutorPort;
  readonly logger: LoggerPort;
}

export class ApplyIndexService implements ApplyIndexUseCase {
  constructor(private readonly deps: ApplyIndexDependencies) {}

  async execute(indexSql: string): Promise<void> {
    const validatedSql = validateSafeCreateIndexSql(indexSql);
    const activeProfile =
      await this.deps.connectionConfig.getActiveProfile();
    if (activeProfile?.readOnlyLocked) {
      throw new UnsafeQueryError(
        `Active profile "${activeProfile.name}" is Read-Only locked. Creating indexes directly from QueryAutopsy is disabled.`,
      );
    }

    const connectionString =
      await this.deps.connectionConfig.getConnectionString();
    if (!connectionString) {
      throw new MissingConnectionError();
    }

    this.deps.logger.info('Applying user-confirmed PostgreSQL index', {
      statement: validatedSql,
    });
    await this.deps.queryExecutor.executeCreateIndex(
      connectionString,
      validatedSql,
    );
    this.deps.logger.info('PostgreSQL index created successfully');
  }
}
