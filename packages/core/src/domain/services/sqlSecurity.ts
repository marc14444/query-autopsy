import { UnsafeQueryError } from '../errors/domainErrors.js';
import type { DatabaseEngine } from '../models/databaseEngine.js';
import type { ExecutionPlan, PlanNode } from '../models/executionPlan.js';
import { type SqlToken, tokenizeSql } from './sqlTokenizer.js';

/**
 * Immutable built-in single-column SQL functions permitted inside automated
 * CREATE INDEX [CONCURRENTLY] suggestions and validations.
 */
export const SAFE_INDEX_EXPRESSION_FUNCTIONS = [
  'LOWER',
  'UPPER',
  'TRIM',
  'BTRIM',
  'LTRIM',
  'RTRIM',
  'LENGTH',
  'OCTET_LENGTH',
] as const;

const PG_DANGEROUS_FUNCTIONS = new Set([
  // Server filesystem & log access
  'pg_read_file',
  'pg_read_binary_file',
  'pg_ls_dir',
  'pg_ls_logdir',
  'pg_ls_waldir',
  'pg_ls_tmpdir',
  'pg_ls_archive_statusdir',
  'pg_stat_file',
  'pg_file_write',
  'pg_file_unlink',
  'pg_file_rename',
  'pg_file_sync',
  // Large object filesystem I/O
  'lo_import',
  'lo_export',
  'lo_create',
  'lo_unlink',
  'lo_put',
  'lo_get',
  // External network / SSRF extensions
  'dblink',
  'dblink_connect',
  'dblink_connect_u',
  'dblink_exec',
  'dblink_send_query',
  'dblink_open',
  'dblink_get_result',
  'dblink_fetch',
  'dblink_close',
  'dblink_disconnect',
  // Dynamic nested SQL evaluation hidden from static AST/tokenizers
  'query_to_xml',
  'query_to_xmlschema',
  'query_to_xml_and_xmlschema',
  'table_to_xml',
  'cursor_to_xml',
  // Session GUC / cluster control tampering (e.g. overriding statement_timeout)
  'set_config',
  'pg_terminate_backend',
  'pg_cancel_backend',
  'pg_reload_conf',
  'pg_rotate_logfile',
  'pg_switch_wal',
  'pg_create_restore_point',
  'pg_promote',
  'pg_log_backend_memory_contexts',
]);

const MYSQL_DANGEROUS_FUNCTIONS = new Set([
  'load_file',
  'sys_exec',
  'sys_eval',
]);

const SQLITE_DANGEROUS_FUNCTIONS = new Set(['load_extension']);

const DUCKDB_DANGEROUS_FUNCTIONS = new Set([
  'duckdb_secrets',
  'getenv',
  'read_text',
  'read_blob',
  'load_extension',
  'install_extension',
  'set_setting',
]);

function unquoteIdentifierToken(raw: string): string {
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    return raw.slice(1, -1).replace(/""/g, '"').toLowerCase();
  }
  if (raw.startsWith('`') && raw.endsWith('`') && raw.length >= 2) {
    return raw.slice(1, -1).replace(/``/g, '`').toLowerCase();
  }
  if (raw.startsWith('[') && raw.endsWith(']') && raw.length >= 2) {
    return raw.slice(1, -1).toLowerCase();
  }
  return raw.toLowerCase();
}

function dangerousFunctionSetForEngine(
  engine: DatabaseEngine,
): ReadonlySet<string> {
  switch (engine) {
    case 'mysql':
      return MYSQL_DANGEROUS_FUNCTIONS;
    case 'sqlite':
      return SQLITE_DANGEROUS_FUNCTIONS;
    case 'duckdb':
      return DUCKDB_DANGEROUS_FUNCTIONS;
    case 'postgresql':
    default:
      return PG_DANGEROUS_FUNCTIONS;
  }
}

/**
 * Inspects lexed SQL tokens for dangerous built-in/extension function calls
 * or file-export clauses (e.g., pg_read_file, dblink, set_config, LOAD_FILE,
 * INTO OUTFILE, load_extension) that should never be invoked via QueryAutopsy.
 */
export function findDangerousSqlConstruct(
  tokens: readonly SqlToken[],
  engine: DatabaseEngine = 'postgresql',
): string | undefined {
  const activeTokens = tokens.filter(
    (tok) => tok.kind === 'token' || tok.kind === 'semicolon',
  );
  const blockedFns = dangerousFunctionSetForEngine(engine);

  for (let i = 0; i < activeTokens.length; i++) {
    const current = activeTokens[i]!;
    const next = activeTokens[i + 1];

    if (
      (current.subkind === 'word' || current.subkind === 'identifier') &&
      next?.normalized === '('
    ) {
      const fnName = unquoteIdentifierToken(current.normalized);
      if (blockedFns.has(fnName)) {
        return `${fnName}()`;
      }
    }

    if (
      engine === 'mysql' &&
      current.subkind === 'word' &&
      current.normalized.toUpperCase() === 'INTO' &&
      next?.subkind === 'word'
    ) {
      const target = next.normalized.toUpperCase();
      if (target === 'OUTFILE' || target === 'DUMPFILE') {
        return `INTO ${target}`;
      }
    }
  }

  return undefined;
}

export function assertSafeSqlConstructs(
  rawSql: string,
  engine: DatabaseEngine = 'postgresql',
): void {
  const tokens = tokenizeSql(rawSql, engine);
  const match = findDangerousSqlConstruct(tokens, engine);
  if (match) {
    throw new UnsafeQueryError(
      `Blocked potentially dangerous SQL construct "${match}". QueryAutopsy restricts file I/O, session config mutation, external network functions, and cluster-control calls.`,
    );
  }
}

