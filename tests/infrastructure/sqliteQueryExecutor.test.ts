import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  type ConnectionConfigPort,
  type ConnectionProfile,
  InspectQueryService,
  type LoggerPort,
  type ReportPresenterPort,
  type RuntimeSettings,
} from '@query-autopsy/core';
import { SqliteQueryExecutor } from '@query-autopsy/executors';
import initSqlJs from 'sql.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const tempDirs: string[] = [];

async function createSampleSqliteFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'query-autopsy-sqlite-'));
  tempDirs.push(dir);
  const dbPath = path.join(dir, 'sample.sqlite');

  const wasmBytes = await fs.readFile(
    path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
  );
  const wasmBuffer = new ArrayBuffer(wasmBytes.byteLength);
  new Uint8Array(wasmBuffer).set(wasmBytes);

  const SQL = await initSqlJs({
    wasmBinary: wasmBuffer,
    useOldExtensionFunctions: false,
  });

  const db = new SQL.Database();
  db.run(
    'CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, status TEXT NOT NULL, amount_cents INTEGER NOT NULL);',
  );
  db.run('BEGIN');
  const stmt = db.prepare(
    'INSERT INTO orders (id, user_id, status, amount_cents) VALUES (?, ?, ?, ?)',
  );
  for (let i = 1; i <= 1500; i++) {
    stmt.run([i, (i % 50) + 1, i % 5 === 0 ? 'pending' : 'paid', i * 100]);
  }
  stmt.free();
  db.run('COMMIT');

  await fs.writeFile(dbPath, db.export());
  db.close();
  return dbPath;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('SqliteQueryExecutor (real WASM sql.js integration)', () => {
  const logger: LoggerPort = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  it('inspects SQLite EXPLAIN QUERY PLAN, creates persistent index, and eliminates Full Table Scan', async () => {
    const dbPath = await createSampleSqliteFile();
    const dsn = `sqlite://${dbPath}`;
    const executor = new SqliteQueryExecutor(logger);

    const version = await executor.testConnection(dsn);
    expect(version.serverVersion).toMatch(/^SQLite 3\./);

    const profile: ConnectionProfile = {
      id: 'local-sqlite',
      name: 'sample.sqlite',
      engine: 'sqlite',
      environment: 'local',
      readOnlyLocked: false,
      displayTarget: 'sample.sqlite',
    };

    const settings: RuntimeSettings = {
      statementTimeoutMs: 5000,
      allowWriteAnalyze: false,
      seqScanRowThreshold: 1000,
      showRawJson: false,
    };

    const connectionConfig: ConnectionConfigPort = {
      getConnectionString: vi.fn().mockResolvedValue(dsn),
      saveConnectionString: vi.fn(),
      clearConnectionString: vi.fn(),
      getActiveProfile: vi.fn().mockResolvedValue(profile),
      listProfiles: vi.fn().mockResolvedValue([profile]),
      saveProfile: vi.fn(),
      setActiveProfile: vi.fn(),
      setProfileReadOnlyLock: vi.fn(),
      deleteProfile: vi.fn(),
      getRuntimeSettings: vi.fn().mockReturnValue(settings),
    };

    const presenter: ReportPresenterPort = {
      present: vi.fn().mockResolvedValue(undefined),
    };

    const inspectService = new InspectQueryService({
      connectionConfig,
      queryExecutor: executor,
      reportPresenter: presenter,
      logger,
    });

    const query =
      'SELECT * FROM orders WHERE status = ? ORDER BY amount_cents DESC';

    const beforeReport = await inspectService.execute({
      rawSql: query,
      mode: 'analyze',
      parameters: ['pending'],
    });

    expect(beforeReport.engine).toBe('sqlite');
    expect(beforeReport.plan.executionTimeMs).toBeGreaterThanOrEqual(0);
    expect(beforeReport.diagnostics.map((d) => d.ruleId)).toEqual(
      expect.arrayContaining([
        'SQLITE_FULL_TABLE_SCAN',
        'SQLITE_TEMP_BTREE_SORT',
      ]),
    );

    const suggestedSql = beforeReport.diagnostics.find(
      (d) => d.ruleId === 'SQLITE_TEMP_BTREE_SORT',
    )?.indexSuggestion?.sql;
    expect(suggestedSql).toBe(
      'CREATE INDEX IF NOT EXISTS idx_orders_status_amount_cents ON orders (status, amount_cents DESC);',
    );

    // Apply index persistently on the .sqlite file
    await executor.executeCreateIndex(dsn, suggestedSql!);

    const afterReport = await inspectService.execute({
      rawSql: query,
      mode: 'analyze',
      parameters: ['pending'],
    });

    expect(afterReport.diagnostics).toHaveLength(0);
    expect(afterReport.plan.root.nodeType).toBe('Index Search');
    expect(afterReport.plan.root.indexName).toBe(
      'idx_orders_status_amount_cents',
    );

    await executor.dispose();
  });
});
