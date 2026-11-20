import {
  assertSafeSqlConstructs,
  classifySqlStatement,
  type DatabaseEngine,
  detectDatabaseEngineFromUri,
  DomainError,
  type ExplainMode,
  extractConnectionHost,
  FetchSlowQueriesService,
  type InspectionReport,
  InspectQueryService,
  isLoopbackHost,
  type LoggerPort,
  MissingConnectionError,
  type PlanNode,
  type ProfileEnvironment,
  QueryExecutionError,
  type QueryExecutorPort,
  redactSqlLiterals,
  type ReportPresenterPort,
  type RuntimeSettings,
  sanitizeConnectionDisplayTarget,
  sanitizeSqlError,
  SimulateIndexService,
  type SlowQueryPort,
  type SlowQuerySortBy,
  StaticConnectionConfig,
  UnsafeQueryError,
} from '@query-autopsy/core';

export interface McpToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

export interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations: McpToolAnnotations;
}

export interface McpToolCallResult {
  readonly content: ReadonlyArray<{ readonly type: 'text'; readonly text: string }>;
  readonly structuredContent?: Record<string, unknown> | undefined;
  readonly isError?: boolean | undefined;
}

export interface McpFirewallOptions {
  readonly connectionString?: string | undefined;
  readonly engine?: DatabaseEngine | undefined;
  readonly environment?: ProfileEnvironment | undefined;
  readonly allowAnalyze?: boolean | undefined;
  readonly statementTimeoutMs?: number | undefined;
  readonly seqScanRowThreshold?: number | undefined;
  readonly redactLiterals?: boolean | undefined;
  readonly logger?: LoggerPort | undefined;
  readonly queryExecutor?: QueryExecutorPort | undefined;
  readonly slowQueryReader?: SlowQueryPort | undefined;
}

const READ_ONLY_TOOL_ANNOTATIONS: McpToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const FORBIDDEN_ARG_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export class InvalidToolArgumentsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidToolArgumentsError';
  }
}

function assertPlainArgsObject(
  rawArgs: unknown,
  allowedKeys: ReadonlySet<string>,
): Record<string, unknown> {
  if (rawArgs === undefined) {
    return {};
  }
  if (typeof rawArgs !== 'object' || rawArgs === null || Array.isArray(rawArgs)) {
    throw new InvalidToolArgumentsError('Tool arguments must be a JSON object.');
  }
  const record = rawArgs as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_ARG_KEYS.has(key) || !allowedKeys.has(key)) {
      throw new InvalidToolArgumentsError(
        `Unexpected or disallowed argument "${key}".`,
      );
    }
  }
  return record;
}

function readRequiredString(
  args: Record<string, unknown>,
  key: string,
  maxLength = 32_768,
): string {
  const val = args[key];
  if (typeof val !== 'string' || val.trim().length === 0) {
    throw new InvalidToolArgumentsError(`"${key}" must be a non-empty string.`);
  }
  if (val.length > maxLength) {
    throw new InvalidToolArgumentsError(
      `"${key}" exceeds maximum length of ${maxLength} characters.`,
    );
  }
  return val;
}

function readOptionalEnum<T extends string>(
  args: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const val = args[key];
  if (val === undefined) {
    return undefined;
  }
  if (typeof val !== 'string' || !allowed.includes(val as T)) {
    throw new InvalidToolArgumentsError(
      `"${key}" must be one of: ${allowed.join(', ')}.`,
    );
  }
  return val as T;
}

function readOptionalParameters(
  args: Record<string, unknown>,
): readonly (string | number | boolean | null)[] | undefined {
  const raw = args['parameters'];
  if (raw === undefined) {
    return undefined;
  }
  if (!Array.isArray(raw) || raw.length > 100) {
    throw new InvalidToolArgumentsError(
      '"parameters" must be an array of up to 100 primitive values.',
    );
  }
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (
      item !== null &&
      typeof item !== 'string' &&
      typeof item !== 'number' &&
      typeof item !== 'boolean'
    ) {
      throw new InvalidToolArgumentsError(
        `"parameters[${i}]" must be a JSON primitive (string, number, boolean, or null).`,
      );
    }
    if (typeof item === 'number' && !Number.isFinite(item)) {
      throw new InvalidToolArgumentsError(
        `"parameters[${i}]" must be a finite number.`,
      );
    }
  }
  return raw as readonly (string | number | boolean | null)[];
}

