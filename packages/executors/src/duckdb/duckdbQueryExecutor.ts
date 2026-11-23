import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  classifySqlStatement,
  type ExplainExecutionRequest,
  type HypotheticalSimulationOutput,
  type LoggerPort,
  QueryExecutionError,
  type QueryExecutorPort,
  tokenizeSql,
  UnsafeQueryError,
} from '@query-autopsy/core';

export interface DuckDbCommandOutput {
  readonly stdout: string;
  readonly stderr: string;
}

export type DuckDbCommandRunner = (
  binaryPath: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<DuckDbCommandOutput>;

export interface DuckDbExecutorOptions {
  /** Optional explicit path to the `duckdb` CLI binary (defaults to `"duckdb"` on PATH). */
  readonly binaryPath?: string | undefined;
  /** Optional trusted workspace root confining `.duckdb` and local `.parquet` / `.csv` file reads. */
  readonly workspaceRoot?: string | undefined;
  /** Optional custom command runner for offline unit testing without spawning external binaries. */
  readonly commandRunner?: DuckDbCommandRunner | undefined;
}

export interface ResolvedDuckDbTarget {
  readonly isMemory: boolean;
  readonly filePath: string;
}

const REMOTE_DATA_SCHEME_RE = /^(?:https?|s3|gs|az|abfss?|hf|r2):\/\//i;
const LOCAL_DATA_EXT_RE = /\.(?:parquet|pq|csv|tsv|json|ndjson|jsonl)$/i;

export function resolveDuckDbTarget(
  connectionString: string,
): ResolvedDuckDbTarget {
  const trimmed = connectionString.trim();
  const lower = trimmed.toLowerCase();
  if (
    lower === ':memory:' ||
    lower === ':memory:duckdb' ||
    lower === 'duckdb://:memory:' ||
    lower === 'duckdb::memory:'
  ) {
    return { isMemory: true, filePath: ':memory:' };
  }

  let filePath = trimmed;
  if (/^duckdb:\/\//i.test(filePath)) {
    filePath = filePath.slice('duckdb://'.length);
  } else if (/^duckdb:/i.test(filePath)) {
    filePath = filePath.slice('duckdb:'.length);
  } else if (/^file:/i.test(filePath)) {
    filePath = filePath.slice('file:'.length);
  }

  filePath = (filePath.split('?')[0] ?? filePath).trim();
  if (!filePath) {
    throw new QueryExecutionError('DuckDB connection path cannot be empty.');
  }

  return { isMemory: false, filePath: path.resolve(filePath) };
}

function unquoteSingleLiteral(tokenRaw: string): string {
  if (tokenRaw.startsWith("'") && tokenRaw.endsWith("'") && tokenRaw.length >= 2) {
    return tokenRaw.slice(1, -1).replace(/''/g, "'");
  }
  return tokenRaw;
}

async function assertNoSymlinkInsideWorkspace(
  targetInsideRealWorkspace: string,
  realWorkspace: string,
): Promise<void> {
  const rel = path.relative(realWorkspace, targetInsideRealWorkspace);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new UnsafeQueryError(
      `Blocked DuckDB file reference outside workspace boundary: ${targetInsideRealWorkspace}`,
    );
  }
  if (!rel) {
    return;
  }

  let current = realWorkspace;
  for (const segment of rel.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const st = await fs.lstat(current);
      if (st.isSymbolicLink()) {
        throw new UnsafeQueryError(
          `Blocked symbolic link access in DuckDB path: ${current}`,
        );
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        break;
      }
      throw err;
    }
  }
}

