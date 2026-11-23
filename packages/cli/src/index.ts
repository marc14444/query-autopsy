import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import {
  analyzeQueryTraces,
  assertSafeSqlConstructs,
  classifySqlStatement,
  containsDbtJinja,
  type DatabaseEngine,
  detectDatabaseEngineFromUri,
  type DiagnosticSeverity,
  DomainError,
  type ExplainMode,
  extractConnectionHost,
  extractSqlBlocks,
  extractSqlStatementSpans,
  formatMarkdownPrReport,
  formatTraceAnalysisMarkdown,
  type InspectionReport,
  InspectQueryService,
  isLoopbackHost,
  type LoggerPort,
  normalizeDbtSqlTemplate,
  parseQueryTraceStream,
  type ProfileEnvironment,
  QueryExecutionError,
  type QueryExecutorPort,
  type QueryTraceAnalysisResult,
  type ReportPresenterPort,
  type RuntimeSettings,
  sanitizeSqlError,
  selectExplainCandidatesForTrace,
  StaticConnectionConfig,
  type WorkloadProfile,
} from '@query-autopsy/core';
import { MultiEngineQueryExecutor } from '@query-autopsy/executors';

export type CliOutputFormat = 'markdown' | 'json' | 'sarif';
export type FailOnThreshold = 'none' | 'info' | 'warning' | 'critical';

export interface CliIo {
  readonly readStdin: () => Promise<string>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly env: Record<string, string | undefined>;
  readonly createExecutor?: (logger: LoggerPort) => QueryExecutorPort;
}

const SEVERITY_RANK: Record<DiagnosticSeverity, number> = {
  info: 1,
  warning: 2,
  critical: 3,
};

const THRESHOLD_RANK: Record<FailOnThreshold, number> = {
  none: 99,
  info: 1,
  warning: 2,
  critical: 3,
};

const EXT_TO_LANGUAGE_ID: Record<string, string> = {
  '.sql': 'sql',
  '.pgsql': 'pgsql',
  '.ipynb': 'jupyter',
  '.ts': 'typescript',
  '.tsx': 'typescriptreact',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascriptreact',
  '.py': 'python',
  '.go': 'go',
  '.php': 'php',
};

const SKIPPED_SCAN_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  'vendor',
  '.next',
]);

export function severityMeetsThreshold<
  T extends { readonly severity: DiagnosticSeverity },
>(findings: readonly T[], threshold: FailOnThreshold): boolean {
  if (threshold === 'none') {
    return false;
  }
  const minRank = THRESHOLD_RANK[threshold];
  return findings.some((f) => SEVERITY_RANK[f.severity] >= minRank);
}

export interface SarifSourceItem {
  readonly file?: string | undefined;
  readonly startLine?: number | undefined;
  readonly report: InspectionReport;
}

function toSarifLevel(
  severity: DiagnosticSeverity,
): 'error' | 'warning' | 'note' {
  switch (severity) {
    case 'critical':
      return 'error';
    case 'warning':
      return 'warning';
    case 'info':
      return 'note';
  }
}

function buildSarifEnvelope(
  rulesMap: Map<string, Record<string, unknown>>,
  results: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    $schema:
      'https://raw.githubusercontent.com/oasis-tcs/sarif-json/master/Schemata/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'QueryAutopsy',
            version: '1.8.3',
            informationUri: 'https://github.com/marc14444/query-autopsy',
            rules: Array.from(rulesMap.values()),
          },
        },
        results,
      },
    ],
  };
}