function readOptionalNumber(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const raw = args[key];
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < min || raw > max) {
    throw new InvalidToolArgumentsError(
      `"${key}" must be a finite number between ${min} and ${max}.`,
    );
  }
  return raw;
}

function createNoopPresenter(): ReportPresenterPort {
  return {
    present: async () => undefined,
  };
}

function summarizeSafePlanNode(
  node: PlanNode,
  engine: DatabaseEngine,
  redact: boolean,
): Record<string, unknown> {
  const scrub = (text: string | undefined): string | undefined =>
    text !== undefined && redact
      ? redactSqlLiterals(text, engine, { stripComments: true })
      : text;

  return {
    id: node.id,
    nodeType: node.nodeType,
    ...(node.relationName ? { relationName: node.relationName } : {}),
    ...(node.indexName ? { indexName: node.indexName } : {}),
    startupCost: node.startupCost,
    totalCost: node.totalCost,
    planRows: node.planRows,
    ...(node.actualRows !== undefined ? { actualRows: node.actualRows } : {}),
    ...(node.actualLoops !== undefined ? { actualLoops: node.actualLoops } : {}),
    ...(node.exclusiveTimeMs !== undefined
      ? { exclusiveTimeMs: node.exclusiveTimeMs }
      : {}),
    ...(node.exclusiveTimePercent !== undefined
      ? { exclusiveTimePercent: node.exclusiveTimePercent }
      : {}),
    ...(node.filter ? { filter: scrub(node.filter) } : {}),
    ...(node.indexCond ? { indexCond: scrub(node.indexCond) } : {}),
    ...(node.recheckCond ? { recheckCond: scrub(node.recheckCond) } : {}),
    ...(node.hashCond ? { hashCond: scrub(node.hashCond) } : {}),
    children: node.children.map((child) =>
      summarizeSafePlanNode(child, engine, redact),
    ),
  };
}

export class McpFirewallServer {
  private readonly connectionConfig: StaticConnectionConfig;
  private readonly engine: DatabaseEngine;
  private readonly environment: ProfileEnvironment;
  private readonly allowAnalyze: boolean;
  private readonly redactLiterals: boolean;
  private readonly displayTarget: string;
  private readonly logger: LoggerPort;
  private readonly queryExecutor: QueryExecutorPort | undefined;
  private readonly slowQueryReader: SlowQueryPort | undefined;
  private readonly inspectService: InspectQueryService | undefined;
  private readonly simulateService: SimulateIndexService | undefined;
  private readonly fetchSlowQueriesService: FetchSlowQueriesService | undefined;

  constructor(options: McpFirewallOptions) {
    this.logger = options.logger ?? {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    };

    const connectionString = options.connectionString?.trim() || undefined;
    this.engine =
      options.engine ??
      (connectionString
        ? detectDatabaseEngineFromUri(connectionString)
        : 'postgresql');
    const host = connectionString
      ? extractConnectionHost(connectionString, this.engine)
      : undefined;

    // Zero-trust default: remote hosts default to 'production' unless explicitly set.
    this.environment =
      options.environment ??
      (host && !isLoopbackHost(host) ? 'production' : 'local');
    this.allowAnalyze = options.allowAnalyze === true;
    this.redactLiterals = options.redactLiterals ?? true;
    this.displayTarget = connectionString
      ? sanitizeConnectionDisplayTarget(connectionString, this.engine)
      : 'offline';

    const statementTimeoutMs = Math.min(
      30_000,
      Math.max(100, Math.trunc(options.statementTimeoutMs ?? 5000)),
    );
    const seqScanRowThreshold = Math.max(
      10,
      Math.trunc(options.seqScanRowThreshold ?? 1000),
    );

    const runtimeSettings: RuntimeSettings = {
      statementTimeoutMs,
      // Hard invariant: WRITE EXPLAIN ANALYZE is NEVER enabled over MCP.
      allowWriteAnalyze: false,
      seqScanRowThreshold,
      showRawJson: false,
      redactLiteralsInReports: this.redactLiterals,
    };

    this.connectionConfig = new StaticConnectionConfig({
      connectionString,
      runtimeSettings,
      environment: this.environment,
      engine: this.engine,
      profileId: 'mcp-firewall',
      forceReadOnlyLock: true,
    });

    this.queryExecutor = options.queryExecutor;
    this.slowQueryReader = options.slowQueryReader;

    if (this.queryExecutor) {
      this.inspectService = new InspectQueryService({
        connectionConfig: this.connectionConfig,
        queryExecutor: this.queryExecutor,
        reportPresenter: createNoopPresenter(),
        logger: this.logger,
      });
      this.simulateService = new SimulateIndexService({
        connectionConfig: this.connectionConfig,
        queryExecutor: this.queryExecutor,
        logger: this.logger,
      });
    }

    if (this.slowQueryReader) {
      this.fetchSlowQueriesService = new FetchSlowQueriesService({
        connectionConfig: this.connectionConfig,
        slowQueryReader: this.slowQueryReader,
        logger: this.logger,
      });
    }
  }

