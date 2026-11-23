import type { DatabaseEngine } from '../models/databaseEngine.js';
import type { DiagnosticSeverity } from '../models/diagnostic.js';
import { redactSqlLiterals } from './sqlSecurity.js';
import { type SqlToken, tokenizeSql } from './sqlTokenizer.js';

export interface QueryTraceEntry {
  readonly timestamp?: string | undefined;
  readonly engine?: DatabaseEngine | undefined;
  readonly sql: string;
  readonly bindings?: readonly unknown[] | undefined;
  readonly durationMs?: number | undefined;
  readonly requestId?: string | undefined;
  readonly file?: string | undefined;
  readonly line?: number | undefined;
}

export interface ParseQueryTraceOptions {
  readonly maxEntries?: number | undefined;
  readonly maxLineLength?: number | undefined;
  readonly defaultEngine?: DatabaseEngine | undefined;
}

export interface ParsedTraceStreamResult {
  readonly entries: readonly QueryTraceEntry[];
  readonly skippedLines: number;
  readonly truncated: boolean;
  readonly warnings: readonly string[];
}

export type TraceDiagnosticRuleId = 'N_PLUS_ONE_BURST' | 'SLOW_TRACE_QUERY';

export interface TraceDiagnosticFinding {
  readonly ruleId: TraceDiagnosticRuleId;
  readonly severity: DiagnosticSeverity;
  readonly fingerprint: string;
  readonly engine: DatabaseEngine;
  readonly requestId?: string | undefined;
  readonly affectedRequests: number;
  readonly repeatCount: number;
  readonly totalDurationMs: number;
  readonly meanDurationMs: number;
  readonly maxDurationMs: number;
  readonly file?: string | undefined;
  readonly line?: number | undefined;
  readonly sampleSql: string;
  readonly title: string;
  readonly detail: string;
  readonly recommendation: string;
}

export interface TraceQuerySummary {
  readonly fingerprint: string;
  readonly engine: DatabaseEngine;
  readonly executionCount: number;
  readonly distinctRequestCount: number;
  readonly maxBurstInSingleRequest: number;
  readonly totalDurationMs: number;
  readonly meanDurationMs: number;
  readonly maxDurationMs: number;
  readonly file?: string | undefined;
  readonly line?: number | undefined;
  readonly sampleSql: string;
}

export interface TraceAnalysisOptions {
  readonly defaultEngine?: DatabaseEngine | undefined;
  readonly nPlusOneWarningThreshold?: number | undefined;
  readonly nPlusOneCriticalThreshold?: number | undefined;
  readonly slowQueryMsThreshold?: number | undefined;
  readonly redact?: boolean | undefined;
  readonly maxFindings?: number | undefined;
  readonly topOffendersLimit?: number | undefined;
}

export interface QueryTraceAnalysisResult {
  readonly totalQueries: number;
  readonly totalDurationMs: number;
  readonly distinctFingerprints: number;
  readonly requestCount: number;
  readonly diagnostics: readonly TraceDiagnosticFinding[];
  readonly topOffenders: readonly TraceQuerySummary[];
}

export interface TraceExplainCandidate {
  readonly fingerprint: string;
  readonly engine: DatabaseEngine;
  readonly rawSql: string;
  readonly bindings?: readonly unknown[] | undefined;
  readonly file?: string | undefined;
  readonly line?: number | undefined;
  readonly severity: DiagnosticSeverity;
  readonly reason: string;
}

const SQL_KEYWORDS = new Set([
  'SELECT',
  'FROM',
  'WHERE',
  'AND',
  'OR',
  'NOT',
  'IN',
  'IS',
  'NULL',
  'TRUE',
  'FALSE',
  'AS',
  'ON',
  'USING',
  'JOIN',
  'INNER',
  'LEFT',
  'RIGHT',
  'FULL',
  'OUTER',
  'CROSS',
  'GROUP',
  'BY',
  'HAVING',
  'ORDER',
  'ASC',
  'DESC',
  'NULLS',
  'FIRST',
  'LAST',
  'LIMIT',
  'OFFSET',
  'FETCH',
  'NEXT',
  'ROWS',
  'ONLY',
  'UNION',
  'ALL',
  'INTERSECT',
  'EXCEPT',
  'DISTINCT',
  'WITH',
  'RECURSIVE',
  'INSERT',
  'INTO',
  'VALUES',
  'UPDATE',
  'SET',
  'DELETE',
  'MERGE',
  'WHEN',
  'MATCHED',
  'THEN',
  'ELSE',
  'END',
  'CASE',
  'RETURNING',
  'EXISTS',
  'BETWEEN',
  'LIKE',
  'ILIKE',
  'SIMILAR',
  'TO',
  'CAST',
  'OVER',
  'PARTITION',
  'WINDOW',
  'FOR',
  'SHARE',
  'CONFLICT',
  'DO',
  'NOTHING',
  'REPLACE',
  'ASCENDING',
  'DESCENDING',
]);