function appendPlanSarifResults(
  items: readonly SarifSourceItem[],
  rulesMap: Map<string, Record<string, unknown>>,
  results: Array<Record<string, unknown>>,
): void {
  for (const item of items) {
    for (const finding of item.report.diagnostics) {
      if (!rulesMap.has(finding.ruleId)) {
        rulesMap.set(finding.ruleId, {
          id: finding.ruleId,
          name: finding.ruleId,
          shortDescription: { text: finding.title },
          help: { text: finding.recommendation },
          defaultConfiguration: { level: toSarifLevel(finding.severity) },
        });
      }

      const uri = item.file ?? 'query.sql';
      const startLine = Math.max(1, (item.startLine ?? 0) + 1);

      results.push({
        ruleId: finding.ruleId,
        level: toSarifLevel(finding.severity),
        message: {
          text: finding.indexSuggestion
            ? `${finding.title} — ${finding.detail} Suggestion: ${finding.indexSuggestion.sql}`
            : `${finding.title} — ${finding.detail}`,
        },
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri },
              region: { startLine },
            },
          },
        ],
      });
    }
  }
}

export function formatSarifReports(
  items: readonly SarifSourceItem[],
): Record<string, unknown> {
  const rulesMap = new Map<string, Record<string, unknown>>();
  const results: Array<Record<string, unknown>> = [];
  appendPlanSarifResults(items, rulesMap, results);
  return buildSarifEnvelope(rulesMap, results);
}

function formatTraceSarifReport(
  analysis: QueryTraceAnalysisResult,
  explainedItems: readonly SarifSourceItem[],
  defaultTraceFile: string,
): Record<string, unknown> {
  const rulesMap = new Map<string, Record<string, unknown>>();
  const results: Array<Record<string, unknown>> = [];

  for (const finding of analysis.diagnostics) {
    if (!rulesMap.has(finding.ruleId)) {
      rulesMap.set(finding.ruleId, {
        id: finding.ruleId,
        name: finding.ruleId,
        shortDescription: { text: finding.ruleId },
        help: { text: finding.recommendation },
        defaultConfiguration: { level: toSarifLevel(finding.severity) },
      });
    }

    const uri = finding.file ?? defaultTraceFile;
    const startLine = Math.max(1, finding.line ?? 1);

    results.push({
      ruleId: finding.ruleId,
      level: toSarifLevel(finding.severity),
      message: {
        text: `${finding.title} — ${finding.detail} SQL: ${finding.sampleSql}`,
      },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri },
            region: { startLine },
          },
        },
      ],
    });
  }

  appendPlanSarifResults(explainedItems, rulesMap, results);
  return buildSarifEnvelope(rulesMap, results);
}

function createNoopPresenter(): ReportPresenterPort {
  return {
    present: async () => undefined,
  };
}

function createCliLogger(stderr: (text: string) => void, verbose: boolean): LoggerPort {
  return {
    info: (msg, ctx) => {
      if (verbose) {
        stderr(`[INFO] ${msg}${ctx ? ` ${JSON.stringify(ctx)}` : ''}\n`);
      }
    },
    warn: (msg, ctx) => {
      stderr(`[WARN] ${msg}${ctx ? ` ${JSON.stringify(ctx)}` : ''}\n`);
    },
    error: (msg, ctx) => {
      stderr(`[ERROR] ${msg}${ctx ? ` ${JSON.stringify(ctx)}` : ''}\n`);
    },
  };
}

export function resolveDefaultSqlJsWasmPath(): string | undefined {
  try {
    const req = createRequire(import.meta.url);
    return req.resolve('sql.js/dist/sql-wasm.wasm');
  } catch {
    return undefined;
  }
}

async function collectScannableFiles(targetPath: string): Promise<string[]> {
  const stat = await fs.stat(targetPath);
  if (stat.isFile()) {
    return [targetPath];
  }

  const results: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIPPED_SCAN_DIRS.has(entry.name)) {
          await walk(path.join(dir, entry.name));
        }
        continue;
      }
      if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (ext in EXT_TO_LANGUAGE_ID) {
          results.push(path.join(dir, entry.name));
        }
      }
    }
  };

  await walk(targetPath);
  return results.sort();
}

