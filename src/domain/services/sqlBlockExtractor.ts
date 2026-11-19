import {
  classifySqlStatement,
  extractSqlStatementSpans,
} from './sqlClassifier.js';

export type SqlBlockSourceKind = 'sql-file' | 'ts-tagged-template';

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

const SQL_LANGUAGE_IDS = new Set(['sql', 'postgres', 'pgsql', 'mssql']);
const TS_JS_LANGUAGE_IDS = new Set([
  'typescript',
  'javascript',
  'typescriptreact',
  'javascriptreact',
]);

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
  try {
    const classified = classifySqlStatement(candidateSql);
    return classified.kind === 'READ' || classified.kind === 'WRITE';
  } catch {
    return false;
  }
}

function looksLikeStandaloneSql(sql: string): boolean {
  const upper = sql.toUpperCase();
  if (/^\s*SELECT\b/.test(upper)) {
    // Require FROM plus an actual SQL structural clue so English text like
    // "Select an option from your settings" never triggers a false CodeLens.
    return (
      /\bFROM\b/.test(upper) &&
      (/(\*|,|\$[1-9][0-9]*|;|\n)/.test(sql) ||
        /\b(WHERE|JOIN|GROUP\s+BY|ORDER\s+BY|LIMIT|HAVING|UNION|INTERSECT|EXCEPT)\b/.test(
          upper,
        ))
    );
  }
  if (/^\s*WITH\b/.test(upper)) {
    return /\bAS\s*\(/.test(upper);
  }
  if (/^\s*INSERT\b/.test(upper)) {
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

    // Single-line comment
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

    // Block comment (detect /* sql */)
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

    // Regex literal heuristic
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
      i = skipJsString(text, i, ch);
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
        /^(query|execute|raw)$/i.test(prevCallIdentifier);
      const hasExplicitContext =
        isTaggedSql || pendingSqlComment || isDriverQueryCall;

      const trimmedSql = parsed.sql.trim();
      if (
        trimmedSql &&
        (hasExplicitContext || looksLikeStandaloneSql(trimmedSql)) &&
        isInspectableSql(trimmedSql)
      ) {
        const startPos = offsetToPosition(lineOffsets, startOffset);
        const endPos = offsetToPosition(lineOffsets, parsed.endOffset);
        blocks.push({
          sql: trimmedSql,
          startLine: startPos.line,
          startColumn: startPos.column,
          endLine: endPos.line,
          endColumn: endPos.column,
          sourceKind: 'ts-tagged-template',
        });
      }

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
  if (!fileName) {
    return false;
  }
  return /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/i.test(fileName);
}

/**
 * Pure domain extractor detecting inspectable SQL blocks inside `.sql` scripts
 * and TypeScript/JavaScript template literals (`sql\`...\``, `/* sql *\/ \`...\``, `.query(\`...\`)`).
 */
export function extractSqlBlocks(
  text: string,
  languageId: string,
  fileName?: string,
): readonly DetectedSqlBlock[] {
  if (!text.trim()) {
    return [];
  }

  const lineOffsets = computeLineOffsets(text);

  if (isSqlSource(languageId, fileName)) {
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
        startLine: startPos.line,
        startColumn: startPos.column,
        endLine: endPos.line,
        endColumn: endPos.column,
        sourceKind: 'sql-file',
      });
    }
    return blocks;
  }

  if (isTsOrJsSource(languageId, fileName)) {
    return extractTsTemplateBlocks(text, lineOffsets);
  }

  return [];
}
