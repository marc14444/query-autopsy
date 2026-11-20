import type { DatabaseEngine } from '../models/databaseEngine.js';

export type SqlTokenSubkind =
  | 'string'
  | 'identifier'
  | 'word'
  | 'parameter'
  | 'punctuation';

export interface SqlToken {
  readonly kind: 'whitespace' | 'comment' | 'semicolon' | 'token';
  readonly subkind?: SqlTokenSubkind | undefined;
  readonly start: number;
  readonly end: number;
  readonly normalized: string;
  readonly paramIndex?: number | undefined;
}

/**
 * Single-pass SQL lexical tokenizer parameterized by engine dialect:
 * - recognizes line comments (-- and MySQL #) and block comments (/* ... *\/)
 * - preserves single-quoted, double-quoted, backtick-quoted, bracketed, and PG dollar-quoted tokens
 * - identifies top-level semicolons and positional parameters ($1..$N, ?, ?N)
 */
export function tokenizeSql(
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
        subkind: 'punctuation',
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
      tokens.push({
        kind: 'token',
        subkind: 'string',
        start,
        end: i,
        normalized: literal,
      });
      continue;
    }

    // Double-quoted identifier (or MySQL double-quoted string when ANSI_QUOTES disabled)
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
      tokens.push({
        kind: 'token',
        subkind: engine === 'mysql' ? 'string' : 'identifier',
        start,
        end: i,
        normalized: ident,
      });
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
      tokens.push({
        kind: 'token',
        subkind: 'identifier',
        start,
        end: i,
        normalized: ident,
      });
      continue;
    }

    // SQLite [bracket] identifier
    if (ch === '[' && engine === 'sqlite') {
      const closeIdx = rawSql.indexOf(']', i + 1);
      if (closeIdx !== -1) {
        const ident = rawSql.slice(i, closeIdx + 1);
        tokens.push({
          kind: 'token',
          subkind: 'identifier',
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
            subkind: 'parameter',
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
        subkind: 'parameter',
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
          subkind: 'parameter',
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
          tokens.push({
            kind: 'token',
            subkind: 'string',
            start: i,
            end,
            normalized: literal,
          });
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
        subkind: 'word',
        start,
        end: i,
        normalized: word,
      });
      continue;
    }

    // Punctuation / operator / number
    tokens.push({
      kind: 'token',
      subkind: 'punctuation',
      start: i,
      end: i + 1,
      normalized: ch,
    });
    i++;
  }

  return tokens;
}