const SPACE_BEFORE_PAREN_KEYWORDS = new Set([
  'IN',
  'VALUES',
  'EXISTS',
  'AND',
  'OR',
  'NOT',
  'AS',
  'ON',
  'WHERE',
  'SELECT',
  'HAVING',
  'SET',
  'WHEN',
  'THEN',
  'ELSE',
  'CASE',
  'OVER',
]);

const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function sanitizeMetadataText(raw: unknown, maxLen: number): string | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  const cleaned = raw.replace(CONTROL_CHARS_RE, '').trim();
  if (!cleaned) {
    return undefined;
  }
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
}

function normalizeTraceEngine(raw: unknown): DatabaseEngine | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  const lower = raw.trim().toLowerCase();
  if (lower === 'pg' || lower === 'postgres' || lower === 'postgresql' || lower === 'pgsql') {
    return 'postgresql';
  }
  if (lower === 'mysql' || lower === 'mariadb') {
    return 'mysql';
  }
  if (lower === 'sqlite' || lower === 'sqlite3') {
    return 'sqlite';
  }
  if (lower === 'duckdb' || lower === 'duck') {
    return 'duckdb';
  }
  return undefined;
}

/**
 * Parses newline-delimited JSON (`.query-autopsy/traces.jsonl`) emitted by any language/ORM tracer.
 * Safely skips malformed lines, enforces strict entry & line caps, and avoids prototype pollution.
 */
export function parseQueryTraceStream(
  jsonlText: string,
  options?: ParseQueryTraceOptions,
): ParsedTraceStreamResult {
  const maxEntries = Math.max(1, Math.trunc(options?.maxEntries ?? 50_000));
  const maxLineLength = Math.max(256, Math.trunc(options?.maxLineLength ?? 65_536));
  const entries: QueryTraceEntry[] = [];
  const warnings: string[] = [];
  let skippedLines = 0;
  let truncated = false;

  const pushWarning = (msg: string): void => {
    if (warnings.length < 10) {
      warnings.push(msg);
    }
  };

  const lines = jsonlText.split(/\r?\n/);
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const rawLine = lines[lineIdx] ?? '';
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    if (entries.length >= maxEntries) {
      truncated = true;
      pushWarning(`Trace truncated at ${maxEntries} entries.`);
      break;
    }

    if (rawLine.length > maxLineLength) {
      skippedLines++;
      pushWarning(`Line ${lineIdx + 1} skipped: exceeds max length (${maxLineLength} chars).`);
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      skippedLines++;
      pushWarning(`Line ${lineIdx + 1} skipped: invalid JSON.`);
      continue;
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      skippedLines++;
      pushWarning(`Line ${lineIdx + 1} skipped: expected JSON object.`);
      continue;
    }

    const record = parsed as Record<string, unknown>;
    const rawSql = record['sql'];
    if (typeof rawSql !== 'string' || !rawSql.trim()) {
      skippedLines++;
      pushWarning(`Line ${lineIdx + 1} skipped: missing non-empty "sql" string.`);
      continue;
    }

    const engine = normalizeTraceEngine(record['engine']) ?? options?.defaultEngine;
    const timestamp = sanitizeMetadataText(record['timestamp'], 64);
    const requestId = sanitizeMetadataText(record['requestId'], 160);
    const file = sanitizeMetadataText(record['file'], 512);

    const rawDuration = record['durationMs'];
    const durationMs =
      typeof rawDuration === 'number' && Number.isFinite(rawDuration) && rawDuration >= 0
        ? rawDuration
        : undefined;

    const rawLineNum = record['line'];
    const lineNum =
      typeof rawLineNum === 'number' && Number.isFinite(rawLineNum) && rawLineNum >= 1
        ? Math.trunc(rawLineNum)
        : undefined;

    const rawBindings = record['bindings'];
    const bindings = Array.isArray(rawBindings)
      ? rawBindings.slice(0, 256)
      : undefined;

    entries.push({
      sql: rawSql.trim(),
      ...(timestamp !== undefined ? { timestamp } : {}),
      ...(engine !== undefined ? { engine } : {}),
      ...(bindings !== undefined ? { bindings } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(requestId !== undefined ? { requestId } : {}),
      ...(file !== undefined ? { file } : {}),
      ...(lineNum !== undefined ? { line: lineNum } : {}),
    });
  }

  return { entries, skippedLines, truncated, warnings };
}