async function assertPathWithinWorkspace(
  candidatePath: string,
  workspaceRoot: string,
): Promise<void> {
  const rawWorkspace = path.resolve(workspaceRoot);
  const realWorkspace = await fs.realpath(rawWorkspace);

  let targetUnderRealWs: string;
  if (!path.isAbsolute(candidatePath)) {
    targetUnderRealWs = path.resolve(realWorkspace, candidatePath);
  } else {
    const absCandidate = path.resolve(candidatePath);
    const relFromReal = path.relative(realWorkspace, absCandidate);
    if (!relFromReal.startsWith('..') && !path.isAbsolute(relFromReal)) {
      targetUnderRealWs = absCandidate;
    } else {
      const relFromRaw = path.relative(rawWorkspace, absCandidate);
      if (!relFromRaw.startsWith('..') && !path.isAbsolute(relFromRaw)) {
        targetUnderRealWs = path.resolve(realWorkspace, relFromRaw);
      } else {
        throw new UnsafeQueryError(
          `Blocked DuckDB file reference outside workspace boundary: ${candidatePath}`,
        );
      }
    }
  }

  await assertNoSymlinkInsideWorkspace(targetUnderRealWs, realWorkspace);

  let resolvedReal: string;
  try {
    resolvedReal = await fs.realpath(targetUnderRealWs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      resolvedReal = targetUnderRealWs;
    } else {
      throw err;
    }
  }

  const rel = path.relative(realWorkspace, resolvedReal);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new UnsafeQueryError(
      `Blocked DuckDB file reference outside workspace boundary: ${candidatePath}`,
    );
  }
}

async function validateSqlDataFileReferences(
  sql: string,
  workspaceRoot?: string,
): Promise<void> {
  const tokens = tokenizeSql(sql, 'duckdb');
  for (const tok of tokens) {
    if (tok.subkind !== 'string') {
      continue;
    }
    const literalValue = unquoteSingleLiteral(tok.normalized).trim();
    if (!literalValue) {
      continue;
    }

    if (REMOTE_DATA_SCHEME_RE.test(literalValue)) {
      throw new UnsafeQueryError(
        `Blocked remote object/HTTP URL in local DuckDB inspection ("${literalValue.split(':')[0]}://"). Use local workspace files or disable external network access.`,
      );
    }

    const basePath = literalValue.split('*')[0] ?? literalValue;
    if (LOCAL_DATA_EXT_RE.test(literalValue)) {
      if (workspaceRoot) {
        await assertPathWithinWorkspace(basePath, workspaceRoot);
      }
    }
  }
}

function escapeSqlLiteral(val: unknown): string {
  if (val === null || val === undefined) {
    return 'NULL';
  }
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) {
      throw new QueryExecutionError('Non-finite numeric bind parameter for DuckDB.');
    }
    return String(val);
  }
  if (typeof val === 'boolean') {
    return val ? 'TRUE' : 'FALSE';
  }
  const str = typeof val === 'string' ? val : String(val);
  return `'${str.replace(/'/g, "''")}'`;
}

function buildDuckDbExplainScript(request: ExplainExecutionRequest): string {
  const explainHeader =
    request.mode === 'analyze'
      ? 'EXPLAIN (ANALYZE, FORMAT JSON)'
      : 'EXPLAIN (FORMAT JSON)';
  const baseSql = request.sql.replace(/;\s*$/, '').trim();

  if (request.parameters.length === 0) {
    return `${explainHeader} ${baseSql};`;
  }

  const boundArgs = request.parameters.map(escapeSqlLiteral).join(', ');
  return [
    `PREPARE __qa_plan AS ${baseSql};`,
    `${explainHeader} EXECUTE __qa_plan(${boundArgs});`,
    'DEALLOCATE __qa_plan;',
  ].join('\n');
}

export function mapDuckDbRunnerError(
  err: unknown,
  binaryPath: string,
  stderr?: string,
): QueryExecutionError {
  if (err instanceof QueryExecutionError) {
    return err;
  }
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') {
    return new QueryExecutionError(
      `DuckDB CLI binary ("${binaryPath}") was not found on PATH. Install DuckDB CLI (https://duckdb.org/docs/installation/) to run live DuckDB EXPLAIN plans.`,
      'ENOENT',
    );
  }
  const msg = err instanceof Error ? err.message : String(err);
  return new QueryExecutionError(
    stderr?.trim() || msg || 'DuckDB EXPLAIN execution failed.',
    typeof code === 'string' ? code : undefined,
  );
}