function getHelpText(): string {
  return [
    'QueryAutopsy CLI — Language-agnostic SQL EXPLAIN profiler, trace analyzer & CI gate',
    '',
    'Usage:',
    '  query-autopsy explain [--sql <query> | --file <path> | --stdin] [options]',
    '  query-autopsy ci [--file <path> | --dir <path> | --sql <query> | --stdin] [options]',
    '  query-autopsy check [--sql <query> | --file <path> | --dir <path> | --stdin] [options]',
    '  query-autopsy trace [--file <path> | --stdin] [options]',
    '',
    'Options:',
    '  --uri <dsn>               Database URI (fallback: QUERY_AUTOPSY_URI, DATABASE_URL)',
    '  --engine <pg|mysql|sqlite|duckdb> Explicit engine override',
    '  --mode <estimate|analyze> EXPLAIN mode (default: estimate)',
    '  --env <local|staging|production> Safety level (production enforces Read-Only lock)',
    '  --format <markdown|json|sarif> Output format (default: markdown, ci defaults to json)',
    '  --fail-on <none|info|warning|critical> Exit code 2 threshold (default: none on explain/trace, critical on ci)',
    '  --params <json>           Positional parameter array JSON (e.g. "[42, \\"pending\\"]")',
    '  --timeout <ms>            statement_timeout ms (default: 5000)',
    '  --threshold <rows>        Seq Scan row warning threshold (default: 1000)',
    '  --profile <auto|oltp|analytics> Diagnostic workload profile (default: auto)',
    '  --threshold-n1 <count>    N+1 identical-query burst threshold per requestId (default: 3)',
    '  --slow-ms <ms>            Slow trace query warning threshold in ms (default: 200)',
    '  --explain-top <N>         Run EXPLAIN on top N offending trace queries (requires --uri)',
    '  --redact                  Redact SQL string literals and sanitize error outputs',
    '  --allow-write-analyze     Allow ANALYZE on WRITE statements inside ROLLBACK transaction',
    '  --verbose                 Emit diagnostic progress logs to stderr',
    '  -h, --help                Show help',
    '  -v, --version             Show version',
  ].join('\n');
}