interface CanonicalToken {
  readonly kind: 'keyword' | 'word' | 'identifier' | 'placeholder' | 'punct';
  readonly text: string;
  readonly adjacentToPrev: boolean;
}

function isDigitToken(tok: SqlToken | undefined): boolean {
  return (
    tok !== undefined &&
    tok.kind === 'token' &&
    tok.subkind === 'punctuation' &&
    /^[0-9]$/.test(tok.normalized)
  );
}

function collapseInClausePlaceholders(tokens: CanonicalToken[]): CanonicalToken[] {
  const out: CanonicalToken[] = [];
  let i = 0;

  while (i < tokens.length) {
    const tok = tokens[i]!;
    if (
      tok.kind === 'keyword' &&
      tok.text === 'IN' &&
      tokens[i + 1]?.kind === 'punct' &&
      tokens[i + 1]?.text === '('
    ) {
      let scan = i + 2;
      let placeholderCount = 0;
      let expectPlaceholder = true;
      let validInList = false;

      while (scan < tokens.length) {
        const inner = tokens[scan]!;
        if (inner.kind === 'punct' && inner.text === ')') {
          validInList = placeholderCount > 0 && !expectPlaceholder;
          break;
        }
        if (expectPlaceholder && inner.kind === 'placeholder') {
          placeholderCount++;
          expectPlaceholder = false;
          scan++;
          continue;
        }
        if (!expectPlaceholder && inner.kind === 'punct' && inner.text === ',') {
          expectPlaceholder = true;
          scan++;
          continue;
        }
        break;
      }

      if (validInList) {
        out.push(tok);
        out.push(tokens[i + 1]!);
        out.push({ kind: 'placeholder', text: '?', adjacentToPrev: false });
        out.push(tokens[scan]!);
        i = scan + 1;
        continue;
      }
    }

    out.push(tok);
    i++;
  }

  return out;
}

function readValuesTuple(
  tokens: readonly CanonicalToken[],
  openIdx: number,
): { readonly endIdx: number; readonly key: string } | undefined {
  if (tokens[openIdx]?.kind !== 'punct' || tokens[openIdx]?.text !== '(') {
    return undefined;
  }
  let depth = 1;
  let i = openIdx + 1;
  const parts: string[] = [];

  while (i < tokens.length && depth > 0) {
    const cur = tokens[i]!;
    if (cur.kind === 'punct' && cur.text === '(') {
      depth++;
    } else if (cur.kind === 'punct' && cur.text === ')') {
      depth--;
      if (depth === 0) {
        return { endIdx: i, key: parts.join('\u0000') };
      }
    }
    parts.push(`${cur.kind}:${cur.text}`);
    i++;
  }
  return undefined;
}

function collapseMultiRowValues(tokens: CanonicalToken[]): CanonicalToken[] {
  const out: CanonicalToken[] = [];
  let i = 0;

  while (i < tokens.length) {
    const tok = tokens[i]!;
    out.push(tok);

    if (tok.kind === 'keyword' && tok.text === 'VALUES') {
      const firstTuple = readValuesTuple(tokens, i + 1);
      if (firstTuple) {
        for (let t = i + 1; t <= firstTuple.endIdx; t++) {
          out.push(tokens[t]!);
        }
        let cursor = firstTuple.endIdx + 1;
        while (tokens[cursor]?.kind === 'punct' && tokens[cursor]?.text === ',') {
          const nextTuple = readValuesTuple(tokens, cursor + 1);
          if (!nextTuple || nextTuple.key !== firstTuple.key) {
            break;
          }
          cursor = nextTuple.endIdx + 1;
        }
        i = cursor;
        continue;
      }
    }
    i++;
  }

  return out;
}