  getPolicySummary(): {
    readonly engine: DatabaseEngine;
    readonly environment: ProfileEnvironment;
    readonly target: string;
    readonly allowAnalyze: boolean;
    readonly allowWriteAnalyze: false;
    readonly allowSchemaMutation: false;
    readonly redactLiterals: boolean;
  } {
    return {
      engine: this.engine,
      environment: this.environment,
      target: this.displayTarget,
      allowAnalyze: this.allowAnalyze && this.environment !== 'production',
      allowWriteAnalyze: false,
      allowSchemaMutation: false,
      redactLiterals: this.redactLiterals,
    };
  }

  listTools(): readonly McpToolDefinition[] {
    return [
      {
        name: 'autopsy_check_sql',
        description:
          'Offline static SQL safety and syntax check (zero database connection). Validates single-statement boundaries, detects DDL/write classifications, and blocks dangerous server functions.',
        annotations: READ_ONLY_TOOL_ANNOTATIONS,
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['sql'],
          properties: {
            sql: {
              type: 'string',
              description: 'Single SQL statement to validate statically.',
            },
            engine: {
              type: 'string',
              enum: ['postgresql', 'mysql', 'sqlite'],
              description: 'Target SQL dialect (defaults to server engine).',
            },
          },
        },
      },
      {
        name: 'autopsy_explain',
        description:
          'Inspect SQL execution plan and performance bottlenecks safely. Uses non-executing EXPLAIN estimate mode by default, strips PII literals, and never returns table rows or allows raw SQL / schema mutations.',
        annotations: READ_ONLY_TOOL_ANNOTATIONS,
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['sql'],
          properties: {
            sql: {
              type: 'string',
              description:
                'Single SELECT/WITH/DML SQL query (without leading EXPLAIN keyword).',
            },
            mode: {
              type: 'string',
              enum: ['estimate', 'analyze'],
              description:
                'Defaults to "estimate" (query not executed). "analyze" requires non-production server startup opt-in (--allow-analyze) and only supports READ queries inside ROLLBACK.',
            },
            parameters: {
              type: 'array',
              items: {
                type: ['string', 'number', 'boolean', 'null'],
              },
              description: 'Positional bind values for $1..$n or ? placeholders.',
            },
          },
        },
      },
      {
        name: 'autopsy_simulate_index',
        description:
          'Simulate a PostgreSQL index virtually in memory via HypoPG (zero disk writes, zero locks) and return estimated cost delta.',
        annotations: READ_ONLY_TOOL_ANNOTATIONS,
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['querySql', 'indexSql'],
          properties: {
            querySql: {
              type: 'string',
              description: 'Query to re-plan with the hypothetical index.',
            },
            indexSql: {
              type: 'string',
              description:
                'Proposed CREATE INDEX CONCURRENTLY statement (only allowlisted immutable functions permitted).',
            },
            baselineCost: {
              type: 'number',
              minimum: 0,
              description:
                'Optional baseline Total Cost from a prior autopsy_explain call.',
            },
            parameters: {
              type: 'array',
              items: {
                type: ['string', 'number', 'boolean', 'null'],
              },
              description: 'Positional bind parameters if querySql uses $1..$n.',
            },
          },
        },
      },
      {
        name: 'autopsy_list_slow_queries',
        description:
          'Fetch top slowest aggregated query fingerprints from pg_stat_statements (PostgreSQL) or performance_schema (MySQL) with PII literals redacted.',
        annotations: READ_ONLY_TOOL_ANNOTATIONS,
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            limit: {
              type: 'number',
              minimum: 1,
              maximum: 25,
              description: 'Number of slow query entries to return (1-25, default 10).',
            },
            sortBy: {
              type: 'string',
              enum: ['mean_exec_time', 'total_exec_time'],
              description: 'Sort metric (default: mean_exec_time).',
            },
          },
        },
      },
    ];
  }

  async callTool(
    toolName: string,
    rawArgs: unknown,
  ): Promise<McpToolCallResult> {
    try {
      let payload: Record<string, unknown>;

      switch (toolName) {
        case 'autopsy_check_sql':
          payload = this.handleCheckSql(rawArgs);
          break;
        case 'autopsy_explain':
          payload = await this.handleExplain(rawArgs);
          break;
        case 'autopsy_simulate_index':
          payload = await this.handleSimulateIndex(rawArgs);
          break;
        case 'autopsy_list_slow_queries':
          payload = await this.handleListSlowQueries(rawArgs);
          break;
        default:
          throw new InvalidToolArgumentsError(
            `Tool "${toolName}" is not exposed by QueryAutopsy MCP Firewall.`,
          );
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
      };
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      const sqlState =
        err instanceof QueryExecutionError ? err.sqlState : undefined;
      const safeMessage =
        this.redactLiterals || err instanceof QueryExecutionError || err instanceof DomainError
          ? sanitizeSqlError(rawMessage, sqlState)
          : rawMessage;

      const errorPayload = {
        error: safeMessage,
        code:
          err instanceof DomainError
            ? err.code
            : err instanceof InvalidToolArgumentsError
              ? 'INVALID_ARGUMENTS'
              : 'EXECUTION_ERROR',
        trustBoundary: 'untrusted_database_metadata',
      };

      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify(errorPayload, null, 2) }],
        structuredContent: errorPayload,
      };
    }
  }

  private handleCheckSql(rawArgs: unknown): Record<string, unknown> {
    const args = assertPlainArgsObject(
      rawArgs,
      new Set(['sql', 'engine']),
    );
    const sql = readRequiredString(args, 'sql');
    const engine =
      readOptionalEnum(args, 'engine', ['postgresql', 'mysql', 'sqlite'] as const) ??
      this.engine;

    const classified = classifySqlStatement(sql, engine);
    assertSafeSqlConstructs(classified.normalizedSql, engine);

    const safeForInspect =
      classified.kind === 'READ' || classified.kind === 'WRITE';

    return {
      trustBoundary: 'untrusted_database_metadata',
      engine,
      safe: safeForInspect,
      statementKind: classified.kind,
      parameterIndices: classified.parameterIndices,
      redactedSql: redactSqlLiterals(classified.normalizedSql, engine, {
        stripComments: true,
      }),
    };
  }

  private async handleExplain(
    rawArgs: unknown,
  ): Promise<Record<string, unknown>> {
    const args = assertPlainArgsObject(
      rawArgs,
      new Set(['sql', 'mode', 'parameters']),
    );
    const sql = readRequiredString(args, 'sql');
    const requestedMode: ExplainMode =
      readOptionalEnum(args, 'mode', ['estimate', 'analyze'] as const) ??
      'estimate';
    const parameters = readOptionalParameters(args);

    if (requestedMode === 'analyze') {
      if (!this.allowAnalyze) {
        throw new UnsafeQueryError(
          'EXPLAIN ANALYZE is disabled in QueryAutopsy MCP by default. Use mode "estimate" or start MCP with --allow-analyze on non-production targets.',
        );
      }
      if (this.environment === 'production') {
        throw new UnsafeQueryError(
          'EXPLAIN ANALYZE is prohibited on production targets inside MCP Firewall. Use mode "estimate".',
        );
      }
    }

    if (!this.inspectService) {
      throw new MissingConnectionError();
    }

    const report = await this.inspectService.execute({
      rawSql: sql,
      mode: requestedMode,
      parameters,
    });

    return this.formatSafeInspectionPayload(report);
  }

  private async handleSimulateIndex(
    rawArgs: unknown,
  ): Promise<Record<string, unknown>> {
    const args = assertPlainArgsObject(
      rawArgs,
      new Set(['querySql', 'indexSql', 'baselineCost', 'parameters']),
    );
    const querySql = readRequiredString(args, 'querySql');
    const indexSql = readRequiredString(args, 'indexSql', 4096);
    const baselineCost = readOptionalNumber(args, 'baselineCost', 0, 1e15) ?? 0;
    const parameters = readOptionalParameters(args);

    if (!this.simulateService) {
      throw new MissingConnectionError();
    }

    const outcome = await this.simulateService.execute({
      querySql,
      indexSql,
      baselineCost,
      parameters,
    });

    return {
      trustBoundary: 'untrusted_database_metadata',
      target: this.displayTarget,
      engine: this.engine,
      ...outcome,
    };
  }

  private async handleListSlowQueries(
    rawArgs: unknown,
  ): Promise<Record<string, unknown>> {
    const args = assertPlainArgsObject(
      rawArgs,
      new Set(['limit', 'sortBy']),
    );
    const limit = Math.trunc(readOptionalNumber(args, 'limit', 1, 25) ?? 10);
    const sortBy: SlowQuerySortBy =
      readOptionalEnum(args, 'sortBy', [
        'mean_exec_time',
        'total_exec_time',
      ] as const) ?? 'mean_exec_time';

    if (!this.fetchSlowQueriesService) {
      throw new MissingConnectionError();
    }

    const result = await this.fetchSlowQueriesService.execute({ limit, sortBy });
    if (!result.supported) {
      return {
        trustBoundary: 'untrusted_database_metadata',
        target: this.displayTarget,
        supported: false,
        engine: result.engine,
        reason: this.redactLiterals
          ? sanitizeSqlError(result.reason)
          : result.reason,
      };
    }

    return {
      trustBoundary: 'untrusted_database_metadata',
      target: this.displayTarget,
      supported: true,
      engine: result.engine,
      entries: result.entries.map((entry) => ({
        queryId: entry.queryId,
        query: this.redactLiterals
          ? redactSqlLiterals(entry.query, result.engine, {
              stripComments: true,
            })
          : entry.query,
        calls: entry.calls,
        totalExecTimeMs: entry.totalExecTimeMs,
        meanExecTimeMs: entry.meanExecTimeMs,
        rows: entry.rows,
        sharedBlksHit: entry.sharedBlksHit,
        sharedBlksRead: entry.sharedBlksRead,
      })),
    };
  }

  private formatSafeInspectionPayload(
    report: InspectionReport,
  ): Record<string, unknown> {
    const engine = report.engine ?? this.engine;
    const scrub = (text: string): string =>
      this.redactLiterals
        ? redactSqlLiterals(text, engine, { stripComments: true })
        : text;

    return {
      trustBoundary: 'untrusted_database_metadata',
      target: this.displayTarget,
      engine,
      environment: this.environment,
      mode: report.mode,
      statementKind: report.statementKind,
      sql: scrub(report.sql),
      metrics: {
        executionTimeMs: report.plan.executionTimeMs,
        planningTimeMs: report.plan.planningTimeMs,
        totalCost: report.plan.root.totalCost,
        startupCost: report.plan.root.startupCost,
        buffers: report.plan.totalBuffers,
      },
      diagnostics: report.diagnostics.map((d) => ({
        ruleId: d.ruleId,
        severity: d.severity,
        nodeId: d.nodeId,
        nodeType: d.nodeType,
        ...(d.relationName ? { relationName: d.relationName } : {}),
        title: scrub(d.title),
        detail: scrub(d.detail),
        recommendation: scrub(d.recommendation),
        ...(d.indexSuggestion
          ? { suggestedIndexSql: d.indexSuggestion.sql }
          : {}),
      })),
      planTree: summarizeSafePlanNode(
        report.plan.root,
        engine,
        this.redactLiterals,
      ),
    };
  }

  async dispose(): Promise<void> {
    await this.queryExecutor?.dispose();
  }
}