function normalizeEngineFlag(raw?: string): DatabaseEngine | undefined {
  if (!raw) {
    return undefined;
  }
  const lower = raw.trim().toLowerCase();
  if (lower === 'pg' || lower === 'postgres' || lower === 'postgresql') {
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
  throw new Error(
    `Unsupported --engine value "${raw}". Expected postgresql, mysql, sqlite, or duckdb.`,
  );
}

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const first = argv[0];
  if (!first || first === '-h' || first === '--help' || first === 'help') {
    io.stdout(`${getHelpText()}\n`);
    return 0;
  }
  if (first === '-v' || first === '--version') {
    io.stdout('1.8.3\n');
    return 0;
  }

  const command =
    first === 'explain' ||
    first === 'ci' ||
    first === 'check' ||
    first === 'trace'
      ? first
      : undefined;
  const flagArgs = command ? argv.slice(1) : [...argv];
  const resolvedCommand = command ?? 'explain';

  const { values } = parseArgs({
    args: flagArgs,
    options: {
      sql: { type: 'string' },
      file: { type: 'string' },
      dir: { type: 'string' },
      stdin: { type: 'boolean', default: false },
      uri: { type: 'string' },
      engine: { type: 'string' },
      mode: { type: 'string', default: 'estimate' },
      env: { type: 'string' },
      profile: { type: 'string' },
      format: { type: 'string' },
      'fail-on': { type: 'string' },
      params: { type: 'string' },
      timeout: { type: 'string', default: '5000' },
      threshold: { type: 'string', default: '1000' },
      'threshold-n1': { type: 'string', default: '3' },
      'slow-ms': { type: 'string', default: '200' },
      'explain-top': { type: 'string', default: '0' },
      redact: { type: 'boolean', default: false },
      'allow-write-analyze': { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    io.stdout(`${getHelpText()}\n`);
    return 0;
  }

  const redact = values.redact === true;
  const logger = createCliLogger(io.stderr, values.verbose === true);

  try {
    const engineOverride = normalizeEngineFlag(values.engine);
    const mode = values.mode as ExplainMode;
    if (mode !== 'estimate' && mode !== 'analyze') {
      throw new Error(`Invalid --mode "${values.mode}". Expected estimate or analyze.`);
    }

    const format = (values.format ??
      (resolvedCommand === 'ci' ? 'json' : 'markdown')) as CliOutputFormat;
    if (format !== 'markdown' && format !== 'json' && format !== 'sarif') {
      throw new Error(
        `Invalid --format "${values.format}". Expected markdown, json, or sarif.`,
      );
    }

    const failOn = (values['fail-on'] ??
      (resolvedCommand === 'ci' ? 'critical' : 'none')) as FailOnThreshold;
    if (!(failOn in THRESHOLD_RANK)) {
      throw new Error(
        `Invalid --fail-on "${failOn}". Expected none, info, warning, or critical.`,
      );
    }

    const envArg = values.env as ProfileEnvironment | undefined;
    if (
      envArg !== undefined &&
      envArg !== 'local' &&
      envArg !== 'staging' &&
      envArg !== 'production'
    ) {
      throw new Error(
        `Invalid --env "${values.env}". Expected local, staging, or production.`,
      );
    }

    const workloadProfile = (values.profile ?? 'auto') as WorkloadProfile;
    if (
      workloadProfile !== 'auto' &&
      workloadProfile !== 'oltp' &&
      workloadProfile !== 'analytics'
    ) {
      throw new Error(
        `Invalid --profile "${values.profile}". Expected auto, oltp, or analytics.`,
      );
    }

    const parsedParams: readonly unknown[] | undefined = values.params
      ? (() => {
          const parsed: unknown = JSON.parse(values.params);
          if (!Array.isArray(parsed)) {
            throw new Error('--params must be a JSON array.');
          }
          return parsed;
        })()
      : undefined;

    if (resolvedCommand === 'check') {
      return await runOfflineCheck(
        {
          sql: values.sql,
          file: values.file,
          dir: values.dir,
          stdin: values.stdin === true,
          engine: engineOverride ?? 'postgresql',
          format,
        },
        io,
      );
    }

    const dsn =
      values.uri ?? io.env['QUERY_AUTOPSY_URI'] ?? io.env['DATABASE_URL'];
    const runtimeSettings: RuntimeSettings = {
      statementTimeoutMs: Math.max(100, Number(values.timeout) || 5000),
      allowWriteAnalyze: values['allow-write-analyze'] === true,
      seqScanRowThreshold: Math.max(10, Number(values.threshold) || 1000),
      showRawJson: false,
      redactLiteralsInReports: redact,
      workloadProfile,
    };

    if (resolvedCommand === 'trace') {
      return await runTraceCommand(
        {
          file: values.file,
          stdin: values.stdin === true,
          dsn,
          engineOverride,
          mode,
          envArg,
          format,
          failOn,
          thresholdN1: Math.max(2, Number(values['threshold-n1']) || 3),
          slowMs: Math.max(1, Number(values['slow-ms']) || 200),
          explainTop: Math.max(
            0,
            Math.min(25, Math.trunc(Number(values['explain-top']) || 0)),
          ),
          runtimeSettings,
          redact,
          logger,
        },
        io,
      );
    }

    if (!dsn) {
      throw new Error(
        'Missing database connection URI. Pass --uri <dsn> or set QUERY_AUTOPSY_URI / DATABASE_URL.',
      );
    }

    const { resolvedEngine, executor, inspectService } = createCliInspectContext({
      dsn,
      engineOverride,
      envArg,
      runtimeSettings,
      logger,
      io,
    });

    try {
      if (resolvedCommand === 'explain') {
        const rawSql = await readSingleSqlInput(
          values.sql,
          values.file,
          values.stdin === true,
          io,
        );
        const report = await inspectService.execute({
          rawSql,
          mode,
          parameters: parsedParams,
        });

        emitFormattedReports([{ report, file: values.file }], format, io);
        return severityMeetsThreshold(report.diagnostics, failOn) ? 2 : 0;
      }

      // `ci` mode: scan file / directory / stdin / inline SQL
      const queries = await collectQueriesForCi(
        {
          sql: values.sql,
          file: values.file,
          dir: values.dir,
          stdin: values.stdin === true,
        },
        io,
      );

      if (queries.length === 0) {
        if (format === 'json') {
          io.stdout(`${JSON.stringify({ reports: [], skippedParameterized: 0 }, null, 2)}\n`);
        } else if (format === 'sarif') {
          io.stdout(`${JSON.stringify(formatSarifReports([]), null, 2)}\n`);
        } else {
          io.stdout('No inspectable SQL queries found.\n');
        }
        return 0;
      }

      const collected: SarifSourceItem[] = [];
      let skippedParameterized = 0;

      for (const item of queries) {
        const classified = classifySqlStatement(item.sql, resolvedEngine);
        if (classified.parameterIndices.length > 0 && !parsedParams) {
          skippedParameterized++;
          continue;
        }
        const report = await inspectService.execute({
          rawSql: item.sql,
          mode,
          parameters: parsedParams,
        });
        collected.push({
          file: item.file,
          startLine: item.startLine,
          report,
        });
      }

      emitFormattedReports(collected, format, io, skippedParameterized);

      const allFindings = collected.flatMap((c) => c.report.diagnostics);
      return severityMeetsThreshold(allFindings, failOn) ? 2 : 0;
    } finally {
      await executor.dispose();
    }
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    const sqlState =
      err instanceof QueryExecutionError ? err.sqlState : undefined;
    const message =
      redact && err instanceof DomainError
        ? sanitizeSqlError(rawMsg, sqlState)
        : rawMsg;
    io.stderr(`QueryAutopsy Error: ${message}\n`);
    return 1;
  }
}

function createCliInspectContext(opts: {
  readonly dsn: string;
  readonly engineOverride?: DatabaseEngine | undefined;
  readonly envArg?: ProfileEnvironment | undefined;
  readonly runtimeSettings: RuntimeSettings;
  readonly logger: LoggerPort;
  readonly io: CliIo;
}): {
  readonly resolvedEngine: DatabaseEngine;
  readonly executor: QueryExecutorPort;
  readonly inspectService: InspectQueryService;
} {
  const resolvedEngine = opts.engineOverride ?? detectDatabaseEngineFromUri(opts.dsn);
  const resolvedHost = extractConnectionHost(opts.dsn, resolvedEngine);
  const resolvedEnv: ProfileEnvironment =
    opts.envArg ?? (resolvedHost && !isLoopbackHost(resolvedHost) ? 'staging' : 'local');

  const config = new StaticConnectionConfig({
    connectionString: opts.dsn,
    runtimeSettings: opts.runtimeSettings,
    environment: resolvedEnv,
    engine: resolvedEngine,
    profileId: 'cli-target',
  });
  const executor = opts.io.createExecutor
    ? opts.io.createExecutor(opts.logger)
    : new MultiEngineQueryExecutor(
        opts.logger,
        {
          wasmPath: resolveDefaultSqlJsWasmPath(),
        },
        {
          workspaceRoot: process.cwd(),
        },
      );

  const inspectService = new InspectQueryService({
    connectionConfig: config,
    queryExecutor: executor,
    reportPresenter: createNoopPresenter(),
    logger: opts.logger,
  });

  return { resolvedEngine, executor, inspectService };
}

async function runTraceCommand(
  opts: {
    readonly file?: string | undefined;
    readonly stdin: boolean;
    readonly dsn?: string | undefined;
    readonly engineOverride?: DatabaseEngine | undefined;
    readonly mode: ExplainMode;
    readonly envArg?: ProfileEnvironment | undefined;
    readonly format: CliOutputFormat;
    readonly failOn: FailOnThreshold;
    readonly thresholdN1: number;
    readonly slowMs: number;
    readonly explainTop: number;
    readonly runtimeSettings: RuntimeSettings;
    readonly redact: boolean;
    readonly logger: LoggerPort;
  },
  io: CliIo,
): Promise<number> {
  const sourceLabel = opts.stdin
    ? 'stdin.jsonl'
    : (opts.file ?? '.query-autopsy/traces.jsonl');
  const rawTrace = opts.stdin
    ? await io.readStdin()
    : await fs.readFile(sourceLabel, 'utf-8');

  const defaultEngine =
    opts.engineOverride ??
    (opts.dsn ? detectDatabaseEngineFromUri(opts.dsn) : 'postgresql');

  const parsed = parseQueryTraceStream(rawTrace, { defaultEngine });
  const analysis = analyzeQueryTraces(parsed.entries, {
    defaultEngine,
    nPlusOneWarningThreshold: opts.thresholdN1,
    nPlusOneCriticalThreshold: Math.max(opts.thresholdN1 + 1, 10),
    slowQueryMsThreshold: opts.slowMs,
    redact: opts.redact,
  });

  const explainedItems: SarifSourceItem[] = [];
  const explainNotes: Array<{ readonly fingerprint: string; readonly reason: string }> = [];

  if (opts.explainTop > 0) {
    if (!opts.dsn) {
      throw new Error(
        'Missing database connection URI for --explain-top. Pass --uri <dsn> or set QUERY_AUTOPSY_URI / DATABASE_URL.',
      );
    }

    const { resolvedEngine, executor, inspectService } = createCliInspectContext({
      dsn: opts.dsn,
      engineOverride: opts.engineOverride,
      envArg: opts.envArg,
      runtimeSettings: opts.runtimeSettings,
      logger: opts.logger,
      io,
    });

    try {
      const candidates = selectExplainCandidatesForTrace(
        parsed.entries,
        analysis,
        opts.explainTop,
        resolvedEngine,
      );

      for (const candidate of candidates) {
        try {
          const classified = classifySqlStatement(candidate.rawSql, resolvedEngine);
          if (
            classified.kind === 'DDL' ||
            classified.kind === 'EXPLAIN' ||
            classified.kind === 'UNKNOWN'
          ) {
            explainNotes.push({
              fingerprint: candidate.fingerprint,
              reason: `Skipped non-DML statement kind "${classified.kind}".`,
            });
            continue;
          }
          if (
            classified.kind === 'WRITE' &&
            opts.mode === 'analyze' &&
            !opts.runtimeSettings.allowWriteAnalyze
          ) {
            explainNotes.push({
              fingerprint: candidate.fingerprint,
              reason:
                'Skipped WRITE statement under EXPLAIN ANALYZE without --allow-write-analyze.',
            });
            continue;
          }

          const needsParams = classified.parameterIndices.length > 0;
          const params = needsParams ? candidate.bindings : undefined;
          if (needsParams && (!params || params.length === 0)) {
            explainNotes.push({
              fingerprint: candidate.fingerprint,
              reason: 'Skipped parameterized trace query without recorded bindings.',
            });
            continue;
          }

          const report = await inspectService.execute({
            rawSql: candidate.rawSql,
            mode: opts.mode,
            ...(params !== undefined ? { parameters: params } : {}),
          });

          explainedItems.push({
            ...(candidate.file ? { file: candidate.file } : {}),
            ...(candidate.line !== undefined
              ? { startLine: Math.max(0, candidate.line - 1) }
              : {}),
            report,
          });
        } catch (err) {
          const rawMsg = err instanceof Error ? err.message : String(err);
          const sqlState =
            err instanceof QueryExecutionError ? err.sqlState : undefined;
          explainNotes.push({
            fingerprint: candidate.fingerprint,
            reason: opts.redact ? sanitizeSqlError(rawMsg, sqlState) : rawMsg,
          });
        }
      }
    } finally {
      await executor.dispose();
    }
  }

  if (opts.format === 'sarif') {
    io.stdout(
      `${JSON.stringify(formatTraceSarifReport(analysis, explainedItems, sourceLabel), null, 2)}\n`,
    );
  } else if (opts.format === 'json') {
    io.stdout(
      `${JSON.stringify(
        {
          source: sourceLabel,
          skippedLines: parsed.skippedLines,
          truncated: parsed.truncated,
          warnings: parsed.warnings,
          analysis,
          ...(explainedItems.length > 0
            ? {
                explainedOffenders: explainedItems.map((item) => ({
                  ...(item.file ? { file: item.file } : {}),
                  ...(item.startLine !== undefined
                    ? { startLine: item.startLine + 1 }
                    : {}),
                  report: item.report,
                })),
              }
            : {}),
          ...(explainNotes.length > 0 ? { explainNotes } : {}),
        },
        null,
        2,
      )}\n`,
    );
  } else {
    io.stdout(`${formatTraceAnalysisMarkdown(analysis, sourceLabel)}\n`);
    if (parsed.skippedLines > 0) {
      io.stdout(`\n_Skipped ${parsed.skippedLines} malformed trace line(s)._\n`);
    }
    if (explainedItems.length > 0) {
      io.stdout('\n### Explained Top Offenders\n\n');
      emitFormattedReports(explainedItems, 'markdown', io);
    }
    if (explainNotes.length > 0) {
      io.stdout('\n### Explain Skipped / Errors\n\n');
      for (const note of explainNotes) {
        io.stdout(`- \`${note.fingerprint}\`: ${note.reason}\n`);
      }
    }
  }

  const allFindings: Array<{ readonly severity: DiagnosticSeverity }> = [
    ...analysis.diagnostics,
    ...explainedItems.flatMap((c) => c.report.diagnostics),
  ];
  return severityMeetsThreshold(allFindings, opts.failOn) ? 2 : 0;
}

async function readSingleSqlInput(
  sqlArg: string | undefined,
  fileArg: string | undefined,
  useStdin: boolean,
  io: CliIo,
): Promise<string> {
  if (sqlArg) {
    return sqlArg;
  }
  if (fileArg) {
    return fs.readFile(fileArg, 'utf-8');
  }
  if (useStdin) {
    return io.readStdin();
  }
  throw new Error('Provide one SQL source: --sql <query>, --file <path>, or --stdin.');
}

async function collectQueriesForCi(
  input: {
    readonly sql?: string | undefined;
    readonly file?: string | undefined;
    readonly dir?: string | undefined;
    readonly stdin: boolean;
  },
  io: CliIo,
): Promise<
  Array<{ readonly sql: string; readonly file?: string; readonly startLine?: number }>
> {
  if (input.sql) {
    return [{ sql: input.sql }];
  }
  if (input.stdin) {
    const raw = await io.readStdin();
    return extractSqlBlocks(raw, 'sql', 'stdin.sql').map((b) => ({
      sql: b.sql,
      file: 'stdin.sql',
      startLine: b.startLine,
    }));
  }
  const scanTarget = input.file ?? input.dir;
  if (!scanTarget) {
    throw new Error(
      'Provide a SQL source for CI: --file <path>, --dir <path>, --sql <query>, or --stdin.',
    );
  }

  const files = await collectScannableFiles(scanTarget);
  const queries: Array<{
    readonly sql: string;
    readonly file: string;
    readonly startLine: number;
  }> = [];

  for (const filePath of files) {
    const ext = path.extname(filePath).toLowerCase();
    const langId = EXT_TO_LANGUAGE_ID[ext];
    if (!langId) {
      continue;
    }
    const content = await fs.readFile(filePath, 'utf-8');
    const blocks = extractSqlBlocks(content, langId, filePath);
    for (const block of blocks) {
      queries.push({
        sql: block.sql,
        file: path.relative(process.cwd(), filePath) || filePath,
        startLine: block.startLine,
      });
    }
  }
  return queries;
}

async function runOfflineCheck(
  opts: {
    readonly sql?: string | undefined;
    readonly file?: string | undefined;
    readonly dir?: string | undefined;
    readonly stdin: boolean;
    readonly engine: DatabaseEngine;
    readonly format: CliOutputFormat;
  },
  io: CliIo,
): Promise<number> {
  const sources: Array<{
    readonly file: string;
    readonly langId: string;
    readonly content: string;
  }> = [];

  if (opts.sql) {
    sources.push({ file: 'inline.sql', langId: 'sql', content: opts.sql });
  } else if (opts.stdin) {
    sources.push({
      file: 'stdin.sql',
      langId: 'sql',
      content: await io.readStdin(),
    });
  } else if (opts.file || opts.dir) {
    const files = await collectScannableFiles(opts.file ?? opts.dir!);
    for (const filePath of files) {
      const ext = path.extname(filePath).toLowerCase();
      const langId = EXT_TO_LANGUAGE_ID[ext];
      if (!langId) {
        continue;
      }
      sources.push({
        file: path.relative(process.cwd(), filePath) || filePath,
        langId,
        content: await fs.readFile(filePath, 'utf-8'),
      });
    }
  } else {
    throw new Error(
      'Provide SQL to check: --sql <query>, --file <path>, --dir <path>, or --stdin.',
    );
  }

  let checkedCount = 0;
  const failures: Array<{ readonly file: string; readonly reason: string }> = [];

  for (const src of sources) {
    if (src.langId === 'sql') {
      const preparedSql = containsDbtJinja(src.content)
        ? normalizeDbtSqlTemplate(src.content)
        : src.content;
      const spans = extractSqlStatementSpans(preparedSql, opts.engine);
      for (const span of spans) {
        checkedCount++;
        try {
          const classified = classifySqlStatement(span.sql, opts.engine);
          assertSafeSqlConstructs(classified.normalizedSql, opts.engine);
          if (classified.kind === 'DDL' || classified.kind === 'UNKNOWN') {
            failures.push({
              file: src.file,
              reason: `Disallowed statement kind "${classified.kind}"`,
            });
          }
        } catch (err) {
          failures.push({
            file: src.file,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
      continue;
    }

    const blocks = extractSqlBlocks(src.content, src.langId, src.file);
    for (const block of blocks) {
      checkedCount++;
      try {
        const classified = classifySqlStatement(block.sql, opts.engine);
        assertSafeSqlConstructs(classified.normalizedSql, opts.engine);
      } catch (err) {
        failures.push({
          file: `${src.file}:${block.startLine + 1}`,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  if (opts.format === 'json') {
    io.stdout(
      `${JSON.stringify({ checkedCount, passed: failures.length === 0, failures }, null, 2)}\n`,
    );
  } else {
    if (failures.length === 0) {
      io.stdout(`QueryAutopsy check: ${checkedCount} statement(s) passed safety checks.\n`);
    } else {
      io.stdout(
        `QueryAutopsy check: ${failures.length} issue(s) found across ${checkedCount} statement(s):\n`,
      );
      for (const f of failures) {
        io.stdout(`  - ${f.file}: ${f.reason}\n`);
      }
    }
  }

  return failures.length > 0 ? 2 : 0;
}

function emitFormattedReports(
  items: readonly SarifSourceItem[],
  format: CliOutputFormat,
  io: CliIo,
  skippedParameterized = 0,
): void {
  if (format === 'sarif') {
    io.stdout(`${JSON.stringify(formatSarifReports(items), null, 2)}\n`);
    return;
  }

  if (format === 'json') {
    if (items.length === 1 && skippedParameterized === 0) {
      io.stdout(`${JSON.stringify(items[0]!.report, null, 2)}\n`);
    } else {
      io.stdout(
        `${JSON.stringify(
          {
            inspected: items.length,
            skippedParameterized,
            reports: items.map((item) => ({
              ...(item.file ? { file: item.file } : {}),
              ...(item.startLine !== undefined
                ? { startLine: item.startLine + 1 }
                : {}),
              report: item.report,
            })),
          },
          null,
          2,
        )}\n`,
      );
    }
    return;
  }

  for (const item of items) {
    if (item.file) {
      const lineSuffix =
        item.startLine !== undefined ? `:${item.startLine + 1}` : '';
      io.stdout(`<!-- Source: ${item.file}${lineSuffix} -->\n`);
    }
    io.stdout(`${formatMarkdownPrReport(item.report)}\n\n`);
  }
  if (skippedParameterized > 0) {
    io.stdout(
      `_Skipped ${skippedParameterized} parameterized query(s) requiring runtime bindings._\n`,
    );
  }
}
