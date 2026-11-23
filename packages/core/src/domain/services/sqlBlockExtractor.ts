import {
  classifySqlStatement,
  extractSqlStatementSpans,
} from './sqlClassifier.js';

export type SqlBlockSourceKind =
  | 'sql-file'
  | 'ts-tagged-template'
  | 'ts-orm-call'
  | 'python-sql'
  | 'go-sql'
  | 'php-sql'
  | 'dbt-sql'
  | 'notebook-cell';

export interface DetectedSqlBlock {
  readonly sql: string;
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
  readonly sourceKind: SqlBlockSourceKind;
}

interface LinePosition {
  readonly line: number;
  readonly column: number;
}

const SQL_LANGUAGE_IDS = new Set([
  'sql',
  'postgres',
  'pgsql',
  'mysql',
  'sqlite',
  'mssql',
]);
const TS_JS_LANGUAGE_IDS = new Set([
  'typescript',
  'javascript',
  'typescriptreact',
  'javascriptreact',
]);
const PYTHON_LANGUAGE_IDS = new Set(['python']);
const GO_LANGUAGE_IDS = new Set(['go']);
const PHP_LANGUAGE_IDS = new Set(['php']);

const REGEX_PRECEDING_KEYWORDS = new Set([
  'return',
  'throw',
  'case',
  'in',
  'instanceof',
  'typeof',
  'void',
  'delete',
  'await',
  'yield',
  'else',
]);

const TS_DRIVER_CALL_METHODS = new Set([
  'query',
  'queryone',
  'queryall',
  'execute',
  'raw',
  '$queryraw',
  '$queryrawunsafe',
  '$executeraw',
  '$executerawunsafe',
]);

const PYTHON_DB_CALL_METHODS = new Set([
  'execute',
  'executemany',
  'executescript',
  'text',
  'raw',
  'fetch',
  'fetchrow',
  'fetchval',
  'fetchall',
  'fetchone',
  'query',
  'read_sql',
  'read_sql_query',
  'read_sql_table',
  'read_database',
  'sql',
]);

const GO_DB_CALL_METHODS = new Set([
  'query',
  'querycontext',
  'queryrow',
  'queryrowcontext',
  'exec',
  'execcontext',
  'select',
  'selectcontext',
  'get',
  'getcontext',
  'namedquery',
  'namedexec',
  'raw',
  'prepare',
  'preparecontext',
]);

const PHP_DB_CALL_METHODS = new Set([
  'select',
  'selectone',
  'selectfromwriteconnection',
  'scalar',
  'insert',
  'update',
  'delete',
  'statement',
  'affectingstatement',
  'unprepared',
  'raw',
  'query',
  'prepare',
  'exec',
  'createcommand',
  'fetchallassociative',
  'fetchassociative',
  'fetchone',
  'executequery',
  'executestatement',
  'pg_query',
  'pg_query_params',
  'pg_prepare',
  'mysqli_query',
  'mysqli_prepare',
]);

function computeLineOffsets(text: string): readonly number[] {
  const offsets: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      offsets.push(i + 1);
    }
  }
  return offsets;
}

function offsetToPosition(
  lineOffsets: readonly number[],
  offset: number,
): LinePosition {
  const clamped = Math.max(0, offset);
  let low = 0;
  let high = lineOffsets.length - 1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    const lineStart = lineOffsets[mid]!;
    const nextStart = lineOffsets[mid + 1];
    if (clamped < lineStart) {
      high = mid - 1;
    } else if (nextStart !== undefined && clamped >= nextStart) {
      low = mid + 1;
    } else {
      return { line: mid, column: clamped - lineStart };
    }
  }

  const lastLine = Math.max(0, lineOffsets.length - 1);
  return {
    line: lastLine,
    column: Math.max(0, clamped - (lineOffsets[lastLine] ?? 0)),
  };
}

function isInspectableSql(candidateSql: string): boolean {
  for (const engine of ['postgresql', 'mysql', 'sqlite'] as const) {
    try {
      const classified = classifySqlStatement(candidateSql, engine);
      if (classified.kind === 'READ' || classified.kind === 'WRITE') {
        return true;
      }
    } catch {
      // Try next dialect
    }
  }
  return false;
}

