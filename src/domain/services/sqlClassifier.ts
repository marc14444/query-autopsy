import {
  EmptyQueryError,
  MultipleStatementsError,
  UnsafeQueryError,
} from '../errors/domainErrors.js';
import type { DatabaseEngine } from '../models/databaseEngine.js';
import type { ClassifiedSql, SqlStatementKind } from '../models/queryRequest.js';
import {
  findDangerousSqlConstruct,
  SAFE_INDEX_EXPRESSION_FUNCTIONS,
} from './sqlSecurity.js';
import { type SqlToken, tokenizeSql } from './sqlTokenizer.js';

export { tokenizeSql, type SqlToken };

const PG_WRITE_KEYWORDS = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE']);
const MULTI_WRITE_KEYWORDS = new Set([
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'REPLACE',
]);
const READ_KEYWORDS = new Set(['SELECT', 'WITH', 'VALUES', 'TABLE']);
const DDL_KEYWORDS = new Set([
  'CREATE',
  'ALTER',
  'DROP',
  'TRUNCATE',
  'GRANT',
  'REVOKE',
  'VACUUM',
  'CLUSTER',
  'REINDEX',
  'COMMENT',
  'LOCK',
  'COPY',
  'ATTACH',
  'DETACH',
  'PRAGMA',
  'RENAME',
  'OPTIMIZE',
  'ANALYZE',
]);
const CLAUSE_FRAGMENT_KEYWORDS = new Set([
  'FROM',
  'WHERE',
  'JOIN',
  'INNER',
  'LEFT',
  'RIGHT',
  'FULL',
  'CROSS',
  'ON',
  'AND',
  'OR',
  'GROUP',
  'HAVING',
  'ORDER',
  'LIMIT',
  'OFFSET',
  'SET',
  'RETURNING',
  'UNION',
  'INTERSECT',
  'EXCEPT',
]);

function firstTopLevelKeyword(words: readonly string[]): string | undefined {
  let idx = 0;
  while (idx < words.length && words[idx] === '(') {
    idx++;
  }
  return words[idx];
}

function determineStatementKind(
  words: readonly string[],
  engine: DatabaseEngine = 'postgresql',
): SqlStatementKind {
  let firstKeywordIndex = 0;
  while (
    firstKeywordIndex < words.length &&
    words[firstKeywordIndex] === '('
  ) {
    firstKeywordIndex++;
  }

  const first = words[firstKeywordIndex];
  if (!first) {
    return 'UNKNOWN';
  }

  if (first === 'EXPLAIN') {
    return 'EXPLAIN';
  }

  if (DDL_KEYWORDS.has(first)) {
    return 'DDL';
  }

  const writeKeywords =
    engine === 'postgresql' ? PG_WRITE_KEYWORDS : MULTI_WRITE_KEYWORDS;

  if (writeKeywords.has(first)) {
    return 'WRITE';
  }

  if (first === 'WITH') {
    for (let idx = firstKeywordIndex + 1; idx < words.length; idx++) {
      const word = words[idx];
      if (word && writeKeywords.has(word)) {
        return 'WRITE';
      }
    }
    return 'READ';
  }

  if (READ_KEYWORDS.has(first)) {
    return 'READ';
  }

  return 'UNKNOWN';
}