/**
 * Computes a structural canonical SQL fingerprint suitable for grouping dynamic ORM traces:
 * - strips SQL comments and trailing semicolons
 * - normalizes quoted strings, numbers, positional `$N`/`?`, and `:named` parameters to `?`
 * - uppercases SQL keywords and lowercases unquoted identifiers
 * - collapses variable-length `IN (?, ?, ...)` lists to `IN (?)` and repeated `VALUES (...), (...)`
 */
export function computeTraceQueryFingerprint(
  rawSql: string,
  engine: DatabaseEngine = 'postgresql',
): string {
  const rawTokens = tokenizeSql(rawSql, engine);
  const significant = rawTokens.filter(
    (t) => t.kind === 'token',
  );

  if (significant.length === 0) {
    return '';
  }

  const canonical: CanonicalToken[] = [];
  let idx = 0;
  let lastRawEnd = -1;

  while (idx < significant.length) {
    const tok = significant[idx]!;
    const adjacentToPrev = lastRawEnd !== -1 && tok.start === lastRawEnd;

    // 1. Numeric literals (integers & decimals)
    if (isDigitToken(tok)) {
      let endIdx = idx;
      let endOffset = tok.end;
      while (
        endIdx + 1 < significant.length &&
        significant[endIdx + 1]!.start === endOffset &&
        isDigitToken(significant[endIdx + 1])
      ) {
        endIdx++;
        endOffset = significant[endIdx]!.end;
      }

      if (
        endIdx + 2 < significant.length &&
        significant[endIdx + 1]!.start === endOffset &&
        significant[endIdx + 1]!.normalized === '.' &&
        significant[endIdx + 2]!.start === significant[endIdx + 1]!.end &&
        isDigitToken(significant[endIdx + 2])
      ) {
        endIdx += 2;
        endOffset = significant[endIdx]!.end;
        while (
          endIdx + 1 < significant.length &&
          significant[endIdx + 1]!.start === endOffset &&
          isDigitToken(significant[endIdx + 1])
        ) {
          endIdx++;
          endOffset = significant[endIdx]!.end;
        }
      }

      canonical.push({ kind: 'placeholder', text: '?', adjacentToPrev });
      lastRawEnd = endOffset;
      idx = endIdx + 1;
      continue;
    }

    // 2. PDO / SQLAlchemy named parameter `:param` (skip `::cast`)
    if (
      tok.subkind === 'punctuation' &&
      tok.normalized === ':' &&
      significant[idx + 1]?.start === tok.end &&
      significant[idx + 1]?.subkind === 'word' &&
      !(
        adjacentToPrev &&
        significant[idx - 1]?.subkind === 'punctuation' &&
        significant[idx - 1]?.normalized === ':'
      )
    ) {
      canonical.push({ kind: 'placeholder', text: '?', adjacentToPrev });
      lastRawEnd = significant[idx + 1]!.end;
      idx += 2;
      continue;
    }

    // 3. String literals and positional parameter placeholders ($1, ?, ?1)
    const isStandaloneQuestionPlaceholder =
      tok.subkind === 'punctuation' &&
      tok.normalized === '?' &&
      !(adjacentToPrev && significant[idx - 1]?.normalized === '?') &&
      !(
        significant[idx + 1]?.start === tok.end &&
        (significant[idx + 1]?.normalized === '?' ||
          significant[idx + 1]?.normalized === '|' ||
          significant[idx + 1]?.normalized === '&')
      );

    if (
      tok.subkind === 'string' ||
      tok.subkind === 'parameter' ||
      isStandaloneQuestionPlaceholder
    ) {
      canonical.push({ kind: 'placeholder', text: '?', adjacentToPrev });
      lastRawEnd = tok.end;
      idx++;
      continue;
    }

    // 4. Quoted identifiers stay exact
    if (tok.subkind === 'identifier') {
      canonical.push({ kind: 'identifier', text: tok.normalized, adjacentToPrev });
      lastRawEnd = tok.end;
      idx++;
      continue;
    }

    // 5. Words & SQL keywords
    if (tok.subkind === 'word') {
      const upper = tok.normalized.toUpperCase();
      if (SQL_KEYWORDS.has(upper)) {
        canonical.push({ kind: 'keyword', text: upper, adjacentToPrev });
      } else {
        canonical.push({
          kind: 'word',
          text: tok.normalized.toLowerCase(),
          adjacentToPrev,
        });
      }
      lastRawEnd = tok.end;
      idx++;
      continue;
    }

    // 6. Other punctuation / operators
    canonical.push({ kind: 'punct', text: tok.normalized, adjacentToPrev });
    lastRawEnd = tok.end;
    idx++;
  }

  const collapsed = collapseMultiRowValues(
    collapseInClausePlaceholders(canonical),
  );

  let out = '';
  let prev: CanonicalToken | undefined;
  for (const cur of collapsed) {
    if (!prev) {
      out += cur.text;
      prev = cur;
      continue;
    }

    const noSpace =
      cur.text === ',' ||
      cur.text === ')' ||
      cur.text === '.' ||
      prev.text === '(' ||
      prev.text === '.' ||
      (cur.text === '(' &&
        prev.kind !== 'punct' &&
        prev.kind !== 'placeholder' &&
        !(prev.kind === 'keyword' && SPACE_BEFORE_PAREN_KEYWORDS.has(prev.text))) ||
      (cur.adjacentToPrev &&
        ((prev.kind === 'punct' &&
          cur.kind === 'punct' &&
          prev.text !== ',' &&
          prev.text !== ')' &&
          prev.text !== '(') ||
          (cur.text === ':' &&
            (prev.kind === 'word' || prev.kind === 'identifier')) ||
          (prev.text === ':' && (cur.kind === 'word' || cur.kind === 'keyword'))));

    out += noSpace ? cur.text : ` ${cur.text}`;
    prev = cur;
  }

  return out;
}