function looksLikeStandaloneSql(sql: string): boolean {
  const upper = sql.toUpperCase();
  if (/^\s*SELECT\b/.test(upper)) {
    return (
      /\bFROM\b/.test(upper) &&
      (/(\*|,|\$[1-9][0-9]*|\?|;|\n)/.test(sql) ||
        /\b(WHERE|JOIN|GROUP\s+BY|ORDER\s+BY|LIMIT|HAVING|UNION|INTERSECT|EXCEPT)\b/.test(
          upper,
        ))
    );
  }
  if (/^\s*WITH\b/.test(upper)) {
    return /\bAS\s*\(/.test(upper);
  }
  if (/^\s*(?:INSERT|REPLACE)\b/.test(upper)) {
    return /\bINTO\b/.test(upper);
  }
  if (/^\s*UPDATE\b/.test(upper)) {
    return /\bSET\b/.test(upper);
  }
  if (/^\s*DELETE\b/.test(upper)) {
    return /\bFROM\b/.test(upper);
  }
  if (/^\s*MERGE\b/.test(upper)) {
    return /\bINTO\b/.test(upper) && /\bUSING\b/.test(upper);
  }
  return false;
}

function unescapeStandardString(raw: string): string {
  return raw
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

/**
 * Normalizes Python driver placeholders (`%s`, `%(name)s`, `:name`) outside SQL string literals
 * into `$1..$n` while keeping PostgreSQL `::type` casts and existing `?` / `$1` untouched.
 */
function normalizePythonPlaceholders(sql: string): string {
  let out = '';
  let i = 0;
  let nextIdx = 1;
  const namedMap = new Map<string, string>();

  while (i < sql.length) {
    const ch = sql[i]!;

    // Preserve SQL string literals verbatim
    if (ch === "'" || ch === '"') {
      const start = i;
      i++;
      while (i < sql.length) {
        if (sql[i] === ch) {
          if (sql[i + 1] === ch) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      out += sql.slice(start, i);
      continue;
    }

    // %s or %(name)s (psycopg / pymysql)
    if (ch === '%') {
      if (sql[i + 1] === 's') {
        out += `$${nextIdx++}`;
        i += 2;
        continue;
      }
      const namedPyMatch = /^%\(([a-zA-Z_][a-zA-Z0-9_]*)\)s/.exec(
        sql.slice(i),
      );
      if (namedPyMatch?.[1]) {
        const key = namedPyMatch[1];
        let placeholder = namedMap.get(key);
        if (!placeholder) {
          placeholder = `$${nextIdx++}`;
          namedMap.set(key, placeholder);
        }
        out += placeholder;
        i += namedPyMatch[0].length;
        continue;
      }
    }

    // SQLAlchemy :param_name (avoid matching PG ::type casts)
    if (ch === ':') {
      const prevChar = i > 0 ? sql[i - 1] : undefined;
      if (prevChar === ':' || sql[i + 1] === ':') {
        out += ch;
        i++;
        continue;
      }
      const namedSaMatch = /^:([a-zA-Z_][a-zA-Z0-9_]*)/.exec(sql.slice(i));
      if (namedSaMatch?.[1]) {
        const key = namedSaMatch[1];
        let placeholder = namedMap.get(key);
        if (!placeholder) {
          placeholder = `$${nextIdx++}`;
          namedMap.set(key, placeholder);
        }
        out += placeholder;
        i += namedSaMatch[0].length;
        continue;
      }
    }

    out += ch;
    i++;
  }

  return out;
}

interface ParsedTemplateResult {
  readonly sql: string;
  readonly endOffset: number;
}

function skipJsString(source: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) {
      return i + 1;
    }
    i++;
  }
  return source.length;
}

function skipJsInterpolation(source: string, openBraceIndex: number): number {
  let depth = 1;
  let i = openBraceIndex + 1;
  while (i < source.length && depth > 0) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (ch === "'" || ch === '"') {
      i = skipJsString(source, i, ch);
      continue;
    }
    if (ch === '`') {
      i = parseTemplateLiteral(source, i).endOffset;
      continue;
    }
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < source.length && source[i] !== '\n') {
        i++;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (
        i < source.length &&
        !(source[i] === '*' && source[i + 1] === '/')
      ) {
        i++;
      }
      i += 2;
      continue;
    }
    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
    }
    i++;
  }
  return i;
}

function parseTemplateLiteral(
  source: string,
  startBacktick: number,
): ParsedTemplateResult {
  const parts: string[] = [];
  let paramCounter = 0;
  let i = startBacktick + 1;

  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '\\') {
      parts.push(source.slice(i, i + 2));
      i += 2;
      continue;
    }
    if (ch === '`') {
      return {
        sql: parts.join(''),
        endOffset: i + 1,
      };
    }
    if (ch === '$' && source[i + 1] === '{') {
      paramCounter++;
      parts.push(`$${paramCounter}`);
      i = skipJsInterpolation(source, i + 1);
      continue;
    }
    parts.push(ch);
    i++;
  }

  return {
    sql: parts.join(''),
    endOffset: source.length,
  };
}

function pushBlockIfValid(
  blocks: DetectedSqlBlock[],
  lineOffsets: readonly number[],
  candidateSql: string,
  startOffset: number,
  endOffset: number,
  sourceKind: SqlBlockSourceKind,
  hasExplicitContext: boolean,
): void {
  const trimmedSql = candidateSql.trim();
  if (
    !trimmedSql ||
    (!hasExplicitContext && !looksLikeStandaloneSql(trimmedSql)) ||
    !isInspectableSql(trimmedSql)
  ) {
    return;
  }
  const startPos = offsetToPosition(lineOffsets, startOffset);
  const endPos = offsetToPosition(lineOffsets, endOffset);
  blocks.push({
    sql: trimmedSql,
    startLine: startPos.line,
    startColumn: startPos.column,
    endLine: endPos.line,
    endColumn: endPos.column,
    sourceKind,
  });
}

