import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  type DatabaseEngine,
  type QueryTraceEntry,
  redactSqlLiterals,
} from '@query-autopsy/core';
import { shouldEnableTraceRecording } from './guard.js';

export interface TraceRecorderOptions {
  readonly enabled?: boolean | undefined;
  readonly allowProduction?: boolean | undefined;
  readonly currentEnvironment?: string | undefined;
  readonly allowedEnvironments?: readonly string[] | undefined;
  readonly workspaceRoot?: string | undefined;
  readonly tracePath?: string | undefined;
  readonly defaultEngine?: DatabaseEngine | undefined;
  readonly redactBindings?: boolean | undefined;
  readonly maxTraceBytes?: number | undefined;
  readonly maxBufferEntries?: number | undefined;
  readonly ignorePatterns?: readonly string[] | undefined;
}

export interface RecordQueryInput {
  readonly sql: string;
  readonly bindings?: readonly unknown[] | undefined;
  readonly durationMs?: number | undefined;
  readonly engine?: DatabaseEngine | undefined;
  readonly requestId?: string | undefined;
  readonly file?: string | undefined;
  readonly line?: number | undefined;
}

const DEFAULT_IGNORE_PATTERNS = [
  '_prisma_migrations',
  '__drizzle_migrations',
  'typeorm_metadata',
  'migrations',
  'pg_stat_',
  'information_schema.',
] as const;

const MAX_BINDING_STR_LEN = 256;

export function normalizeTraceEngine(raw?: string): DatabaseEngine | undefined {
  if (!raw) {
    return undefined;
  }
  const lower = raw.trim().toLowerCase();
  if (
    lower === 'pg' ||
    lower === 'postgres' ||
    lower === 'postgresql' ||
    lower === 'pgsql'
  ) {
    return 'postgresql';
  }
  if (lower === 'mysql' || lower === 'mysql2' || lower === 'mariadb') {
    return 'mysql';
  }
  if (lower === 'sqlite' || lower === 'sqlite3' || lower === 'better-sqlite3' || lower === 'libsql') {
    return 'sqlite';
  }
  if (lower === 'duckdb' || lower === 'duck') {
    return 'duckdb';
  }
  return undefined;
}

function sanitizeRequestId(raw?: string): string | undefined {
  if (!raw) {
    return undefined;
  }
  const cleaned = raw
    .trim()
    .replace(/[^a-zA-Z0-9._:-]/g, '')
    .slice(0, 64);
  return cleaned.length > 0 ? cleaned : undefined;
}

function sanitizeBindings(
  bindings: readonly unknown[] | undefined,
  redact: boolean,
): readonly unknown[] {
  if (redact || !bindings || bindings.length === 0) {
    return [];
  }

  return bindings.slice(0, 256).map((value) => {
    if (
      value === null ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    ) {
      return value;
    }
    if (typeof value === 'bigint') {
      return value.toString();
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (typeof value === 'string') {
      return value.length <= MAX_BINDING_STR_LEN
        ? value
        : `${value.slice(0, MAX_BINDING_STR_LEN)}...(truncated)`;
    }
    if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
      return '[BINARY]';
    }
    return '[NON_SCALAR]';
  });
}

function resolveUserCallerLocation(
  workspaceRoot: string,
): { readonly file: string; readonly line: number } | undefined {
  const stack = new Error().stack;
  if (!stack) {
    return undefined;
  }

  const normalizedRoot = path.resolve(workspaceRoot).replace(/\\/g, '/');
  const rootPrefix = normalizedRoot.endsWith('/')
    ? normalizedRoot
    : `${normalizedRoot}/`;

  for (const rawLine of stack.split('\n').slice(1)) {
    const trimmed = rawLine.trim();
    if (
      !trimmed ||
      trimmed.includes('node_modules') ||
      trimmed.includes('node:internal') ||
      trimmed.includes('packages/trace/') ||
      trimmed.includes('@query-autopsy/trace')
    ) {
      continue;
    }

    const match = /(?:\(|\s)((?:file:\/\/)?[^():\n]+):(\d+):(\d+)\)?$/.exec(
      trimmed,
    );
    if (!match?.[1] || !match[2]) {
      continue;
    }

    let filePath = match[1].replace(/\\/g, '/');
    if (filePath.startsWith('file://')) {
      try {
        filePath = new URL(filePath).pathname;
      } catch {
        continue;
      }
    }

    if (!filePath.startsWith(rootPrefix)) {
      continue;
    }

    const rel = filePath.slice(rootPrefix.length);
    if (!rel || rel.startsWith('..')) {
      continue;
    }

    const line = Math.max(1, Number.parseInt(match[2], 10));
    if (!Number.isFinite(line)) {
      continue;
    }

    return { file: rel, line };
  }

  return undefined;
}

/**
 * Buffers, PII-redacts, and atomically writes `.query-autopsy/traces.jsonl` entries
 * for Prisma, Drizzle, TypeORM, and custom Node.js database callers.
 */
export class JsonlTraceRecorder {
  private readonly enabled: boolean;
  private readonly workspaceRoot: string;
  private readonly tracePath: string;
  private readonly defaultEngine: DatabaseEngine;
  private readonly redactBindings: boolean;
  private readonly maxTraceBytes: number;
  private readonly maxBufferEntries: number;
  private readonly ignoreNeedles: readonly string[];
  private readonly requestContext = new AsyncLocalStorage<string>();

