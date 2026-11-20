import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  type ExplainExecutionRequest,
  type HypotheticalSimulationOutput,
  type LoggerPort,
  QueryExecutionError,
  type QueryExecutorPort,
  type SqliteEqpRow,
  type SqliteRawPlanPayload,
} from '@query-autopsy/core';
import initSqlJs, { type BindParams, type Database, type SqlJsStatic, type SqlValue } from 'sql.js';

interface ResolvedSqliteTarget {
  readonly isMemory: boolean;
  readonly filePath: string;
}

export function resolveSqliteTarget(
  connectionString: string,
): ResolvedSqliteTarget {
  const trimmed = connectionString.trim();
  if (
    trimmed.toLowerCase() === ':memory:' ||
    trimmed.toLowerCase() === 'sqlite://:memory:' ||
    trimmed.toLowerCase() === 'sqlite::memory:'
  ) {
    return { isMemory: true, filePath: ':memory:' };
  }

  let filePath = trimmed;
  if (/^sqlite:\/\//i.test(filePath)) {
    filePath = filePath.slice('sqlite://'.length);
  } else if (/^sqlite:/i.test(filePath)) {
    filePath = filePath.slice('sqlite:'.length);
  } else if (/^file:/i.test(filePath)) {
    filePath = filePath.slice('file:'.length);
  }

  filePath = (filePath.split('?')[0] ?? filePath).trim();
  if (!filePath) {
    throw new QueryExecutionError('SQLite connection path cannot be empty.');
  }

  return { isMemory: false, filePath: path.resolve(filePath) };
}

function toBindParams(parameters: readonly unknown[]): BindParams | undefined {
  if (parameters.length === 0) {
    return undefined;
  }
  return parameters.map((val): SqlValue => {
    if (val === null || val === undefined) {
      return null;
    }
    if (typeof val === 'number' || typeof val === 'string') {
      return val;
    }
    if (typeof val === 'boolean') {
      return val ? 1 : 0;
    }
    if (val instanceof Uint8Array) {
      return val;
    }
    return String(val);
  });
}

async function resolveWasmBinary(explicitWasmPath?: string): Promise<Uint8Array> {
  const candidates: string[] = [];
  if (explicitWasmPath) {
    candidates.push(explicitWasmPath);
  }
  if (typeof __dirname === 'string') {
    candidates.push(path.join(__dirname, 'sql-wasm.wasm'));
  }

  let dir = process.cwd();
  for (let depth = 0; depth < 6; depth++) {
    candidates.push(
      path.join(dir, 'dist', 'sql-wasm.wasm'),
      path.join(dir, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
    );
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fsConstants.R_OK);
      const buf = await fs.readFile(candidate);
      return new Uint8Array(buf);
    } catch {
      // Try next candidate
    }
  }

  throw new QueryExecutionError(
    'SQLite WASM runtime (sql-wasm.wasm) could not be located.',
  );
}

export interface SqliteExecutorOptions {
  readonly wasmPath?: string | undefined;
}

export class SqliteQueryExecutor implements QueryExecutorPort {
  private sqlJsPromise: Promise<SqlJsStatic> | undefined;

  constructor(
    private readonly logger: LoggerPort,
    private readonly options?: SqliteExecutorOptions,
  ) {}

  private async getSqlJs(): Promise<SqlJsStatic> {
    if (!this.sqlJsPromise) {
      this.sqlJsPromise = resolveWasmBinary(this.options?.wasmPath).then(
        (wasmBinary) => {
          const arrayBuffer = new ArrayBuffer(wasmBinary.byteLength);
          new Uint8Array(arrayBuffer).set(wasmBinary);
          return initSqlJs({
            wasmBinary: arrayBuffer,
            useOldExtensionFunctions: false,
          });
        },
      );
    }
    return this.sqlJsPromise;
  }