export function classifySqlStatement(
  rawSql: string,
  engine: DatabaseEngine = 'postgresql',
): ClassifiedSql {
  if (!rawSql || !rawSql.trim()) {
    throw new EmptyQueryError();
  }

  const lexed = tokenizeSql(rawSql, engine);
  const words: string[] = [];
  const parameterSet = new Set<number>();
  const strippedParts: string[] = [];
  let statementTerminated = false;

  for (const tok of lexed) {
    if (tok.kind === 'whitespace') {
      strippedParts.push(tok.normalized);
      continue;
    }
    if (tok.kind === 'comment') {
      strippedParts.push(' ');
      continue;
    }
    if (tok.kind === 'semicolon') {
      if (words.length > 0) {
        statementTerminated = true;
      }
      continue;
    }

    if (statementTerminated) {
      throw new MultipleStatementsError();
    }

    strippedParts.push(tok.normalized);
    words.push(tok.normalized.toUpperCase());
    if (tok.paramIndex !== undefined) {
      parameterSet.add(tok.paramIndex);
    }
  }

  const normalizedSql = strippedParts.join('').trim();
  if (words.length === 0 || !normalizedSql) {
    throw new EmptyQueryError();
  }

  const kind = determineStatementKind(words, engine);
  if (kind === 'EXPLAIN') {
    const explainSyntax =
      engine === 'sqlite'
        ? 'EXPLAIN QUERY PLAN'
        : engine === 'mysql'
          ? 'EXPLAIN ANALYZE / FORMAT=JSON'
          : 'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)';
    throw new UnsafeQueryError(
      `Remove the leading EXPLAIN keyword — QueryAutopsy adds ${explainSyntax} automatically.`,
    );
  }

  if (kind === 'UNKNOWN') {
    const first = firstTopLevelKeyword(words);
    if (first && CLAUSE_FRAGMENT_KEYWORDS.has(first)) {
      throw new UnsafeQueryError(
        `Partial SQL fragment selected (starts with "${first}"). Select the complete statement from SELECT / WITH / INSERT / UPDATE / DELETE, or place your cursor inside a query in a .sql file with nothing selected.`,
      );
    }
  }

  if (kind === 'READ' || kind === 'WRITE') {
    const dangerousConstruct = findDangerousSqlConstruct(lexed, engine);
    if (dangerousConstruct) {
      throw new UnsafeQueryError(
        `Blocked potentially dangerous SQL construct "${dangerousConstruct}". QueryAutopsy restricts file I/O, session config mutation, external network functions, and cluster-control calls.`,
      );
    }
  }

  return {
    normalizedSql,
    kind,
    parameterIndices: Array.from(parameterSet).sort((a, b) => a - b),
  };
}

export interface SqlStatementSpan {
  readonly sql: string;
  readonly start: number;
  readonly end: number;
}

/**
 * Splits a SQL script into trimmed top-level statement spans (ignoring semicolons
 * inside comments, quotes, and dollar-quoted literals).
 */
export function extractSqlStatementSpans(
  rawSql: string,
  engine: DatabaseEngine = 'postgresql',
): readonly SqlStatementSpan[] {
  const lexed = tokenizeSql(rawSql, engine);
  const rawSpans: Array<{ readonly start: number; readonly end: number }> = [];
  let currentStart: number | undefined;

  for (const tok of lexed) {
    if (tok.kind === 'token' && currentStart === undefined) {
      currentStart = tok.start;
    } else if (tok.kind === 'semicolon' && currentStart !== undefined) {
      rawSpans.push({ start: currentStart, end: tok.end });
      currentStart = undefined;
    }
  }

  if (currentStart !== undefined) {
    rawSpans.push({ start: currentStart, end: rawSql.length });
  }

  const results: SqlStatementSpan[] = [];
  for (const span of rawSpans) {
    const rawSlice = rawSql.slice(span.start, span.end);
    const trimmed = rawSlice.trim();
    if (!trimmed) {
      continue;
    }
    const leadingTrim = rawSlice.length - rawSlice.trimStart().length;
    const trailingTrim = rawSlice.length - rawSlice.trimEnd().length;
    results.push({
      sql: trimmed,
      start: span.start + leadingTrim,
      end: span.end - trailingTrim,
    });
  }

  return results;
}

/**
 * Extracts the SQL statement span surrounding `offset` inside a multi-statement `.sql` file.
 * Returns undefined if `offset` falls outside any statement (e.g. blank lines or standalone comments).
 */
export function extractSqlStatementSpanAtOffset(
  rawSql: string,
  offset: number,
  engine: DatabaseEngine = 'postgresql',
): SqlStatementSpan | undefined {
  const spans = extractSqlStatementSpans(rawSql, engine);
  return spans.find((span) => span.start <= offset && offset <= span.end);
}

