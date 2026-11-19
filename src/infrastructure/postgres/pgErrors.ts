import { QueryExecutionError } from '../../domain/errors/domainErrors.js';

interface PgErrorLike {
  readonly code?: string;
  readonly message?: string;
  readonly detail?: string;
  readonly hint?: string;
}

function asPgError(error: unknown): PgErrorLike {
  if (typeof error === 'object' && error !== null) {
    return error as PgErrorLike;
  }
  return { message: String(error) };
}

export function mapPostgresError(error: unknown): QueryExecutionError {
  const err = asPgError(error);
  const code = err.code;
  const rawMessage = err.message ?? 'Unknown PostgreSQL error.';

  switch (code) {
    case '57014':
      return new QueryExecutionError(
        'Query timed out (statement_timeout exceeded). Try "Inspect Query Plan Only" or increase "queryAutopsy.postgres.statementTimeoutMs".',
        code,
      );
    case '28P01':
    case '28000':
      return new QueryExecutionError(
        'PostgreSQL authentication failed. Re-run "QueryAutopsy: Configure PostgreSQL Connection".',
        code,
      );
    case '3D000':
      return new QueryExecutionError(
        `Target PostgreSQL database does not exist (${rawMessage}).`,
        code,
      );
    case '42P01':
      return new QueryExecutionError(
        `Table or view not found: ${rawMessage}`,
        code,
      );
    case '42703':
      return new QueryExecutionError(`Column not found: ${rawMessage}`, code);
    case '42601':
      return new QueryExecutionError(`SQL syntax error: ${rawMessage}`, code);
    case 'ECONNREFUSED':
    case 'ENOTFOUND':
    case 'ETIMEDOUT':
      return new QueryExecutionError(
        `Cannot reach PostgreSQL server (${code}). Check host, port, and whether Docker/PostgreSQL is running.`,
        code,
      );
    default: {
      const parts = [rawMessage];
      if (err.detail) {
        parts.push(`Detail: ${err.detail}`);
      }
      if (err.hint) {
        parts.push(`Hint: ${err.hint}`);
      }
      return new QueryExecutionError(parts.join(' | '), code);
    }
  }
}