function defaultCommandRunner(
  binaryPath: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<DuckDbCommandOutput> {
  return new Promise((resolve, reject) => {
    execFile(
      binaryPath,
      [...args],
      {
        timeout: Math.max(100, timeoutMs),
        maxBuffer: 8 * 1024 * 1024,
        killSignal: 'SIGTERM',
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(mapDuckDbRunnerError(err, binaryPath, stderr));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

/**
 * Safe DuckDB `EXPLAIN (FORMAT JSON)` executor invoking the DuckDB CLI in `-readonly` mode
 * with workspace path confinement and zero bundled native dependencies.
 */
export class DuckDbQueryExecutor implements QueryExecutorPort {
  private readonly binaryPath: string;
  private readonly runner: DuckDbCommandRunner;

  constructor(
    private readonly logger: LoggerPort,
    private readonly options?: DuckDbExecutorOptions,
  ) {
    this.binaryPath = options?.binaryPath ?? 'duckdb';
    this.runner = options?.commandRunner ?? defaultCommandRunner;
  }

  async executeExplain(
    connectionString: string,
    request: ExplainExecutionRequest,
  ): Promise<unknown> {
    const classified = classifySqlStatement(request.sql, 'duckdb');
    if (classified.kind === 'WRITE' && request.mode === 'analyze') {
      throw new UnsafeQueryError(
        'DuckDB EXPLAIN ANALYZE on WRITE statements is disabled because DuckDB runs in read-only inspection mode. Use "Estimate Plan" instead.',
      );
    }

    const target = resolveDuckDbTarget(connectionString);
    if (!target.isMemory) {
      if (this.options?.workspaceRoot) {
        await assertPathWithinWorkspace(target.filePath, this.options.workspaceRoot);
      }
      await fs.access(target.filePath, fsConstants.R_OK).catch(() => {
        throw new QueryExecutionError(
          `DuckDB database file not found or unreadable: ${target.filePath}`,
        );
      });
    }

    await validateSqlDataFileReferences(
      classified.normalizedSql,
      this.options?.workspaceRoot,
    );

    const script = buildDuckDbExplainScript({
      ...request,
      sql: classified.normalizedSql,
    });

    const args = [
      ...(target.isMemory ? [':memory:'] : ['-readonly', target.filePath]),
      '-json',
      '-c',
      script,
    ];

    this.logger.info('Executing DuckDB EXPLAIN inspection', {
      engine: 'duckdb',
      mode: request.mode,
      isMemory: target.isMemory,
    });

    let stdout: string;
    try {
      const output = await this.runner(
        this.binaryPath,
        args,
        request.statementTimeoutMs,
      );
      stdout = output.stdout;
    } catch (err) {
      throw mapDuckDbRunnerError(err, this.binaryPath);
    }

    const trimmed = stdout.trim();
    if (!trimmed) {
      throw new QueryExecutionError('DuckDB returned empty EXPLAIN output.');
    }

    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      throw new QueryExecutionError(
        'DuckDB returned non-JSON EXPLAIN output.',
      );
    }
  }

  async executeCreateIndex(): Promise<void> {
    throw new QueryExecutionError(
      'Automatic CREATE INDEX execution is disabled for DuckDB.',
    );
  }

  async simulateHypotheticalIndex(
    _connectionString: string,
    _querySql: string,
    _indexSql: string,
    _parameters: readonly unknown[],
  ): Promise<HypotheticalSimulationOutput> {
    throw new QueryExecutionError(
      'HypoPG hypothetical index simulation is only supported on PostgreSQL.',
    );
  }

  async testConnection(
    connectionString: string,
  ): Promise<{ serverVersion: string }> {
    const target = resolveDuckDbTarget(connectionString);
    if (!target.isMemory) {
      if (this.options?.workspaceRoot) {
        await assertPathWithinWorkspace(target.filePath, this.options.workspaceRoot);
      }
      await fs.access(target.filePath, fsConstants.R_OK);
    }

    const args = [
      ...(target.isMemory ? [':memory:'] : ['-readonly', target.filePath]),
      '-json',
      '-c',
      'SELECT version() AS version;',
    ];
    const { stdout } = await this.runner(this.binaryPath, args, 5000);
    const parsed = JSON.parse(stdout) as Array<{ version?: unknown }>;
    const versionStr =
      typeof parsed[0]?.version === 'string'
        ? parsed[0].version
        : 'DuckDB';
    return { serverVersion: `DuckDB ${versionStr}` };
  }

  async dispose(): Promise<void> {
    // Stateless per-invocation DuckDB CLI calls hold no persistent sockets.
  }
}