export interface RedactSqlOptions {
  /** Replace comments (`-- ...`, `/* ... *\/`, `# ...`) with a single space (default: true). */
  readonly stripComments?: boolean;
}

/**
 * Replaces SQL string literals (`'...'`, `E'...'`, `$$...$$`, MySQL `"..."`) with
 * `'[REDACTED]'` while preserving SQL structure, column identifiers, and `$1`/`?` parameters.
 * Also works safely on PostgreSQL/MySQL EXPLAIN `Filter` / `Index Cond` expressions.
 */
export function redactSqlLiterals(
  rawSql: string,
  engine: DatabaseEngine = 'postgresql',
  options?: RedactSqlOptions,
): string {
  if (!rawSql) {
    return rawSql;
  }

  const stripComments = options?.stripComments ?? true;
  const tokens = tokenizeSql(rawSql, engine);
  const out: string[] = [];
  let cursor = 0;

  for (const tok of tokens) {
    if (tok.start > cursor) {
      out.push(rawSql.slice(cursor, tok.start));
    }

    if (tok.kind === 'comment' && stripComments) {
      out.push(' ');
      cursor = tok.end;
      continue;
    }

    if (tok.subkind === 'string') {
      // Strip preceding E/e prefix on PG escape literals so E'secret' becomes '[REDACTED]' cleanly
      const prev = out[out.length - 1];
      if (
        engine === 'postgresql' &&
        prev &&
        (prev === 'E' || prev === 'e') &&
        rawSql[tok.start] === "'"
      ) {
        out.pop();
      }
      out.push("'[REDACTED]'");
      cursor = tok.end;
      continue;
    }

    out.push(rawSql.slice(tok.start, tok.end));
    cursor = tok.end;
  }

  if (cursor < rawSql.length) {
    out.push(rawSql.slice(cursor));
  }

  const combined = out.join('');
  return stripComments
    ? combined.replace(/[ \t]{2,}/g, ' ').trim()
    : combined;
}

function redactPlanNodeRecursive(
  node: PlanNode,
  engine: DatabaseEngine,
): PlanNode {
  const redact = (value: string | undefined): string | undefined =>
    value !== undefined
      ? redactSqlLiterals(value, engine, { stripComments: true })
      : undefined;

  return {
    ...node,
    filter: redact(node.filter),
    indexCond: redact(node.indexCond),
    recheckCond: redact(node.recheckCond),
    hashCond: redact(node.hashCond),
    children: node.children.map((child) =>
      redactPlanNodeRecursive(child, engine),
    ),
  };
}

/**
 * Returns a copy of `ExecutionPlan` with SQL predicate filters redacted for PII protection.
 */
export function redactExecutionPlanLiterals(
  plan: ExecutionPlan,
  engine: DatabaseEngine = 'postgresql',
): ExecutionPlan {
  return {
    ...plan,
    root: redactPlanNodeRecursive(plan.root, engine),
    // Raw engine JSON contains unredacted literal expressions inside Filter/Output; omit when redacting
    rawJson: { redacted: true },
  };
}

const MAX_SANITIZED_ERROR_LENGTH = 300;

/**
 * Sanitizes database error strings before exposing them to AI agents / MCP tools
 * to prevent error-based data exfiltration (e.g. `CAST((SELECT secret) AS int)`,
 * constraint `Detail: Key (col)=(val)`, enum rejections, or stack/context dumps).
 */
export function sanitizeSqlError(
  rawMessage: string,
  sqlState?: string,
): string {
  let cleaned = rawMessage
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // Strip PostgreSQL PL/pgSQL context/where dumps
  cleaned = cleaned.replace(/\s*\bCONTEXT:\s*.*$/i, '');

  // Scrub PostgreSQL cast / enum / range value leaks: `... for type integer: "$2b$..."`
  cleaned = cleaned.replace(
    /(invalid input syntax for (?:\w+\s+)?type [^:]+:\s*)"[^"]*"/gi,
    '$1"[REDACTED]"',
  );
  cleaned = cleaned.replace(
    /(invalid input value for enum [^:]+:\s*)"[^"]*"/gi,
    '$1"[REDACTED]"',
  );
  cleaned = cleaned.replace(
    /(value\s+)"[^"]*"(\s+is out of range\b)/gi,
    '$1"[REDACTED]"$2',
  );

  // Scrub MySQL value leaks: `Incorrect integer value: 'secret'`, `Truncated incorrect ... value: 'secret'`
  cleaned = cleaned.replace(
    /((?:Truncated\s+)?incorrect\s+[^:]+value:\s*)'[^']*'/gi,
    "$1'[REDACTED]'",
  );

  // Scrub PostgreSQL constraint / duplicate-key row values in Detail payloads
  cleaned = cleaned.replace(
    /(Key\s*\([^)]+\)\s*=\s*\()[^)]*(\))/gi,
    '$1[REDACTED]$2',
  );
  cleaned = cleaned.replace(
    /(Failing row contains\s*\()[^)]*(\))/gi,
    '$1[REDACTED]$2',
  );

  // Redact any remaining single-quoted literal values in Detail clauses or error values
  cleaned = cleaned.replace(/'(?:''|[^'])*'/g, "'[REDACTED]'");

  if (cleaned.length > MAX_SANITIZED_ERROR_LENGTH) {
    cleaned = `${cleaned.slice(0, MAX_SANITIZED_ERROR_LENGTH - 3)}...`;
  }

  return sqlState && !cleaned.includes(sqlState)
    ? `[SQLSTATE ${sqlState}] ${cleaned}`
    : cleaned;
}