/**
 * Extracts the single SQL statement text surrounding `offset` inside a multi-statement `.sql` file.
 */
export function extractSqlStatementAtOffset(
  rawSql: string,
  offset: number,
  engine: DatabaseEngine = 'postgresql',
): string | undefined {
  return extractSqlStatementSpanAtOffset(rawSql, offset, engine)?.sql;
}

const IDENT = '(?:`?[a-zA-Z_][a-zA-Z0-9_$]*`?)';
const SAFE_EXPR_FN_ALT = SAFE_INDEX_EXPRESSION_FUNCTIONS.join('|');

const INDEX_COLUMN_ITEM = `(?:${IDENT}|(?:${SAFE_EXPR_FN_ALT})\\(\\s*${IDENT}\\s*\\))(?:\\s+(?:ASC|DESC))?(?:\\s+NULLS\\s+(?:FIRST|LAST))?`;

const SAFE_PG_CREATE_INDEX_REGEX = new RegExp(
  `^CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+CONCURRENTLY\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?[a-zA-Z_][a-zA-Z0-9_$]*\\s+ON\\s+(?:[a-zA-Z_][a-zA-Z0-9_$]*\\.)?[a-zA-Z_][a-zA-Z0-9_$]*\\s*\\(\\s*${INDEX_COLUMN_ITEM}(?:\\s*,\\s*${INDEX_COLUMN_ITEM})*\\s*\\)$`,
  'i',
);

const SAFE_MYSQL_CREATE_INDEX_REGEX = new RegExp(
  `^CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+${IDENT}\\s+ON\\s+(?:${IDENT}\\.)?${IDENT}\\s*\\(\\s*${INDEX_COLUMN_ITEM}(?:\\s*,\\s*${INDEX_COLUMN_ITEM})*\\s*\\)$`,
  'i',
);

const SAFE_SQLITE_CREATE_INDEX_REGEX = new RegExp(
  `^CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:${IDENT}\\.)?${IDENT}\\s+ON\\s+${IDENT}\\s*\\(\\s*${INDEX_COLUMN_ITEM}(?:\\s*,\\s*${INDEX_COLUMN_ITEM})*\\s*\\)$`,
  'i',
);

/**
 * Validates that a SQL string is strictly a single safe index creation statement
 * before allowing explicit user-confirmed index creation.
 */
export function validateSafeCreateIndexSql(
  rawSql: string,
  engine: DatabaseEngine = 'postgresql',
): string {
  if (!rawSql || !rawSql.trim()) {
    throw new EmptyQueryError();
  }

  const lexed = tokenizeSql(rawSql, engine);
  const parts: string[] = [];
  let terminated = false;
  let hasTokens = false;

  for (const tok of lexed) {
    if (tok.kind === 'whitespace') {
      parts.push(' ');
      continue;
    }
    if (tok.kind === 'comment') {
      continue;
    }
    if (tok.kind === 'semicolon') {
      if (hasTokens) {
        terminated = true;
      }
      continue;
    }
    if (terminated) {
      throw new MultipleStatementsError();
    }
    hasTokens = true;
    parts.push(tok.normalized);
  }

  const normalized = parts.join('').replace(/\s+/g, ' ').trim();
  const pattern =
    engine === 'mysql'
      ? SAFE_MYSQL_CREATE_INDEX_REGEX
      : engine === 'sqlite'
        ? SAFE_SQLITE_CREATE_INDEX_REGEX
        : SAFE_PG_CREATE_INDEX_REGEX;

  if (!normalized || !pattern.test(normalized)) {
    const expectedLabel =
      engine === 'postgresql'
        ? 'CREATE INDEX CONCURRENTLY'
        : 'CREATE INDEX';
    throw new UnsafeQueryError(
      `Only single-statement ${expectedLabel} statements with safe column or allowlisted immutable expressions can be applied automatically.`,
    );
  }

  return `${normalized};`;
}