interface GlobalGroupBucket {
  readonly fingerprint: string;
  readonly engine: DatabaseEngine;
  readonly sampleSql: string;
  readonly file?: string | undefined;
  readonly line?: number | undefined;
  executionCount: number;
  totalDurationMs: number;
  maxDurationMs: number;
  readonly requestIds: Set<string>;
  maxBurstInSingleRequest: number;
  worstRequestId?: string | undefined;
  burstRequestsCount: number;
}

interface RequestBurstBucket {
  readonly requestId: string;
  readonly groupKey: string;
  count: number;
  totalDurationMs: number;
  maxDurationMs: number;
  readonly file?: string | undefined;
  readonly line?: number | undefined;
}

function roundMs(value: number): number {
  return Number(value.toFixed(3));
}

const SEVERITY_WEIGHT: Record<DiagnosticSeverity, number> = {
  critical: 3,
  warning: 2,
  info: 1,
};

/**
 * Analyzes parsed execution traces across request windows to surface N+1 bursts
 * (`N_PLUS_ONE_BURST`) and slow-query latency outliers (`SLOW_TRACE_QUERY`).
 */
export function analyzeQueryTraces(
  entries: readonly QueryTraceEntry[],
  options?: TraceAnalysisOptions,
): QueryTraceAnalysisResult {
  const defaultEngine = options?.defaultEngine ?? 'postgresql';
  const nPlusOneWarning = Math.max(2, Math.trunc(options?.nPlusOneWarningThreshold ?? 3));
  const nPlusOneCritical = Math.max(
    nPlusOneWarning,
    Math.trunc(options?.nPlusOneCriticalThreshold ?? 10),
  );
  const slowMsThreshold = Math.max(1, options?.slowQueryMsThreshold ?? 200);
  const redact = options?.redact ?? true;
  const maxFindings = Math.max(1, Math.trunc(options?.maxFindings ?? 100));
  const topOffendersLimit = Math.max(1, Math.trunc(options?.topOffendersLimit ?? 25));

  const groups = new Map<string, GlobalGroupBucket>();
  const requestBursts = new Map<string, RequestBurstBucket>();
  const distinctRequests = new Set<string>();

  let totalQueries = 0;
  let totalDurationMs = 0;

  for (const entry of entries) {
    const engine = entry.engine ?? defaultEngine;
    const fingerprint = computeTraceQueryFingerprint(entry.sql, engine);
    if (!fingerprint) {
      continue;
    }

    totalQueries++;
    const duration = entry.durationMs ?? 0;
    totalDurationMs += duration;

    const groupKey = `${engine}\u0000${fingerprint}`;
    let group = groups.get(groupKey);
    if (!group) {
      const sampleSql = redact
        ? redactSqlLiterals(entry.sql, engine, { stripComments: true })
        : entry.sql;
      group = {
        fingerprint,
        engine,
        sampleSql,
        file: entry.file,
        line: entry.line,
        executionCount: 0,
        totalDurationMs: 0,
        maxDurationMs: 0,
        requestIds: new Set<string>(),
        maxBurstInSingleRequest: 0,
        burstRequestsCount: 0,
      };
      groups.set(groupKey, group);
    }

    group.executionCount++;
    group.totalDurationMs += duration;
    if (duration > group.maxDurationMs) {
      group.maxDurationMs = duration;
    }

    if (entry.requestId) {
      distinctRequests.add(entry.requestId);
      group.requestIds.add(entry.requestId);
      const reqGroupKey = `${entry.requestId}\u0000${groupKey}`;
      let burst = requestBursts.get(reqGroupKey);
      if (!burst) {
        burst = {
          requestId: entry.requestId,
          groupKey,
          count: 0,
          totalDurationMs: 0,
          maxDurationMs: 0,
          file: entry.file,
          line: entry.line,
        };
        requestBursts.set(reqGroupKey, burst);
      }
      burst.count++;
      burst.totalDurationMs += duration;
      if (duration > burst.maxDurationMs) {
        burst.maxDurationMs = duration;
      }
    }
  }

  // Fold worst per-request bursts into each global group
  const worstBurstDurationByGroup = new Map<
    string,
    { readonly requestId: string; readonly count: number; readonly totalMs: number; readonly maxMs: number; readonly file?: string | undefined; readonly line?: number | undefined }
  >();

  for (const burst of requestBursts.values()) {
    const group = groups.get(burst.groupKey);
    if (!group) {
      continue;
    }
    if (burst.count >= nPlusOneWarning) {
      group.burstRequestsCount++;
    }
    const existing = worstBurstDurationByGroup.get(burst.groupKey);
    if (
      !existing ||
      burst.count > existing.count ||
      (burst.count === existing.count && burst.totalDurationMs > existing.totalMs)
    ) {
      group.maxBurstInSingleRequest = burst.count;
      group.worstRequestId = burst.requestId;
      worstBurstDurationByGroup.set(burst.groupKey, {
        requestId: burst.requestId,
        count: burst.count,
        totalMs: burst.totalDurationMs,
        maxMs: burst.maxDurationMs,
        file: burst.file,
        line: burst.line,
      });
    }
  }

  const findings: TraceDiagnosticFinding[] = [];

  for (const [groupKey, group] of groups.entries()) {
    const worstBurst = worstBurstDurationByGroup.get(groupKey);
    if (worstBurst && worstBurst.count >= nPlusOneWarning) {
      const severity: DiagnosticSeverity =
        worstBurst.count >= nPlusOneCritical ? 'critical' : 'warning';
      const sourceFile = worstBurst.file ?? group.file;
      const sourceLine = worstBurst.line ?? group.line;
      const meanBurstMs = worstBurst.count > 0 ? worstBurst.totalMs / worstBurst.count : 0;

      findings.push({
        ruleId: 'N_PLUS_ONE_BURST',
        severity,
        fingerprint: group.fingerprint,
        engine: group.engine,
        requestId: worstBurst.requestId,
        affectedRequests: group.burstRequestsCount,
        repeatCount: worstBurst.count,
        totalDurationMs: roundMs(worstBurst.totalMs),
        meanDurationMs: roundMs(meanBurstMs),
        maxDurationMs: roundMs(worstBurst.maxMs),
        ...(sourceFile !== undefined ? { file: sourceFile } : {}),
        ...(sourceLine !== undefined ? { line: sourceLine } : {}),
        sampleSql: group.sampleSql,
        title: `N+1 Query Burst (${worstBurst.count}× identical queries in request "${worstBurst.requestId}")`,
        detail: `Query "${group.fingerprint}" executed ${worstBurst.count} times inside request "${worstBurst.requestId}" (${roundMs(worstBurst.totalMs)} ms cumulative)${group.burstRequestsCount > 1 ? ` across ${group.burstRequestsCount} triggering requests` : ''}.`,
        recommendation:
          'Batch the lookup with JOIN / WHERE ... IN (...), ORM eager loading (e.g. Laravel with(), Prisma include, SQLAlchemy selectinload), or a request-scoped DataLoader, and verify an index supports the join/IN key.',
      });
    }

    if (group.maxDurationMs >= slowMsThreshold) {
      const severity: DiagnosticSeverity =
        group.maxDurationMs >= slowMsThreshold * 5 ? 'critical' : 'warning';
      const meanMs =
        group.executionCount > 0 ? group.totalDurationMs / group.executionCount : 0;

      findings.push({
        ruleId: 'SLOW_TRACE_QUERY',
        severity,
        fingerprint: group.fingerprint,
        engine: group.engine,
        affectedRequests: group.requestIds.size,
        repeatCount: group.executionCount,
        totalDurationMs: roundMs(group.totalDurationMs),
        meanDurationMs: roundMs(meanMs),
        maxDurationMs: roundMs(group.maxDurationMs),
        ...(group.file !== undefined ? { file: group.file } : {}),
        ...(group.line !== undefined ? { line: group.line } : {}),
        sampleSql: group.sampleSql,
        title: `Slow Trace Query (max ${roundMs(group.maxDurationMs)} ms)`,
        detail: `Query "${group.fingerprint}" reached ${roundMs(group.maxDurationMs)} ms max (${roundMs(meanMs)} ms mean over ${group.executionCount} execution(s), threshold ${slowMsThreshold} ms).`,
        recommendation:
          'Inspect this query with EXPLAIN / --explain-top to check for Full Table / Seq Scans, high-cost sorts, or missing composite indexes.',
      });
    }
  }

  findings.sort((a, b) => {
    const sevDiff = SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity];
    if (sevDiff !== 0) {
      return sevDiff;
    }
    if (a.ruleId !== b.ruleId) {
      return a.ruleId === 'N_PLUS_ONE_BURST' ? -1 : 1;
    }
    const durDiff = b.totalDurationMs - a.totalDurationMs;
    if (durDiff !== 0) {
      return durDiff;
    }
    return b.repeatCount - a.repeatCount;
  });

  const allSummaries: TraceQuerySummary[] = Array.from(groups.values()).map((g) => ({
    fingerprint: g.fingerprint,
    engine: g.engine,
    executionCount: g.executionCount,
    distinctRequestCount: g.requestIds.size,
    maxBurstInSingleRequest: g.maxBurstInSingleRequest,
    totalDurationMs: roundMs(g.totalDurationMs),
    meanDurationMs: roundMs(
      g.executionCount > 0 ? g.totalDurationMs / g.executionCount : 0,
    ),
    maxDurationMs: roundMs(g.maxDurationMs),
    ...(g.file !== undefined ? { file: g.file } : {}),
    ...(g.line !== undefined ? { line: g.line } : {}),
    sampleSql: g.sampleSql,
  }));

  allSummaries.sort((a, b) => {
    const durDiff = b.totalDurationMs - a.totalDurationMs;
    if (durDiff !== 0) {
      return durDiff;
    }
    const burstDiff = b.maxBurstInSingleRequest - a.maxBurstInSingleRequest;
    if (burstDiff !== 0) {
      return burstDiff;
    }
    return b.executionCount - a.executionCount;
  });

  return {
    totalQueries,
    totalDurationMs: roundMs(totalDurationMs),
    distinctFingerprints: groups.size,
    requestCount: distinctRequests.size,
    diagnostics: findings.slice(0, maxFindings),
    topOffenders: allSummaries.slice(0, topOffendersLimit),
  };
}

