import { QueryExecutionError } from '@query-autopsy/core';

interface MysqlErrorLike {
  readonly code?: string;
  readonly errno?: number;
  readonly sqlState?: string;
  readonly message?: string;
}

function asMysqlError(err: unknown): MysqlErrorLike {
  if (typeof err === 'object' && err !== null) {
    return err as MysqlErrorLike;
  }
  return { message: String(err) };
}

export function mapMysqlError(error: unknown): QueryExecutionError {
  const err = asMysqlError(error);
  const code = err.code ?? '';
  const rawMessage = err.message ?? 'Unknown MySQL error.';

  switch (code) {
    case 'ER_ACCESS_DENIED_ERROR':
    case 'ER_DBACCESS_DENIED_ERROR':
      return new QueryExecutionError(
        `MySQL authentication failed (${rawMessage}). Check user/password (use Guided Setup if password has special characters), or verify whether another local server occupies localhost:3306 instead of Docker (try 127.0.0.1).`,
        '28000',
      );
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return new QueryExecutionError(
        `MySQL SSL certificate rejected (${rawMessage}). Append "?sslmode=no-verify" or select "Require SSL — No Verify" in Guided Setup.`,
        code,
      );
    case 'ER_BAD_DB_ERROR':
      return new QueryExecutionError(
        `Target MySQL database does not exist (${rawMessage}).`,
        '3D000',
      );
    case 'ER_NO_SUCH_TABLE':
      return new QueryExecutionError(`Table or view not found: ${rawMessage}`, '42P01');
    case 'ER_BAD_FIELD_ERROR':
      return new QueryExecutionError(`Column not found: ${rawMessage}`, '42703');
    case 'ER_PARSE_ERROR':
    case 'ER_SYNTAX_ERROR':
      return new QueryExecutionError(`SQL syntax error: ${rawMessage}`, '42601');
    case 'ER_DUP_KEYNAME':
      return new QueryExecutionError(`Index already exists: ${rawMessage}`, '42P07');
    case 'ER_QUERY_TIMEOUT':
    case 'ER_STATEMENT_TIMEOUT':
      return new QueryExecutionError(
        'MySQL query timed out (MAX_EXECUTION_TIME exceeded). Try "Inspect Query Plan Only" or increase timeout.',
        '57014',
      );
    case 'ECONNREFUSED':
    case 'ENOTFOUND':
    case 'ETIMEDOUT':
    case 'PROTOCOL_CONNECTION_LOST':
      return new QueryExecutionError(
        `Cannot reach MySQL server (${code}). Check host, port, and whether Docker/MySQL is running.`,
        code,
      );
    default:
      return new QueryExecutionError(rawMessage, code || err.sqlState);
  }
}