  private async openDatabase(
    target: ResolvedSqliteTarget,
  ): Promise<Database> {
    const SQL = await this.getSqlJs();
    if (target.isMemory) {
      return new SQL.Database();
    }

    let bytes: Buffer;
    try {
      bytes = await fs.readFile(target.filePath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new QueryExecutionError(
        `Cannot open SQLite database file "${target.filePath}": ${msg}`,
      );
    }

    try {
      return new SQL.Database(new Uint8Array(bytes));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new QueryExecutionError(
        `Invalid SQLite database file "${target.filePath}": ${msg}`,
      );
    }
  }

  async executeExplain(
    connectionString: string,
    request: ExplainExecutionRequest,
  ): Promise<SqliteRawPlanPayload> {
    const target = resolveSqliteTarget(connectionString);
    const db = await this.openDatabase(target);
    const bindParams = toBindParams(request.parameters);

    try {
      const eqpStmt = db.prepare(`EXPLAIN QUERY PLAN ${request.sql}`);
      const eqpRows: SqliteEqpRow[] = [];
      try {
        if (bindParams) {
          eqpStmt.bind(bindParams);
        }
        while (eqpStmt.step()) {
          const row = eqpStmt.getAsObject() as Record<string, unknown>;
          const id = Number(row['id'] ?? 0);
          const parent = Number(row['parent'] ?? 0);
          const detail = String(row['detail'] ?? '');
          eqpRows.push({ id, parent, detail });
        }
      } finally {
        eqpStmt.free();
      }

      if (request.mode === 'estimate') {
        return {
          eqpRows,
          databasePath: target.filePath,
        };
      }

      // Execute inside ROLLBACK transaction in isolated in-memory WASM copy.
      db.run('BEGIN');
      let actualRows = 0;
      let executionTimeMs = 0;
      const execStmt = db.prepare(request.sql);
      try {
        const startNs = process.hrtime.bigint();
        if (bindParams) {
          execStmt.bind(bindParams);
        }
        while (execStmt.step()) {
          actualRows++;
        }
        const elapsedNs = process.hrtime.bigint() - startNs;
        executionTimeMs = Number(elapsedNs) / 1_000_000;

        if (request.kind === 'WRITE') {
          actualRows = db.getRowsModified();
        }
      } finally {
        execStmt.free();
        try {
          db.run('ROLLBACK');
        } catch {
          // Ignore rollback cleanup failure on read queries
        }
      }

      return {
        eqpRows,
        executionTimeMs,
        actualRows,
        databasePath: target.filePath,
      };
    } catch (err) {
      if (err instanceof QueryExecutionError) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new QueryExecutionError(`SQLite execution failed: ${msg}`);
    } finally {
      db.close();
    }
  }

  async executeCreateIndex(
    connectionString: string,
    indexSql: string,
  ): Promise<void> {
    const target = resolveSqliteTarget(connectionString);
    if (target.isMemory) {
      throw new QueryExecutionError(
        'Cannot persist CREATE INDEX on an in-memory :memory: SQLite database.',
      );
    }

    const db = await this.openDatabase(target);
    try {
      db.run(indexSql);
      const updatedBytes = db.export();
      await fs.writeFile(target.filePath, updatedBytes);
      this.logger.info('SQLite index persisted to database file', {
        filePath: target.filePath,
      });
    } catch (err) {
      if (err instanceof QueryExecutionError) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new QueryExecutionError(`SQLite index creation failed: ${msg}`);
    } finally {
      db.close();
    }
  }

  async simulateHypotheticalIndex(
    _connectionString: string,
    _querySql: string,
    _indexSql: string,
    _parameters: readonly unknown[],
  ): Promise<HypotheticalSimulationOutput> {
    return {
      supported: false,
      reason:
        'Hypothetical index simulation (HypoPG) is only supported on PostgreSQL.',
    };
  }

  async testConnection(
    connectionString: string,
  ): Promise<{ serverVersion: string }> {
    const target = resolveSqliteTarget(connectionString);
    const db = await this.openDatabase(target);
    try {
      const res = db.exec('SELECT sqlite_version() AS version');
      const ver = res[0]?.values[0]?.[0];
      return {
        serverVersion:
          typeof ver === 'string'
            ? `SQLite ${ver} (WASM)`
            : 'SQLite (WASM)',
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new QueryExecutionError(`SQLite connection check failed: ${msg}`);
    } finally {
      db.close();
    }
  }

  async dispose(): Promise<void> {
    this.sqlJsPromise = undefined;
  }
}