  private buffer: QueryTraceEntry[] = [];
  private activeFlush: Promise<void> | undefined;

  constructor(options?: TraceRecorderOptions) {
    this.enabled = shouldEnableTraceRecording(options);
    this.workspaceRoot = path.resolve(options?.workspaceRoot ?? process.cwd());
    this.tracePath = path.resolve(
      options?.tracePath ??
        path.join(this.workspaceRoot, '.query-autopsy', 'traces.jsonl'),
    );
    this.defaultEngine = options?.defaultEngine ?? 'postgresql';

    const envRedact = process.env['QUERY_AUTOPSY_REDACT_BINDINGS']
      ?.trim()
      .toLowerCase();
    this.redactBindings =
      options?.redactBindings ??
      (envRedact === 'false' || envRedact === '0' ? false : true);

    this.maxTraceBytes = Math.max(
      4096,
      Math.trunc(options?.maxTraceBytes ?? 5 * 1024 * 1024),
    );
    this.maxBufferEntries = Math.max(
      1,
      Math.trunc(options?.maxBufferEntries ?? 2000),
    );

    const patterns = options?.ignorePatterns ?? DEFAULT_IGNORE_PATTERNS;
    this.ignoreNeedles = patterns
      .map((p) => p.replace(/%/g, '').trim().toLowerCase())
      .filter((p) => p.length > 0);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getTracePath(): string {
    return this.tracePath;
  }

  getBufferedCount(): number {
    return this.buffer.length;
  }

  /**
   * Executes a callback inside an isolated async request ID window so concurrent
   * HTTP requests do not mix N+1 query bursts together.
   */
  runWithRequest<T>(requestId: string | undefined, fn: () => T): T {
    const safeId =
      sanitizeRequestId(requestId) ?? `req-${randomBytes(8).toString('hex')}`;
    return this.requestContext.run(safeId, fn);
  }

  record(input: RecordQueryInput): void {
    if (!this.enabled || this.buffer.length >= this.maxBufferEntries) {
      return;
    }

    const trimmedSql = input.sql.trim();
    if (!trimmedSql || this.shouldIgnoreSql(trimmedSql)) {
      return;
    }

    const engine = input.engine ?? this.defaultEngine;
    const safeSql = this.redactBindings
      ? redactSqlLiterals(trimmedSql, engine, { stripComments: true })
      : trimmedSql;
    const safeBindings = sanitizeBindings(input.bindings, this.redactBindings);

    const requestId =
      sanitizeRequestId(input.requestId) ??
      this.requestContext.getStore() ??
      'req-default';

    const caller =
      input.file !== undefined
        ? {
            file: input.file,
            ...(input.line !== undefined ? { line: input.line } : {}),
          }
        : resolveUserCallerLocation(this.workspaceRoot);

    const entry: QueryTraceEntry = {
      timestamp: new Date().toISOString(),
      engine,
      sql: safeSql,
      bindings: safeBindings,
      ...(input.durationMs !== undefined && Number.isFinite(input.durationMs)
        ? { durationMs: Number(Math.max(0, input.durationMs).toFixed(3)) }
        : {}),
      requestId,
      ...(caller?.file !== undefined ? { file: caller.file } : {}),
      ...(caller?.line !== undefined ? { line: caller.line } : {}),
    };

    this.buffer.push(entry);
  }

  async flush(): Promise<void> {
    if (this.activeFlush) {
      await this.activeFlush;
    }

    if (this.buffer.length === 0) {
      return;
    }

    const run = this.writePendingBuffer();
    this.activeFlush = run;
    try {
      await run;
    } finally {
      this.activeFlush = undefined;
    }
  }

  private async writePendingBuffer(): Promise<void> {
    const pending = this.buffer;
    this.buffer = [];
    if (pending.length === 0) {
      return;
    }

    const dir = path.dirname(this.tracePath);
    await assertNotSymlink(dir);
    await fs.mkdir(dir, { recursive: true, mode: 0o750 });

    const gitignorePath = path.join(dir, '.gitignore');
    if (!(await exists(gitignorePath))) {
      await fs.writeFile(gitignorePath, '*.jsonl\n*.ndjson\n', 'utf-8');
    }

    await assertNotSymlink(this.tracePath);

    try {
      const stat = await fs.stat(this.tracePath);
      if (stat.size >= this.maxTraceBytes) {
        const backupPath = `${this.tracePath}.1`;
        if (!(await isSymlink(backupPath))) {
          await fs.rename(this.tracePath, backupPath);
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }

    const lines = `${pending.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
    await fs.appendFile(this.tracePath, lines, 'utf-8');
  }

  private shouldIgnoreSql(sql: string): boolean {
    if (this.ignoreNeedles.length === 0) {
      return false;
    }
    const lower = sql.toLowerCase();
    return this.ignoreNeedles.some((needle) => lower.includes(needle));
  }
}

async function isSymlink(target: string): Promise<boolean> {
  try {
    const st = await fs.lstat(target);
    return st.isSymbolicLink();
  } catch {
    return false;
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

async function assertNotSymlink(target: string): Promise<void> {
  if (await isSymlink(target)) {
    throw new Error(
      `Refusing to write QueryAutopsy trace to symlink path: ${target}`,
    );
  }
}