function extractTsTemplateBlocks(
  text: string,
  lineOffsets: readonly number[],
): readonly DetectedSqlBlock[] {
  const blocks: DetectedSqlBlock[] = [];
  let i = 0;
  const len = text.length;

  let prevNonTrivia = '';
  let prevCallIdentifier = '';
  let pendingSqlComment = false;

  while (i < len) {
    const ch = text[i]!;
    const next = text[i + 1];

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    if (ch === '/' && next === '/') {
      const commentStart = i + 2;
      i += 2;
      while (i < len && text[i] !== '\n') {
        i++;
      }
      const commentText = text.slice(commentStart, i).trim().toLowerCase();
      if (commentText === 'sql') {
        pendingSqlComment = true;
      }
      continue;
    }

    if (ch === '/' && next === '*') {
      const commentStart = i + 2;
      i += 2;
      while (i < len && !(text[i] === '*' && text[i + 1] === '/')) {
        i++;
      }
      const commentText = text.slice(commentStart, i).trim().toLowerCase();
      i = Math.min(len, i + 2);
      pendingSqlComment = commentText === 'sql';
      continue;
    }

    if (
      ch === '/' &&
      (prevNonTrivia === '' ||
        /[=(:,[!&|?;{]/.test(prevNonTrivia) ||
        prevNonTrivia === '=>' ||
        REGEX_PRECEDING_KEYWORDS.has(prevNonTrivia))
    ) {
      i++;
      let inCharClass = false;
      while (i < len) {
        const rc = text[i]!;
        if (rc === '\\') {
          i += 2;
          continue;
        }
        if (rc === '[') {
          inCharClass = true;
        } else if (rc === ']') {
          inCharClass = false;
        } else if (rc === '/' && !inCharClass) {
          i++;
          while (i < len && /[a-z]/i.test(text[i]!)) {
            i++;
          }
          break;
        } else if (rc === '\n') {
          break;
        }
        i++;
      }
      prevNonTrivia = 'regex';
      pendingSqlComment = false;
      continue;
    }

    if (ch === "'" || ch === '"') {
      const startOffset = i;
      const endOffset = skipJsString(text, i, ch);
      const isDriverQueryCall =
        prevNonTrivia === '(' &&
        TS_DRIVER_CALL_METHODS.has(prevCallIdentifier.toLowerCase());
      const hasExplicitContext = pendingSqlComment || isDriverQueryCall;

      if (hasExplicitContext) {
        const rawInner = text.slice(startOffset + 1, Math.max(startOffset + 1, endOffset - 1));
        pushBlockIfValid(
          blocks,
          lineOffsets,
          unescapeStandardString(rawInner),
          startOffset,
          endOffset,
          'ts-orm-call',
          true,
        );
      }

      i = endOffset;
      prevNonTrivia = 'string';
      pendingSqlComment = false;
      continue;
    }

    if (ch === '`') {
      const startOffset = i;
      const parsed = parseTemplateLiteral(text, startOffset);
      i = parsed.endOffset;

      const isTaggedSql = /(?:^|\.)sql$/i.test(prevNonTrivia);
      const isDriverQueryCall =
        prevNonTrivia === '(' &&
        TS_DRIVER_CALL_METHODS.has(prevCallIdentifier.toLowerCase());
      const hasExplicitContext =
        isTaggedSql || pendingSqlComment || isDriverQueryCall;

      pushBlockIfValid(
        blocks,
        lineOffsets,
        parsed.sql,
        startOffset,
        parsed.endOffset,
        isDriverQueryCall && !isTaggedSql ? 'ts-orm-call' : 'ts-tagged-template',
        hasExplicitContext,
      );

      prevNonTrivia = '`';
      pendingSqlComment = false;
      continue;
    }

    if (ch === '=' && next === '>') {
      prevNonTrivia = '=>';
      pendingSqlComment = false;
      i += 2;
      continue;
    }

    if (/[a-zA-Z_$]/.test(ch)) {
      const start = i;
      i++;
      while (i < len && /[a-zA-Z0-9_$.]/.test(text[i]!)) {
        i++;
      }
      const word = text.slice(start, i);
      const segments = word.split('.');
      prevCallIdentifier = segments[segments.length - 1] ?? '';
      prevNonTrivia = word;
      pendingSqlComment = false;
      continue;
    }

    prevNonTrivia = ch;
    if (ch !== '(') {
      pendingSqlComment = false;
    }
    i++;
  }

  return blocks;
}

function extractPythonSqlBlocks(
  text: string,
  lineOffsets: readonly number[],
): readonly DetectedSqlBlock[] {
  const blocks: DetectedSqlBlock[] = [];
  let i = 0;
  const len = text.length;

  let prevNonTrivia = '';
  let prevCallIdentifier = '';
  let pendingSqlComment = false;

  while (i < len) {
    const ch = text[i]!;

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    if (ch === '#') {
      const commentStart = i + 1;
      i++;
      while (i < len && text[i] !== '\n') {
        i++;
      }
      const commentText = text.slice(commentStart, i).trim().toLowerCase();
      if (commentText === 'sql') {
        pendingSqlComment = true;
      }
      continue;
    }

    // Optional string prefix: r, u, b, f, fr, rf, br, rb (case-insensitive)
    let prefix = '';
    let strStart = i;
    if (
      /[rfbu]/i.test(ch) &&
      (text[i + 1] === "'" ||
        text[i + 1] === '"' ||
        (/[rfbu]/i.test(text[i + 1] ?? '') &&
          (text[i + 2] === "'" || text[i + 2] === '"')))
    ) {
      if (text[i + 1] === "'" || text[i + 1] === '"') {
        prefix = ch.toLowerCase();
        strStart = i + 1;
      } else {
        prefix = text.slice(i, i + 2).toLowerCase();
        strStart = i + 2;
      }
    }

    const quoteChar = text[strStart];
    if (quoteChar === "'" || quoteChar === '"') {
      const isTriple =
        text[strStart + 1] === quoteChar && text[strStart + 2] === quoteChar;
      const delimLen = isTriple ? 3 : 1;
      const isRaw = prefix.includes('r');
      let cursor = strStart + delimLen;

      while (cursor < len) {
        if (!isRaw && text[cursor] === '\\') {
          cursor += 2;
          continue;
        }
        if (isTriple) {
          if (
            text[cursor] === quoteChar &&
            text[cursor + 1] === quoteChar &&
            text[cursor + 2] === quoteChar
          ) {
            cursor += 3;
            break;
          }
        } else if (text[cursor] === quoteChar || text[cursor] === '\n') {
          if (text[cursor] === quoteChar) {
            cursor++;
          }
          break;
        }
        cursor++;
      }

      const rawInner = text.slice(
        strStart + delimLen,
        Math.max(strStart + delimLen, cursor - delimLen),
      );
      const unescaped = isRaw ? rawInner : unescapeStandardString(rawInner);
      const normalized = normalizePythonPlaceholders(unescaped);

      const isDbCall =
        prevNonTrivia === '(' &&
        PYTHON_DB_CALL_METHODS.has(prevCallIdentifier.toLowerCase());
      const hasExplicitContext = pendingSqlComment || isDbCall;

      if (hasExplicitContext || isTriple) {
        pushBlockIfValid(
          blocks,
          lineOffsets,
          normalized,
          i,
          cursor,
          'python-sql',
          hasExplicitContext,
        );
      }

      i = cursor;
      prevNonTrivia = 'string';
      pendingSqlComment = false;
      continue;
    }

    if (/[a-zA-Z_]/.test(ch)) {
      const start = i;
      i++;
      while (i < len && /[a-zA-Z0-9_.]/.test(text[i]!)) {
        i++;
      }
      const word = text.slice(start, i);
      const segments = word.split('.');
      prevCallIdentifier = segments[segments.length - 1] ?? '';
      prevNonTrivia = word;
      pendingSqlComment = false;
      continue;
    }

    prevNonTrivia = ch;
    if (ch !== '(') {
      pendingSqlComment = false;
    }
    i++;
  }

  return blocks;
}

function extractGoSqlBlocks(
  text: string,
  lineOffsets: readonly number[],
): readonly DetectedSqlBlock[] {
  const blocks: DetectedSqlBlock[] = [];
  let i = 0;
  const len = text.length;

  let prevNonTrivia = '';
  let prevCallIdentifier = '';
  const callStack: string[] = [];
  let pendingSqlComment = false;

  const isInsideGoDbCall = (): boolean => {
    if (prevNonTrivia !== '(' && prevNonTrivia !== ',') {
      return false;
    }
    const activeCall = callStack[callStack.length - 1] ?? '';
    return GO_DB_CALL_METHODS.has(activeCall.toLowerCase());
  };

  while (i < len) {
    const ch = text[i]!;
    const next = text[i + 1];

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    if (ch === '/' && next === '/') {
      const commentStart = i + 2;
      i += 2;
      while (i < len && text[i] !== '\n') {
        i++;
      }
      const commentText = text.slice(commentStart, i).trim().toLowerCase();
      if (commentText === 'sql') {
        pendingSqlComment = true;
      }
      continue;
    }

    if (ch === '/' && next === '*') {
      const commentStart = i + 2;
      i += 2;
      while (i < len && !(text[i] === '*' && text[i + 1] === '/')) {
        i++;
      }
      const commentText = text.slice(commentStart, i).trim().toLowerCase();
      i = Math.min(len, i + 2);
      pendingSqlComment = commentText === 'sql';
      continue;
    }

    // Rune literal '...'
    if (ch === "'") {
      i = skipJsString(text, i, "'");
      prevNonTrivia = 'rune';
      pendingSqlComment = false;
      continue;
    }

    // Interpreted Go string "..."
    if (ch === '"') {
      const startOffset = i;
      const endOffset = skipJsString(text, i, '"');
      const hasExplicitContext = pendingSqlComment || isInsideGoDbCall();

      const rawInner = text.slice(
        startOffset + 1,
        Math.max(startOffset + 1, endOffset - 1),
      );
      pushBlockIfValid(
        blocks,
        lineOffsets,
        unescapeStandardString(rawInner),
        startOffset,
        endOffset,
        'go-sql',
        hasExplicitContext,
      );

      i = endOffset;
      prevNonTrivia = 'string';
      pendingSqlComment = false;
      continue;
    }

    // Raw Go string `...`
    if (ch === '`') {
      const startOffset = i;
      const closeIdx = text.indexOf('`', i + 1);
      const endOffset = closeIdx === -1 ? len : closeIdx + 1;
      const rawInner = text.slice(
        startOffset + 1,
        closeIdx === -1 ? len : closeIdx,
      );

      const hasExplicitContext = pendingSqlComment || isInsideGoDbCall();

      pushBlockIfValid(
        blocks,
        lineOffsets,
        rawInner,
        startOffset,
        endOffset,
        'go-sql',
        hasExplicitContext,
      );

      i = endOffset;
      prevNonTrivia = '`';
      pendingSqlComment = false;
      continue;
    }

    if (ch === '(') {
      callStack.push(prevCallIdentifier);
      prevCallIdentifier = '';
      prevNonTrivia = '(';
      i++;
      continue;
    }

    if (ch === ')') {
      callStack.pop();
      prevCallIdentifier = '';
      prevNonTrivia = ')';
      pendingSqlComment = false;
      i++;
      continue;
    }

    if (/[a-zA-Z_]/.test(ch)) {
      const start = i;
      i++;
      while (i < len && /[a-zA-Z0-9_.]/.test(text[i]!)) {
        i++;
      }
      const word = text.slice(start, i);
      const segments = word.split('.');
      prevCallIdentifier = segments[segments.length - 1] ?? '';
      prevNonTrivia = word;
      pendingSqlComment = false;
      continue;
    }

    prevNonTrivia = ch;
    if (ch !== ',') {
      pendingSqlComment = false;
    }
    i++;
  }

  return blocks;
}

function normalizePhpPlaceholders(sql: string): string {
  let out = '';
  let i = 0;
  let nextIdx = 1;
  const namedMap = new Map<string, string>();

  while (i < sql.length) {
    const ch = sql[i]!;

    // Preserve SQL string literals verbatim
    if (ch === "'" || ch === '"') {
      const start = i;
      i++;
      while (i < sql.length) {
        if (sql[i] === '\\') {
          i += 2;
          continue;
        }
        if (sql[i] === ch) {
          if (sql[i + 1] === ch) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      out += sql.slice(start, i);
      continue;
    }

    // PDO named placeholder :param_name (avoid matching PostgreSQL ::type casts)
    if (ch === ':') {
      const prevChar = i > 0 ? sql[i - 1] : undefined;
      if (prevChar === ':' || sql[i + 1] === ':') {
        out += ch;
        i++;
        continue;
      }
      const namedMatch = /^:([a-zA-Z_][a-zA-Z0-9_]*)/.exec(sql.slice(i));
      if (namedMatch?.[1]) {
        const key = namedMatch[1];
        let placeholder = namedMap.get(key);
        if (!placeholder) {
          placeholder = `$${nextIdx++}`;
          namedMap.set(key, placeholder);
        }
        out += placeholder;
        i += namedMatch[0].length;
        continue;
      }
    }

    out += ch;
    i++;
  }

  return out;
}

function unescapePhpDoubleQuotedString(raw: string): {
  readonly value: string;
  readonly hasInterpolation: boolean;
} {
  let out = '';
  let hasInterpolation = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    const next = raw[i + 1];
    if (ch === '\\') {
      if (next === 'n') {
        out += '\n';
        i++;
        continue;
      }
      if (next === 'r') {
        out += '\r';
        i++;
        continue;
      }
      if (next === 't') {
        out += '\t';
        i++;
        continue;
      }
      if (next === '"' || next === '\\' || next === '$') {
        out += next;
        i++;
        continue;
      }
    }

    if (
      (ch === '$' && next !== undefined && (next === '{' || /[a-zA-Z_]/.test(next))) ||
      (ch === '{' && next === '$')
    ) {
      hasInterpolation = true;
    }

    out += ch;
  }

  return { value: out, hasInterpolation };
}

function unescapePhpSingleQuotedString(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    const next = raw[i + 1];
    if (ch === '\\' && (next === "'" || next === '\\')) {
      out += next;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

function hasPhpVariableInterpolation(raw: string): boolean {
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch === '\\') {
      i++;
      continue;
    }
    const next = raw[i + 1];
    if (
      (ch === '$' && next !== undefined && (next === '{' || /[a-zA-Z_]/.test(next))) ||
      (ch === '{' && next === '$')
    ) {
      return true;
    }
  }
  return false;
}

function extractPhpSqlBlocks(
  text: string,
  lineOffsets: readonly number[],
): readonly DetectedSqlBlock[] {
  const blocks: DetectedSqlBlock[] = [];
  let i = 0;
  const len = text.length;

  let prevNonTrivia = '';
  let prevCallIdentifier = '';
  const callStack: string[] = [];
  let pendingSqlComment = false;

  const isInsidePhpDbCall = (): boolean => {
    if (prevNonTrivia !== '(' && prevNonTrivia !== ',') {
      return false;
    }
    const activeCall = callStack[callStack.length - 1] ?? '';
    return PHP_DB_CALL_METHODS.has(activeCall.toLowerCase());
  };

  while (i < len) {
    const ch = text[i]!;
    const next = text[i + 1];

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // Line comment // ...
    if (ch === '/' && next === '/') {
      const commentStart = i + 2;
      i += 2;
      while (i < len && text[i] !== '\n') {
        i++;
      }
      const commentText = text.slice(commentStart, i).trim().toLowerCase();
      if (commentText === 'sql') {
        pendingSqlComment = true;
      }
      continue;
    }

    // Shell-style line comment # ... (also skips #[Attribute] lines cleanly)
    if (ch === '#') {
      const commentStart = i + 1;
      i++;
      while (i < len && text[i] !== '\n') {
        i++;
      }
      const commentText = text.slice(commentStart, i).trim().toLowerCase();
      if (commentText === 'sql') {
        pendingSqlComment = true;
      }
      continue;
    }

    // Block comment /* ... */
    if (ch === '/' && next === '*') {
      const commentStart = i + 2;
      i += 2;
      while (i < len && !(text[i] === '*' && text[i + 1] === '/')) {
        i++;
      }
      const commentText = text.slice(commentStart, i).trim().toLowerCase();
      i = Math.min(len, i + 2);
      pendingSqlComment = commentText === 'sql';
      continue;
    }

    // PHP 7.3+ Heredoc / Nowdoc: <<<SQL ... SQL or <<<'SQL' ... SQL
    if (ch === '<' && next === '<' && text[i + 2] === '<') {
      const opener =
        /^<<<[ \t]*(?:'([a-zA-Z_][a-zA-Z0-9_]*)'|"([a-zA-Z_][a-zA-Z0-9_]*)"|([a-zA-Z_][a-zA-Z0-9_]*))[ \t]*\r?\n/.exec(
          text.slice(i),
        );
      if (opener) {
        const isNowdoc = Boolean(opener[1]);
        const tag = opener[1] ?? opener[2] ?? opener[3]!;
        const bodyStart = i + opener[0].length;
        let lineCursor = bodyStart;
        let bodyEnd = len;
        let docEnd = len;

        while (lineCursor < len) {
          const lineEndIdx = text.indexOf('\n', lineCursor);
          const nextLineStart = lineEndIdx === -1 ? len : lineEndIdx + 1;
          const lineText = text.slice(
            lineCursor,
            lineEndIdx === -1 ? len : lineEndIdx,
          );
          const trimmedIndent = lineText.replace(/^[ \t]+/, '');
          if (trimmedIndent.startsWith(tag)) {
            const afterTag = trimmedIndent[tag.length];
            if (
              afterTag === undefined ||
              afterTag === '\r' ||
              afterTag === ';' ||
              afterTag === ',' ||
              afterTag === ')' ||
              afterTag === ']' ||
              afterTag === ' ' ||
              afterTag === '\t'
            ) {
              bodyEnd = lineCursor;
              const indentLen = lineText.length - trimmedIndent.length;
              docEnd = lineCursor + indentLen + tag.length;
              break;
            }
          }
          lineCursor = nextLineStart;
        }

        const rawInner = text.slice(bodyStart, bodyEnd);
        if (isNowdoc || !hasPhpVariableInterpolation(rawInner)) {
          const normalized = normalizePhpPlaceholders(rawInner);
          const hasExplicitContext =
            pendingSqlComment ||
            isInsidePhpDbCall() ||
            tag.toUpperCase() === 'SQL';
          pushBlockIfValid(
            blocks,
            lineOffsets,
            normalized,
            i,
            docEnd,
            'php-sql',
            hasExplicitContext,
          );
        }

        i = docEnd;
        prevNonTrivia = 'string';
        pendingSqlComment = false;
        continue;
      }
    }

    // Single-quoted PHP string '...'
    if (ch === "'") {
      const startOffset = i;
      const endOffset = skipJsString(text, i, "'");
      const rawInner = text.slice(
        startOffset + 1,
        Math.max(startOffset + 1, endOffset - 1),
      );
      const unescaped = unescapePhpSingleQuotedString(rawInner);
      const normalized = normalizePhpPlaceholders(unescaped);
      const hasExplicitContext = pendingSqlComment || isInsidePhpDbCall();

      pushBlockIfValid(
        blocks,
        lineOffsets,
        normalized,
        startOffset,
        endOffset,
        'php-sql',
        hasExplicitContext,
      );

      i = endOffset;
      prevNonTrivia = 'string';
      pendingSqlComment = false;
      continue;
    }

    // Double-quoted PHP string "..."
    if (ch === '"') {
      const startOffset = i;
      const endOffset = skipJsString(text, i, '"');
      const rawInner = text.slice(
        startOffset + 1,
        Math.max(startOffset + 1, endOffset - 1),
      );
      const { value, hasInterpolation } = unescapePhpDoubleQuotedString(rawInner);
      if (!hasInterpolation) {
        const normalized = normalizePhpPlaceholders(value);
        const hasExplicitContext = pendingSqlComment || isInsidePhpDbCall();
        pushBlockIfValid(
          blocks,
          lineOffsets,
          normalized,
          startOffset,
          endOffset,
          'php-sql',
          hasExplicitContext,
        );
      }

      i = endOffset;
      prevNonTrivia = 'string';
      pendingSqlComment = false;
      continue;
    }

    if (ch === '(') {
      callStack.push(prevCallIdentifier);
      prevCallIdentifier = '';
      prevNonTrivia = '(';
      i++;
      continue;
    }

    if (ch === ')') {
      callStack.pop();
      prevCallIdentifier = '';
      prevNonTrivia = ')';
      pendingSqlComment = false;
      i++;
      continue;
    }

    // Skip `->` and `::` method/static resolution operators cleanly
    if ((ch === '-' && next === '>') || (ch === ':' && next === ':')) {
      prevNonTrivia = ch + next;
      pendingSqlComment = false;
      i += 2;
      continue;
    }

    if (/[a-zA-Z_\\]/.test(ch)) {
      const start = i;
      i++;
      while (i < len && /[a-zA-Z0-9_\\]/.test(text[i]!)) {
        i++;
      }
      const word = text.slice(start, i);
      const segments = word.split('\\').filter(Boolean);
      prevCallIdentifier = segments[segments.length - 1] ?? '';
      prevNonTrivia = word;
      pendingSqlComment = false;
      continue;
    }

    prevNonTrivia = ch;
    if (ch !== ',') {
      pendingSqlComment = false;
    }
    i++;
  }

  return blocks;
}

function preserveNewlinesOnly(segment: string): string {
  let out = '';
  for (let idx = 0; idx < segment.length; idx++) {
    out += segment[idx] === '\n' ? '\n' : ' ';
  }
  return out;
}

function resolveDbtExpression(rawExpr: string): string {
  const trimmed = rawExpr.trim();
  if (/^config\s*\(/i.test(trimmed)) {
    return preserveNewlinesOnly(rawExpr);
  }

  const refMatch =
    /^ref\s*\(\s*(?:['"]([a-zA-Z0-9_.-]+)['"]\s*,\s*)?['"]([a-zA-Z0-9_.-]+)['"]\s*\)$/i.exec(
      trimmed,
    );
  if (refMatch) {
    const modelName = refMatch[2] ?? refMatch[1] ?? 'dbt_model';
    return modelName.replace(/[^a-zA-Z0-9_.]/g, '_');
  }

  const sourceMatch =
    /^source\s*\(\s*['"]([a-zA-Z0-9_.-]+)['"]\s*,\s*['"]([a-zA-Z0-9_.-]+)['"]\s*\)$/i.exec(
      trimmed,
    );
  if (sourceMatch?.[1] && sourceMatch[2]) {
    const schema = sourceMatch[1].replace(/[^a-zA-Z0-9_]/g, '_');
    const table = sourceMatch[2].replace(/[^a-zA-Z0-9_]/g, '_');
    return `${schema}.${table}`;
  }

  if (/^this$/i.test(trimmed)) {
    return 'dbt_this_model';
  }

  return 'dbt_expr';
}

export function containsDbtJinja(sql: string): boolean {
  return sql.includes('{{') || sql.includes('{%') || sql.includes('{#');
}

/**
 * Normalizes dbt Jinja tags (`{{ ref(...) }}`, `{{ source(...) }}`, `{{ config(...) }}`,
 * `{% if ... %}`, `{# ... #}`) outside SQL string literals and comments while preserving line count.
 */
export function normalizeDbtSqlTemplate(rawSql: string): string {
  if (!containsDbtJinja(rawSql)) {
    return rawSql;
  }

  let out = '';
  let i = 0;
  const len = rawSql.length;

  while (i < len) {
    const ch = rawSql[i]!;
    const next = rawSql[i + 1];

    if (ch === "'" || ch === '"' || ch === '`') {
      const endOffset = skipJsString(rawSql, i, ch);
      out += rawSql.slice(i, endOffset);
      i = endOffset;
      continue;
    }

    if (ch === '-' && next === '-') {
      const start = i;
      i += 2;
      while (i < len && rawSql[i] !== '\n') {
        i++;
      }
      out += rawSql.slice(start, i);
      continue;
    }

    if (ch === '/' && next === '*') {
      const start = i;
      i += 2;
      while (i < len && !(rawSql[i] === '*' && rawSql[i + 1] === '/')) {
        i++;
      }
      i = Math.min(len, i + 2);
      out += rawSql.slice(start, i);
      continue;
    }

    if (ch === '{' && (next === '#' || next === '%' || next === '{')) {
      const closeChar = next === '{' ? '}' : next;
      const closeIdx = rawSql.indexOf(`${closeChar}}`, i + 2);
      if (closeIdx !== -1) {
        const fullTag = rawSql.slice(i, closeIdx + 2);
        const inner = rawSql.slice(i + 2, closeIdx);
        i = closeIdx + 2;

        if (next === '#' || next === '%') {
          out += preserveNewlinesOnly(fullTag);
        } else {
          const cleanInner = inner.replace(/^-|-$/g, '');
          const resolved = resolveDbtExpression(cleanInner);
          const newlineCount = (fullTag.match(/\n/g) ?? []).length;
          out += resolved + '\n'.repeat(newlineCount);
        }
        continue;
      }
    }

    out += ch;
    i++;
  }

  return out;
}

function isJupyterNotebookSource(languageId: string, fileName?: string): boolean {
  const lowerLang = languageId.toLowerCase();
  if (lowerLang === 'jupyter' || lowerLang === 'ipynb') {
    return true;
  }
  return Boolean(fileName?.toLowerCase().endsWith('.ipynb'));
}

function findNotebookCellSourceLines(rawNotebookJson: string): readonly number[] {
  const lines: number[] = [];
  const regex = /"source"\s*:/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(rawNotebookJson)) !== null) {
    let line = 0;
    for (let idx = 0; idx < match.index; idx++) {
      if (rawNotebookJson[idx] === '\n') {
        line++;
      }
    }
    lines.push(line);
  }
  return lines;
}

function extractSqlSpansFromText(
  text: string,
  lineOffsets: readonly number[],
  lineDelta: number,
  sourceKind: SqlBlockSourceKind,
): readonly DetectedSqlBlock[] {
  const spans = extractSqlStatementSpans(text);
  const blocks: DetectedSqlBlock[] = [];
  for (const span of spans) {
    if (!isInspectableSql(span.sql)) {
      continue;
    }
    const startPos = offsetToPosition(lineOffsets, span.start);
    const endPos = offsetToPosition(lineOffsets, span.end);
    blocks.push({
      sql: span.sql,
      startLine: startPos.line + lineDelta,
      startColumn: startPos.column,
      endLine: endPos.line + lineDelta,
      endColumn: endPos.column,
      sourceKind,
    });
  }
  return blocks;
}

/**
 * Extracts inspectable SQL blocks from a Jupyter `.ipynb` JSON document, covering
 * `%%sql` / `%%duckdb` / `%sql` magic cells and Python cells (`duckdb.sql`, `pd.read_sql`, `psycopg`, `SQLAlchemy`).
 */
export function extractJupyterNotebookSqlBlocks(
  rawNotebookJson: string,
): readonly DetectedSqlBlock[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawNotebookJson);
  } catch {
    return [];
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as { cells?: unknown }).cells)
  ) {
    return [];
  }

  const cells = (parsed as { cells: unknown[] }).cells;
  const sourceAnchors = findNotebookCellSourceLines(rawNotebookJson);
  const blocks: DetectedSqlBlock[] = [];

  for (let cellIdx = 0; cellIdx < cells.length; cellIdx++) {
    const rawCell = cells[cellIdx];
    if (typeof rawCell !== 'object' || rawCell === null) {
      continue;
    }
    const cellRecord = rawCell as { cell_type?: unknown; source?: unknown };
    if (cellRecord.cell_type !== 'code') {
      continue;
    }

    const rawSource = cellRecord.source;
    const cellText = Array.isArray(rawSource)
      ? rawSource.filter((line): line is string => typeof line === 'string').join('')
      : typeof rawSource === 'string'
        ? rawSource
        : '';

    if (!cellText.trim()) {
      continue;
    }

    const anchorLine = sourceAnchors[cellIdx] ?? 0;
    const rawLines = cellText.split('\n');
    const firstNonEmptyIdx = rawLines.findIndex((line) => line.trim().length > 0);
    if (firstNonEmptyIdx === -1) {
      continue;
    }

    const firstLineTrimmed = rawLines[firstNonEmptyIdx]!.trim();

    if (/^%%(?:sql|duckdb|postgres|postgresql|sqlite|mysql)\b/i.test(firstLineTrimmed)) {
      const sqlLines = rawLines.map((line, idx) =>
        idx <= firstNonEmptyIdx ? '' : line,
      );
      const rawSqlBody = sqlLines.join('\n');
      const normalizedBody = containsDbtJinja(rawSqlBody)
        ? normalizeDbtSqlTemplate(rawSqlBody)
        : rawSqlBody;
      blocks.push(
        ...extractSqlSpansFromText(
          normalizedBody,
          computeLineOffsets(normalizedBody),
          anchorLine,
          'notebook-cell',
        ),
      );
      continue;
    }

    // Handle inline `%sql ...` / `%duckdb ...` line magics alongside standard Python cells
    const pythonSafeLines: string[] = [];
    for (let lineIdx = 0; lineIdx < rawLines.length; lineIdx++) {
      const line = rawLines[lineIdx]!;
      const inlineMagic = /^\s*%(?:sql|duckdb|postgres|postgresql|sqlite|mysql)\s+(.+)$/i.exec(
        line,
      );
      if (inlineMagic?.[1]) {
        const sqlLine = inlineMagic[1];
        if (isInspectableSql(sqlLine)) {
          blocks.push({
            sql: sqlLine.trim(),
            startLine: anchorLine + lineIdx,
            startColumn: 0,
            endLine: anchorLine + lineIdx,
            endColumn: sqlLine.trim().length,
            sourceKind: 'notebook-cell',
          });
        }
        pythonSafeLines.push('');
        continue;
      }

      if (/^\s*[%!]/.test(line)) {
        pythonSafeLines.push('');
        continue;
      }

      pythonSafeLines.push(line);
    }

    const sanitizedPython = pythonSafeLines.join('\n');
    const pyBlocks = extractPythonSqlBlocks(
      sanitizedPython,
      computeLineOffsets(sanitizedPython),
    );
    for (const pyBlock of pyBlocks) {
      blocks.push({
        ...pyBlock,
        startLine: pyBlock.startLine + anchorLine,
        endLine: pyBlock.endLine + anchorLine,
        sourceKind: 'notebook-cell',
      });
    }
  }

  return blocks;
}

function isSqlSource(languageId: string, fileName?: string): boolean {
  if (SQL_LANGUAGE_IDS.has(languageId)) {
    return true;
  }
  return Boolean(fileName?.toLowerCase().endsWith('.sql'));
}

function isTsOrJsSource(languageId: string, fileName?: string): boolean {
  if (TS_JS_LANGUAGE_IDS.has(languageId)) {
    return true;
  }
  return Boolean(fileName && /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/i.test(fileName));
}

function isPythonSource(languageId: string, fileName?: string): boolean {
  if (PYTHON_LANGUAGE_IDS.has(languageId)) {
    return true;
  }
  return Boolean(fileName && /\.pyw?$/i.test(fileName));
}

function isGoSource(languageId: string, fileName?: string): boolean {
  if (GO_LANGUAGE_IDS.has(languageId)) {
    return true;
  }
  return Boolean(fileName && /\.go$/i.test(fileName));
}

function isPhpSource(languageId: string, fileName?: string): boolean {
  if (PHP_LANGUAGE_IDS.has(languageId)) {
    return true;
  }
  return Boolean(fileName && /\.php$/i.test(fileName));
}

/**
 * Pure domain extractor detecting inspectable SQL blocks across `.sql` files (including dbt Jinja models),
 * Jupyter Notebooks (`.ipynb`), TypeScript/JavaScript ORMs (Prisma, Drizzle, TypeORM, Knex, pg/mysql2),
 * Python (`psycopg`, `sqlalchemy`, `sqlite3`, Django, `pandas.read_sql`, `duckdb.sql`),
 * Go (`database/sql`, `pgx`, `sqlx`, `GORM`), and PHP (`Laravel DB::select/statement`, `PDO::prepare`, `Doctrine DBAL`).
 */
export function extractSqlBlocks(
  text: string,
  languageId: string,
  fileName?: string,
): readonly DetectedSqlBlock[] {
  if (!text.trim()) {
    return [];
  }

  if (isJupyterNotebookSource(languageId, fileName)) {
    return extractJupyterNotebookSqlBlocks(text);
  }

  if (isSqlSource(languageId, fileName)) {
    const isDbt = containsDbtJinja(text);
    const preparedText = isDbt ? normalizeDbtSqlTemplate(text) : text;
    return extractSqlSpansFromText(
      preparedText,
      computeLineOffsets(preparedText),
      0,
      isDbt ? 'dbt-sql' : 'sql-file',
    );
  }

  const lineOffsets = computeLineOffsets(text);

  if (isTsOrJsSource(languageId, fileName)) {
    return extractTsTemplateBlocks(text, lineOffsets);
  }

  if (isPythonSource(languageId, fileName)) {
    return extractPythonSqlBlocks(text, lineOffsets);
  }

  if (isGoSource(languageId, fileName)) {
    return extractGoSqlBlocks(text, lineOffsets);
  }

  if (isPhpSource(languageId, fileName)) {
    return extractPhpSqlBlocks(text, lineOffsets);
  }

  return [];
}