/**
 * Matches analyzed diagnostic/top-offender fingerprints back to concrete trace entries
 * so CLI or MCP callers can run read-only `EXPLAIN` on top offenders cleanly.
 */
export function selectExplainCandidatesForTrace(
  entries: readonly QueryTraceEntry[],
  analysis: QueryTraceAnalysisResult,
  maxCandidates: number,
  defaultEngine: DatabaseEngine = 'postgresql',
): readonly TraceExplainCandidate[] {
  const cap = Math.max(0, Math.trunc(maxCandidates));
  if (cap === 0) {
    return [];
  }

  const representativeByKey = new Map<string, QueryTraceEntry>();
  for (const entry of entries) {
    const engine = entry.engine ?? defaultEngine;
    const fp = computeTraceQueryFingerprint(entry.sql, engine);
    if (!fp) {
      continue;
    }
    const key = `${engine}\u0000${fp}`;
    const existing = representativeByKey.get(key);
    if (!existing || (entry.durationMs ?? 0) > (existing.durationMs ?? 0)) {
      representativeByKey.set(key, entry);
    }
  }

  const candidates: TraceExplainCandidate[] = [];
  const seenKeys = new Set<string>();

  for (const finding of analysis.diagnostics) {
    if (candidates.length >= cap) {
      break;
    }
    const key = `${finding.engine}\u0000${finding.fingerprint}`;
    if (seenKeys.has(key)) {
      continue;
    }
    const rep = representativeByKey.get(key);
    if (!rep) {
      continue;
    }
    seenKeys.add(key);
    candidates.push({
      fingerprint: finding.fingerprint,
      engine: finding.engine,
      rawSql: rep.sql,
      ...(rep.bindings !== undefined ? { bindings: rep.bindings } : {}),
      ...(rep.file !== undefined ? { file: rep.file } : {}),
      ...(rep.line !== undefined ? { line: rep.line } : {}),
      severity: finding.severity,
      reason: finding.title,
    });
  }

  for (const summary of analysis.topOffenders) {
    if (candidates.length >= cap) {
      break;
    }
    const key = `${summary.engine}\u0000${summary.fingerprint}`;
    if (seenKeys.has(key)) {
      continue;
    }
    const rep = representativeByKey.get(key);
    if (!rep) {
      continue;
    }
    seenKeys.add(key);
    candidates.push({
      fingerprint: summary.fingerprint,
      engine: summary.engine,
      rawSql: rep.sql,
      ...(rep.bindings !== undefined ? { bindings: rep.bindings } : {}),
      ...(rep.file !== undefined ? { file: rep.file } : {}),
      ...(rep.line !== undefined ? { line: rep.line } : {}),
      severity: 'info',
      reason: `Top cumulative trace query (${summary.totalDurationMs} ms across ${summary.executionCount} executions)`,
    });
  }

  return candidates;
}

