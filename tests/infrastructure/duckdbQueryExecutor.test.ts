import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LoggerPort } from '@query-autopsy/core';
import { DuckDbQueryExecutor, MultiEngineQueryExecutor } from '@query-autopsy/executors';
import { afterEach, describe, expect, it, vi } from 'vitest';

const tempDirs: string[] = [];

const noopLogger: LoggerPort = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

describe('DuckDbQueryExecutor safety & workspace confinement', () => {
  it('runs readonly DuckDB EXPLAIN with prepared bind parameters and workspace-confined Parquet paths', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-duckdb-ws-'));
    tempDirs.push(workspace);
    const dbFile = path.join(workspace, 'warehouse.duckdb');
    const parquetFile = path.join(workspace, 'events.parquet');
    await fs.writeFile(dbFile, '', 'utf-8');
    await fs.writeFile(parquetFile, '', 'utf-8');

    const commandRunner = vi.fn().mockResolvedValue({
      stdout: JSON.stringify([
        {
          explain_key: 'physical_plan',
          explain_value: JSON.stringify([
            { name: 'PARQUET_SCAN', extra_info: { File: 'events.parquet' }, children: [] },
          ]),
        },
      ]),
      stderr: '',
    });

    const executor = new DuckDbQueryExecutor(noopLogger, {
      workspaceRoot: workspace,
      commandRunner,
    });

    const result = await executor.executeExplain(`duckdb://${dbFile}`, {
      engine: 'duckdb',
      sql: "SELECT user_id FROM read_parquet('events.parquet') WHERE user_id = $1",
      kind: 'READ',
      mode: 'estimate',
      parameters: [42],
      statementTimeoutMs: 5000,
      allowWriteAnalyze: false,
    });

    expect(Array.isArray(result)).toBe(true);
    expect(commandRunner).toHaveBeenCalledTimes(1);
    const [, args] = commandRunner.mock.calls[0] as [string, string[]];
    expect(args).toContain('-readonly');
    expect(args).toContain('-json');
    expect(args[args.length - 1]).toContain('PREPARE __qa_plan AS');
    expect(args[args.length - 1]).toContain('EXECUTE __qa_plan(42)');
  });

  it('blocks path traversal, symlinks, remote s3:// URLs, write-analyze, and HypoPG', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-duckdb-sec-'));
    tempDirs.push(workspace);
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-duckdb-out-'));
    tempDirs.push(outsideDir);

    const outsideParquet = path.join(outsideDir, 'secret.parquet');
    await fs.writeFile(outsideParquet, '', 'utf-8');
    await fs.symlink(outsideParquet, path.join(workspace, 'escape.parquet'));

    const runner = vi.fn().mockResolvedValue({ stdout: '[]', stderr: '' });
    const executor = new DuckDbQueryExecutor(noopLogger, {
      workspaceRoot: workspace,
      commandRunner: runner,
    });

    await expect(
      executor.executeExplain(':memory:duckdb', {
        engine: 'duckdb',
        sql: "SELECT * FROM read_parquet('../outside/secret.parquet')",
        kind: 'READ',
        mode: 'estimate',
        parameters: [],
        statementTimeoutMs: 5000,
        allowWriteAnalyze: false,
      }),
    ).rejects.toThrow(/outside workspace boundary/i);

    await expect(
      executor.executeExplain(':memory:duckdb', {
        engine: 'duckdb',
        sql: "SELECT * FROM read_parquet('escape.parquet')",
        kind: 'READ',
        mode: 'estimate',
        parameters: [],
        statementTimeoutMs: 5000,
        allowWriteAnalyze: false,
      }),
    ).rejects.toThrow(/symbolic link/i);

    await expect(
      executor.executeExplain(':memory:duckdb', {
        engine: 'duckdb',
        sql: "SELECT * FROM read_parquet('s3://private-bucket/events.parquet')",
        kind: 'READ',
        mode: 'estimate',
        parameters: [],
        statementTimeoutMs: 5000,
        allowWriteAnalyze: false,
      }),
    ).rejects.toThrow(/remote object\/HTTP URL/i);

    await expect(
      executor.executeExplain(':memory:duckdb', {
        engine: 'duckdb',
        sql: 'INSERT INTO events VALUES (1)',
        kind: 'WRITE',
        mode: 'analyze',
        parameters: [],
        statementTimeoutMs: 5000,
        allowWriteAnalyze: false,
      }),
    ).rejects.toThrow(/read-only/i);

    await expect(
      executor.simulateHypotheticalIndex(':memory:duckdb', 'SELECT 1', 'CREATE INDEX i ON t(c)', []),
    ).rejects.toThrow(/PostgreSQL/i);
    expect(runner).not.toHaveBeenCalled();
  });

  it('surfaces an actionable installation hint when DuckDB CLI binary is missing', async () => {
    const enoentErr = Object.assign(new Error('spawn duckdb ENOENT'), {
      code: 'ENOENT',
    });
    const multi = new MultiEngineQueryExecutor(noopLogger, undefined, {
      binaryPath: 'duckdb',
      commandRunner: () => Promise.reject(enoentErr),
    });

    await expect(
      multi.executeExplain(':memory:duckdb', {
        engine: 'duckdb',
        sql: 'SELECT 1',
        kind: 'READ',
        mode: 'estimate',
        parameters: [],
        statementTimeoutMs: 3000,
        allowWriteAnalyze: false,
      }),
    ).rejects.toThrow(/Install DuckDB CLI/i);
    await multi.dispose();
  });
});
