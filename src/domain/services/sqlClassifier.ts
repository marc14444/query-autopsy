import {
  EmptyQueryError,
  MultipleStatementsError,
  UnsafeQueryError,
} from '../errors/domainErrors.js';
import type { DatabaseEngine } from '../models/databaseEngine.js';
import type { ClassifiedSql, SqlStatementKind } from '../models/queryRequest.js';

interface SqlToken {
  readonly kind: 'whitespace' | 'comment' | 'semicolon' | 'token';
  readonly start: number;
  readonly end: number;
  readonly normalized: string;
  readonly paramIndex?: number | undefined;
}

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

/**
 * Single-pass SQL lexical tokenizer parameterized by engine dialect:
 * - recognizes line comments (-- and MySQL #) and block comments (/* ... *\/)
 * - preserves single-quoted, double-quoted, backtick-quoted, and PG dollar-quoted literals
 * - identifies top-level semicolons and positional parameters ($1..$N, ?, ?N)
 */
function tokenizeSql(
  rawSql: string,
  engine: DatabaseEngine = 'postgresql',
): readonly SqlToken[] {
  const tokens: SqlToken[] = [];
  let i = 0;
  const len = rawSql.length;
  let anonymousParamCounter = 0;

  while (i < len) {
    const ch = rawSql[i]!;
    const next = rawSql[i + 1];

    if (/\s/.test(ch)) {
      const start = i;
      i++;
      while (i < len && /\s/.test(rawSql[i]!)) {
        i++;
      }
      tokens.push({
        kind: 'whitespace',
        start,
        end: i,
        normalized: rawSql.slice(start, i),
      });
      continue;
    }

    // Line comment: -- ... (or MySQL # ...)
    if ((ch === '-' && next === '-') || (engine === 'mysql' && ch === '#')) {
      const start = i;
      i += ch === '#' ? 1 : 2;
      while (i < len && rawSql[i] !== '\n') {
        i++;
      }
      tokens.push({
        kind: 'comment',
        start,
        end: i,
        normalized: ' ',
      });
      continue;
    }

    // Block comment: /* ... */ (nested in PostgreSQL)
    if (ch === '/' && next === '*') {
      const start = i;
      let depth = 1;
      i += 2;
      while (i < len && depth > 0) {
        if (
          engine === 'postgresql' &&
          rawSql[i] === '/' &&
          rawSql[i + 1] === '*'
        ) {
          depth++;
          i += 2;
        } else if (rawSql[i] === '*' && rawSql[i + 1] === '/') {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      tokens.push({
        kind: 'comment',
        start,
        end: i,
        normalized: ' ',
      });
      continue;
    }

    // Top-level semicolon
    if (ch === ';') {
      tokens.push({
        kind: 'semicolon',
        start: i,
        end: i + 1,
        normalized: ';',
      });
      i++;
      continue;
    }

    // Single-quoted string literal (PG E'...' / MySQL backslash escapes and '' escapes)
    if (ch === "'") {
      const start = i;
      const allowBackslashEscape =
        engine === 'mysql' ||
        (engine === 'postgresql' &&
          i > 0 &&
          (rawSql[i - 1] === 'e' || rawSql[i - 1] === 'E') &&
          (i === 1 || !/[a-zA-Z0-9_$]/.test(rawSql[i - 2]!)));
      i++;
      while (i < len) {
        if (allowBackslashEscape && rawSql[i] === '\\') {
          i += 2;
          continue;
        }
        if (rawSql[i] === "'") {
          if (rawSql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      const literal = rawSql.slice(start, i);
      tokens.push({ kind: 'token', start, end: i, normalized: literal });
      continue;
    }

    // Double-quoted identifier (or MySQL double-quoted string)
    if (ch === '"') {
      const start = i;
      i++;
      while (i < len) {
        if (engine === 'mysql' && rawSql[i] === '\\') {
          i += 2;
          continue;
        }
        if (rawSql[i] === '"') {
          if (rawSql[i + 1] === '"') {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      const ident = rawSql.slice(start, i);
      tokens.push({ kind: 'token', start, end: i, normalized: ident });
      continue;
    }

    // Backtick-quoted identifier (MySQL & SQLite)
    if (ch === '`' && (engine === 'mysql' || engine === 'sqlite')) {
      const start = i;
      i++;
      while (i < len) {
        if (rawSql[i] === '`') {
          if (rawSql[i + 1] === '`') {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      const ident = rawSql.slice(start, i);
      tokens.push({ kind: 'token', start, end: i, normalized: ident });
      continue;
    }

    // SQLite [bracket] identifier
    if (ch === '[' && engine === 'sqlite') {
      const closeIdx = rawSql.indexOf(']', i + 1);
      if (closeIdx !== -1) {
        const ident = rawSql.slice(i, closeIdx + 1);
        tokens.push({
          kind: 'token',
          start: i,
          end: closeIdx + 1,
          normalized: ident,
        });
        i = closeIdx + 1;
        continue;
      }
    }

    // MySQL & SQLite `?` / `?NNN` positional parameter placeholders
    if (ch === '?' && (engine === 'mysql' || engine === 'sqlite')) {
      if (engine === 'sqlite') {
        const numMatch = /^\?([1-9][0-9]*)/.exec(rawSql.slice(i));
        if (numMatch) {
          const paramNum = Number(numMatch[1]);
          anonymousParamCounter = Math.max(anonymousParamCounter, paramNum);
          tokens.push({
            kind: 'token',
            start: i,
            end: i + numMatch[0].length,
            normalized: numMatch[0],
            paramIndex: paramNum,
          });
          i += numMatch[0].length;
          continue;
        }
      }
      anonymousParamCounter++;
      tokens.push({
        kind: 'token',
        start: i,
        end: i + 1,
        normalized: '?',
        paramIndex: anonymousParamCounter,
      });
      i++;
      continue;
    }

    // Dollar-quoted literal ($tag$...$tag$) OR positional parameter ($1, $2...)
    if (ch === '$' && (engine === 'postgresql' || engine === 'sqlite')) {
      const paramMatch = /^\$([1-9][0-9]*)(?![a-zA-Z0-9_$])/.exec(
        rawSql.slice(i),
      );
      const prevChar = i > 0 ? rawSql[i - 1] : undefined;
      const isStandaloneDollar =
        prevChar === undefined || !/[a-zA-Z0-9_$]/.test(prevChar);

      if (paramMatch && isStandaloneDollar) {
        const paramNum = Number(paramMatch[1]);
        const literal = paramMatch[0];
        tokens.push({
          kind: 'token',
          start: i,
          end: i + literal.length,
          normalized: literal,
          paramIndex: paramNum,
        });
        i += literal.length;
        continue;
      }

      if (engine === 'postgresql') {
        const tagMatch = /^(\$[a-zA-Z_]?[a-zA-Z0-9_]*\$)/.exec(
          rawSql.slice(i),
        );
        if (tagMatch) {
          const tag = tagMatch[1]!;
          const closeIndex = rawSql.indexOf(tag, i + tag.length);
          const end = closeIndex === -1 ? len : closeIndex + tag.length;
          const literal = rawSql.slice(i, end);
          tokens.push({ kind: 'token', start: i, end, normalized: literal });
          i = end;
          continue;
        }
      }
    }

    // Word / keyword / identifier
    if (/[a-zA-Z_]/.test(ch)) {
      const start = i;
      i++;
      while (i < len && /[a-zA-Z0-9_$]/.test(rawSql[i]!)) {
        i++;
      }
      const word = rawSql.slice(start, i);
      tokens.push({
        kind: 'token',
        start,
        end: i,
        normalized: word,
      });
      continue;
    }

    // Punctuation / operator / number
    tokens.push({
      kind: 'token',
      start: i,
      end: i + 1,
      normalized: ch,
    });
    i++;
  }

  return tokens;
}

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

const INDEX_COLUMN_ITEM = `(?:${IDENT}|[a-zA-Z_][a-zA-Z0-9_]*\\(\\s*${IDENT}\\s*\\))(?:\\s+(?:ASC|DESC))?(?:\\s+NULLS\\s+(?:FIRST|LAST))?`;

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
      `Only single-statement ${expectedLabel} statements can be applied automatically.`,
    );
  }

  return `${normalized};`;
}
