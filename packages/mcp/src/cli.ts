import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import type {
  DatabaseEngine,
  LoggerPort,
  ProfileEnvironment,
} from '@query-autopsy/core';
import {
  MultiEngineQueryExecutor,
  MultiEngineSlowQueryReader,
} from '@query-autopsy/executors';
import { McpFirewallServer } from './firewall.js';
import { McpStdioTransport } from './server.js';

export interface ParsedMcpCliConfig {
  readonly help: boolean;
  readonly version: boolean;
  readonly connectionString?: string | undefined;
  readonly engine?: DatabaseEngine | undefined;
  readonly environment?: ProfileEnvironment | undefined;
  readonly allowAnalyze: boolean;
  readonly statementTimeoutMs: number;
  readonly seqScanRowThreshold: number;
  readonly redactLiterals: boolean;
  readonly verbose: boolean;
}

function resolveDefaultSqlJsWasmPath(): string | undefined {
  try {
    const req = createRequire(import.meta.url);
    return req.resolve('sql.js/dist/sql-wasm.wasm');
  } catch {
    return undefined;
  }
}

function normalizeEngine(raw?: string): DatabaseEngine | undefined {
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
  throw new Error(
    `Unsupported --engine "${raw}". Expected postgresql, mysql, or sqlite.`,
  );
}

export function parseMcpCliArgs(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): ParsedMcpCliConfig {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      uri: { type: 'string' },
      engine: { type: 'string' },
      env: { type: 'string' },
      'allow-analyze': { type: 'boolean', default: false },
      timeout: { type: 'string', default: '5000' },
      threshold: { type: 'string', default: '1000' },
      'no-redact': { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
    allowPositionals: false,
  });

  const envVal = values.env as ProfileEnvironment | undefined;
  if (
    envVal !== undefined &&
    envVal !== 'local' &&
    envVal !== 'staging' &&
    envVal !== 'production'
  ) {
    throw new Error(
      `Invalid --env "${values.env}". Expected local, staging, or production.`,
    );
  }

  return {
    help: values.help === true,
    version: values.version === true,
    connectionString:
      values.uri ?? env['QUERY_AUTOPSY_URI'] ?? env['DATABASE_URL'],
    engine: normalizeEngine(values.engine),
    environment: envVal,
    allowAnalyze: values['allow-analyze'] === true,
    statementTimeoutMs: Math.max(100, Number(values.timeout) || 5000),
    seqScanRowThreshold: Math.max(10, Number(values.threshold) || 1000),
    redactLiterals: values['no-redact'] !== true,
    verbose: values.verbose === true,
  };
}

function getHelpText(): string {
  return [
    'QueryAutopsy MCP Firewall (@query-autopsy/mcp) — Zero-Trust stdio MCP Server',
    '',
    'Usage:',
    '  query-autopsy-mcp [--uri <dsn>] [options]',
    '',
    'Options:',
    '  --uri <dsn>                     Database URI (fallback: QUERY_AUTOPSY_URI, DATABASE_URL)',
    '  --engine <pg|mysql|sqlite>      Explicit database dialect override',
    '  --env <local|staging|production> Target environment (remote defaults to production)',
    '  --allow-analyze                 Allow read-only EXPLAIN ANALYZE on non-production targets',
    '  --timeout <ms>                  Max statement_timeout in ms (default: 5000, max: 30000)',
    '  --threshold <rows>              Seq Scan row threshold (default: 1000)',
    '  --no-redact                     Disable PII literal redaction (enabled by default)',
    '  --verbose                       Log operational events to stderr',
    '  -h, --help                      Show help',
    '  -v, --version                   Show version',
  ].join('\n');
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
): Promise<number> {
  let parsed: ParsedMcpCliConfig;
  try {
    parsed = parseMcpCliArgs(argv, process.env);
  } catch (err) {
    process.stderr.write(
      `QueryAutopsy MCP Error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  if (parsed.help) {
    process.stderr.write(`${getHelpText()}\n`);
    return 0;
  }

  if (parsed.version) {
    process.stderr.write('1.5.0\n');
    return 0;
  }

  // Strictly route all MCP server diagnostics to stderr so stdout carries pure JSON-RPC only.
  const logger: LoggerPort = {
    info: (msg, ctx) => {
      if (parsed.verbose) {
        process.stderr.write(
          `[query-autopsy-mcp] INFO ${msg}${ctx ? ` ${JSON.stringify(ctx)}` : ''}\n`,
        );
      }
    },
    warn: (msg, ctx) => {
      process.stderr.write(
        `[query-autopsy-mcp] WARN ${msg}${ctx ? ` ${JSON.stringify(ctx)}` : ''}\n`,
      );
    },
    error: (msg, ctx) => {
      process.stderr.write(
        `[query-autopsy-mcp] ERROR ${msg}${ctx ? ` ${JSON.stringify(ctx)}` : ''}\n`,
      );
    },
  };

  const queryExecutor = new MultiEngineQueryExecutor(logger, {
    wasmPath: resolveDefaultSqlJsWasmPath(),
  });
  const slowQueryReader = new MultiEngineSlowQueryReader(logger);

  const firewall = new McpFirewallServer({
    connectionString: parsed.connectionString,
    engine: parsed.engine,
    environment: parsed.environment,
    allowAnalyze: parsed.allowAnalyze,
    statementTimeoutMs: parsed.statementTimeoutMs,
    seqScanRowThreshold: parsed.seqScanRowThreshold,
    redactLiterals: parsed.redactLiterals,
    logger,
    queryExecutor,
    slowQueryReader,
  });

  const policy = firewall.getPolicySummary();
  logger.info('MCP Firewall ready on stdio', policy);

  const transport = new McpStdioTransport(firewall);
  try {
    await transport.runStdio(process.stdin, (line) =>
      process.stdout.write(line),
    );
    return 0;
  } finally {
    await firewall.dispose();
  }
}
