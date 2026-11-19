import {
  EmptyQueryError,
  MultipleStatementsError,
  UnsafeQueryError,
} from '../errors/domainErrors.js';
import type { ClassifiedSql, SqlStatementKind } from '../models/queryRequest.js';

interface SqlToken {
  readonly kind: 'whitespace' | 'comment' | 'semicolon' | 'token';
  readonly start: number;
  readonly end: number;
  readonly normalized: string;
  readonly paramIndex?: number | undefined;
}

const WRITE_KEYWORDS = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE']);
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
 * Single-pass PostgreSQL lexical tokenizer:
 * - recognizes line comments (--) and nested block comments (/* ... *\/)
 * - preserves single-quoted, double-quoted, and dollar-quoted literals
 * - identifies top-level semicolons and positional parameters ($1, $2, ...)
 */
function tokenizePostgreSql(rawSql: string): readonly SqlToken[] {
  const tokens: SqlToken[] = [];
  let i = 0;
  const len = rawSql.length;

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

    // Line comment: -- ...
    if (ch === '-' && next === '-') {
      const start = i;
      i += 2;
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

    // Nested block comment: /* ... */
    if (ch === '/' && next === '*') {
      const start = i;
      let depth = 1;
      i += 2;
      while (i < len && depth > 0) {
        if (rawSql[i] === '/' && rawSql[i + 1] === '*') {
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

    // Single-quoted string literal (E'...' backslash escapes and '' escapes)
    if (ch === "'") {
      const start = i;
      const isEscapedString =
        i > 0 &&
        (rawSql[i - 1] === 'e' || rawSql[i - 1] === 'E') &&
        (i === 1 || !/[a-zA-Z0-9_$]/.test(rawSql[i - 2]!));
      i++;
      while (i < len) {
        if (isEscapedString && rawSql[i] === '\\') {
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

    // Double-quoted identifier
    if (ch === '"') {
      const start = i;
      i++;
      while (i < len) {
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

    // Dollar-quoted literal ($tag$...$tag$) OR positional parameter ($1, $2...)
    if (ch === '$') {
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

      const tagMatch = /^(\$[a-zA-Z_]?[a-zA-Z0-9_]*\$)/.exec(rawSql.slice(i));
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

function determineStatementKind(words: readonly string[]): SqlStatementKind {
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

  if (WRITE_KEYWORDS.has(first)) {
    return 'WRITE';
  }

  if (first === 'WITH') {
    for (let idx = firstKeywordIndex + 1; idx < words.length; idx++) {
      const word = words[idx];
      if (word && WRITE_KEYWORDS.has(word)) {
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

export function classifySqlStatement(rawSql: string): ClassifiedSql {
  if (!rawSql || !rawSql.trim()) {
    throw new EmptyQueryError();
  }

  const lexed = tokenizePostgreSql(rawSql);
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

  const kind = determineStatementKind(words);
  if (kind === 'EXPLAIN') {
    throw new UnsafeQueryError(
      'Remove the leading EXPLAIN keyword — QueryAutopsy adds EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) automatically.',
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
 * Splits a PostgreSQL script into trimmed top-level statement spans (ignoring semicolons
 * inside comments, quotes, and dollar-quoted literals).
 */
export function extractSqlStatementSpans(
  rawSql: string,
): readonly SqlStatementSpan[] {
  const lexed = tokenizePostgreSql(rawSql);
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
): SqlStatementSpan | undefined {
  const spans = extractSqlStatementSpans(rawSql);
  return spans.find((span) => span.start <= offset && offset <= span.end);
}

/**
 * Extracts the single SQL statement text surrounding `offset` inside a multi-statement `.sql` file.
 */
export function extractSqlStatementAtOffset(
  rawSql: string,
  offset: number,
): string | undefined {
  return extractSqlStatementSpanAtOffset(rawSql, offset)?.sql;
}

const INDEX_COLUMN_ITEM =
  '(?:[a-zA-Z_][a-zA-Z0-9_$]*|[a-zA-Z_][a-zA-Z0-9_]*\\(\\s*[a-zA-Z_][a-zA-Z0-9_$]*\\s*\\))(?:\\s+(?:ASC|DESC))?(?:\\s+NULLS\\s+(?:FIRST|LAST))?';

const SAFE_CREATE_INDEX_REGEX = new RegExp(
  `^CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+CONCURRENTLY\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?[a-zA-Z_][a-zA-Z0-9_$]*\\s+ON\\s+(?:[a-zA-Z_][a-zA-Z0-9_$]*\\.)?[a-zA-Z_][a-zA-Z0-9_$]*\\s*\\(\\s*${INDEX_COLUMN_ITEM}(?:\\s*,\\s*${INDEX_COLUMN_ITEM})*\\s*\\)$`,
  'i',
);

/**
 * Validates that a SQL string is strictly a single safe `CREATE INDEX CONCURRENTLY` statement
 * before allowing explicit user-confirmed index creation.
 */
export function validateSafeCreateIndexSql(rawSql: string): string {
  if (!rawSql || !rawSql.trim()) {
    throw new EmptyQueryError();
  }

  const lexed = tokenizePostgreSql(rawSql);
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
  if (!normalized || !SAFE_CREATE_INDEX_REGEX.test(normalized)) {
    throw new UnsafeQueryError(
      'Only single-statement CREATE INDEX CONCURRENTLY statements can be applied automatically.',
    );
  }

  return `${normalized};`;
}