function escapeMdInline(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/**
 * Formats trace N+1 and slow-query analysis into GitHub-flavored Markdown.
 */
export function formatTraceAnalysisMarkdown(
  analysis: QueryTraceAnalysisResult,
  sourceLabel?: string,
): string {
  const lines: string[] = [];
  lines.push(
    sourceLabel
      ? `## QueryAutopsy Trace Report (${sourceLabel})`
      : '## QueryAutopsy Trace Report',
  );
  lines.push('');
  lines.push(
    `- **Total Queries:** ${analysis.totalQueries} | **Distinct Fingerprints:** ${analysis.distinctFingerprints} | **Requests:** ${analysis.requestCount} | **Total Traced Time:** ${analysis.totalDurationMs} ms`,
  );
  lines.push('');

  if (analysis.diagnostics.length === 0) {
    lines.push('No N+1 bursts or slow-query trace outliers detected.');
  } else {
    lines.push(`### Diagnostics (${analysis.diagnostics.length})`);
    lines.push('');
    for (const d of analysis.diagnostics) {
      const icon = d.severity === 'critical' ? 'CRITICAL' : d.severity === 'warning' ? 'WARNING' : 'INFO';
      const loc = d.file ? ` (${d.file}${d.line !== undefined ? `:${d.line}` : ''})` : '';
      lines.push(`- **[${icon}] ${d.ruleId}**${loc} — ${d.title}`);
      lines.push(`  - ${d.detail}`);
      lines.push(`  - SQL: \`${escapeMdInline(d.sampleSql)}\``);
      lines.push(`  - Recommendation: ${d.recommendation}`);
    }
  }

  if (analysis.topOffenders.length > 0) {
    lines.push('');
    lines.push('### Top Offenders');
    lines.push('');
    lines.push('| Calls | Max Burst | Total (ms) | Mean (ms) | Fingerprint |');
    lines.push('| ---: | ---: | ---: | ---: | :--- |');
    for (const row of analysis.topOffenders.slice(0, 10)) {
      lines.push(
        `| ${row.executionCount} | ${row.maxBurstInSingleRequest} | ${row.totalDurationMs} | ${row.meanDurationMs} | \`${escapeMdInline(row.fingerprint)}\` |`,
      );
    }
  }

  return lines.join('\n');
}
