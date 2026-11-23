import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { UnsafeQueryError } from '@query-autopsy/core';
import {
  type CliIo,
  formatSarifReports,
  runCli,
  severityMeetsThreshold,
} from '@query-autopsy/cli';
import { afterEach, describe, expect, it, vi } from 'vitest';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

function createTestIo(options?: {
  stdin?: string;
  env?: Record<string, string | undefined>;
  rawPlan?: unknown;
  throwError?: Error;
}) {
  let stdout = '';
  let stderr = '';

  const io: CliIo = {
    readStdin: async () => options?.stdin ?? '',
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    env: options?.env ?? {},
    createExecutor: () => ({
      executeExplain: options?.throwError
        ? vi.fn().mockRejectedValue(options.throwError)
        : vi.fn().mockResolvedValue(
            options?.rawPlan ?? [
              {
                Plan: {
                  'Node Type': 'Seq Scan',
                  'Relation Name': 'orders',
                  'Startup Cost': 0,
                  'Total Cost': 2500,
                  'Plan Rows': 100000,
                  'Plan Width': 32,
                  Filter: "(email = 'alice@corp.com'::text)",
                },
              },
            ],
          ),
      executeCreateIndex: vi.fn(),
      simulateHypotheticalIndex: vi.fn(),
      testConnection: vi.fn(),
      dispose: vi.fn().mockResolvedValue(undefined),
    }),
  };

  return {
    io,
    getStdout: () => stdout,
    getStderr: () => stderr,
  };
}

describe('@query-autopsy/cli', () => {
  it('runs offline static safety checks (`check`) across SQL strings and files', async () => {
    const safeIo = createTestIo();
    const safeCode = await runCli(
      ['check', '--sql', "SELECT ';not-split', id FROM orders WHERE user_id = 42;"],
      safeIo.io,
    );
    expect(safeCode).toBe(0);
    expect(safeIo.getStdout()).toContain('1 statement(s) passed safety checks');

    const unsafeIo = createTestIo();
    const unsafeCode = await runCli(
      ['check', '--sql', "SELECT pg_read_file('/etc/passwd');", '--format', 'json'],
      unsafeIo.io,
    );
    expect(unsafeCode).toBe(2);
    const parsed = JSON.parse(unsafeIo.getStdout()) as {
      passed: boolean;
      failures: unknown[];
    };
    expect(parsed.passed).toBe(false);
    expect(parsed.failures).toHaveLength(1);
  });

  it('inspects SQL via `--stdin` (`explain`), redacts PII literals when `--redact` is set, and gates exit code via `--fail-on`', async () => {
    const { io, getStdout, getStderr } = createTestIo({
      stdin: "SELECT id FROM orders WHERE email = 'alice@corp.com';",
      env: { QUERY_AUTOPSY_URI: 'postgresql://postgres@127.0.0.1:5432/app' },
    });

    const code = await runCli(
      ['explain', '--stdin', '--redact', '--fail-on', 'critical', '--format', 'markdown'],
      io,
    );

    expect(code).toBe(2);
    expect(getStderr()).toBe('');
    expect(getStdout()).toContain('Sequential Scan on "orders"');
    expect(getStdout()).not.toContain('alice@corp.com');
    expect(getStdout()).toContain("'[REDACTED]'");
  });

  it('scans a directory in `ci` mode, emits valid SARIF 2.1.0 output, and skips parameterized queries', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'query-autopsy-cli-ci-'));
    tempDirs.push(dir);
    await fs.writeFile(
      path.join(dir, 'queries.sql'),
      [
        'SELECT id FROM orders WHERE status = \'pending\';',
        'SELECT id FROM orders WHERE user_id = $1;',
      ].join('\n'),
      'utf-8',
    );

    const { io, getStdout } = createTestIo({
      env: { DATABASE_URL: 'postgresql://postgres@127.0.0.1:5432/app' },
    });

    const code = await runCli(
      ['ci', '--dir', dir, '--format', 'sarif', '--fail-on', 'critical'],
      io,
    );
    expect(code).toBe(2);

    const sarif = JSON.parse(getStdout()) as {
      version: string;
      runs: Array<{
        tool: { driver: { name: string; rules: unknown[] } };
        results: Array<{ ruleId: string; level: string }>;
      }>;
    };
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs[0]?.tool.driver.name).toBe('QueryAutopsy');
    expect(sarif.runs[0]?.results).toHaveLength(1);
    expect(sarif.runs[0]?.results[0]?.ruleId).toBe('SEQ_SCAN_LARGE_TABLE');
    expect(sarif.runs[0]?.results[0]?.level).toBe('error');
  });

  it('sanitizes domain error payloads on stderr when `--redact` is active', async () => {
    const { io, getStderr } = createTestIo({
      env: { QUERY_AUTOPSY_URI: 'postgresql://postgres@127.0.0.1:5432/app' },
      throwError: new UnsafeQueryError(
        'Blocked query detail: Key (email)=(alice@corp.com) failed for \'secret_val\'',
      ),
    });

    const code = await runCli(
      ['explain', '--sql', 'SELECT 1', '--redact'],
      io,
    );
    expect(code).toBe(1);
    expect(getStderr()).not.toContain('alice@corp.com');
    expect(getStderr()).not.toContain('secret_val');
    expect(getStderr()).toContain('[REDACTED]');
  });

  it('evaluates threshold and SARIF helpers accurately', () => {
    expect(
      severityMeetsThreshold(
        [
          {
            ruleId: 'SEQ_SCAN_LARGE_TABLE',
            severity: 'warning',
            nodeId: '0',
            nodeType: 'Seq Scan',
            title: 'warn',
            detail: 'detail',
            recommendation: 'rec',
          },
        ],
        'critical',
      ),
    ).toBe(false);

    expect(
      severityMeetsThreshold(
        [
          {
            ruleId: 'SEQ_SCAN_LARGE_TABLE',
            severity: 'warning',
            nodeId: '0',
            nodeType: 'Seq Scan',
            title: 'warn',
            detail: 'detail',
            recommendation: 'rec',
          },
        ],
        'warning',
      ),
    ).toBe(true);

    const emptySarif = formatSarifReports([]);
    expect(emptySarif['version']).toBe('2.1.0');
  });

  it('executes real SQLite WASM inspection end-to-end without mocks', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'query-autopsy-cli-sq-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'app.sqlite');
    const { default: initSqlJs } = await import('sql.js');
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
    db.run('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT);');
    db.run("INSERT INTO users (email) VALUES ('alice@example.com');");
    await fs.writeFile(dbPath, db.export());
    db.close();

    let stdout = '';
    let stderr = '';
    const realIo: CliIo = {
      readStdin: async () => '',
      stdout: (t) => {
        stdout += t;
      },
      stderr: (t) => {
        stderr += t;
      },
      env: {},
    };

    const code = await runCli(
      [
        'explain',
        '--uri',
        `sqlite://${dbPath}`,
        '--sql',
        "SELECT id FROM users WHERE email = 'alice@example.com';",
        '--mode',
        'analyze',
        '--redact',
        '--fail-on',
        'warning',
        '--format',
        'json',
      ],
      realIo,
    );

    expect(stderr).toBe('');
    expect(code).toBe(2);
    const parsed = JSON.parse(stdout) as {
      engine: string;
      sql: string;
      diagnostics: Array<{ ruleId: string }>;
    };
    expect(parsed.engine).toBe('sqlite');
    expect(parsed.sql).not.toContain('alice@example.com');
    expect(parsed.diagnostics[0]?.ruleId).toBe('SQLITE_FULL_TABLE_SCAN');
  });

  it('analyzes .jsonl traces via `trace`, runs EXPLAIN on top offenders against SQLite, and emits SARIF', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'query-autopsy-cli-trace-'));
    tempDirs.push(dir);

    // Prepare real SQLite DB
    const dbPath = path.join(dir, 'trace.sqlite');
    const { default: initSqlJs } = await import('sql.js');
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
    db.run('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT);');
    db.run("INSERT INTO users (email) VALUES ('alice@example.com');");
    await fs.writeFile(dbPath, db.export());
    db.close();

    const traceFile = path.join(dir, 'traces.jsonl');
    const traceLines = [
      JSON.stringify({
        engine: 'sqlite',
        sql: "SELECT id FROM users WHERE email = 'secret1@corp.com'",
        durationMs: 8.5,
        requestId: 'req-42',
        file: 'app/Http/Controllers/UsersController.php',
        line: 24,
      }),
      JSON.stringify({
        engine: 'sqlite',
        sql: "SELECT id FROM users WHERE email = 'secret2@corp.com'",
        durationMs: 9.2,
        requestId: 'req-42',
        file: 'app/Http/Controllers/UsersController.php',
        line: 24,
      }),
      JSON.stringify({
        engine: 'sqlite',
        sql: "SELECT id FROM users WHERE email = 'secret3@corp.com'",
        durationMs: 7.1,
        requestId: 'req-42',
        file: 'app/Http/Controllers/UsersController.php',
        line: 24,
      }),
    ].join('\n');
    await fs.writeFile(traceFile, traceLines, 'utf-8');

    // Run JSON output offline check with --redact
    const offlineIo = createTestIo();
    const jsonCode = await runCli(
      [
        'trace',
        '--file',
        traceFile,
        '--threshold-n1',
        '3',
        '--redact',
        '--fail-on',
        'warning',
        '--format',
        'json',
      ],
      offlineIo.io,
    );
    expect(jsonCode).toBe(2);
    const jsonOut = JSON.parse(offlineIo.getStdout()) as {
      analysis: {
        diagnostics: Array<{ ruleId: string; sampleSql: string }>;
      };
    };
    expect(jsonOut.analysis.diagnostics[0]?.ruleId).toBe('N_PLUS_ONE_BURST');
    expect(jsonOut.analysis.diagnostics[0]?.sampleSql).not.toContain('secret1@corp.com');
    expect(jsonOut.analysis.diagnostics[0]?.sampleSql).toContain('[REDACTED]');

    // Run SARIF + --explain-top 1 against real SQLite WASM
    let sarifStdout = '';
    const realIo: CliIo = {
      readStdin: async () => '',
      stdout: (t) => {
        sarifStdout += t;
      },
      stderr: () => undefined,
      env: {},
    };
    const sarifCode = await runCli(
      [
        'trace',
        '--file',
        traceFile,
        '--explain-top',
        '1',
        '--uri',
        `sqlite://${dbPath}`,
        '--redact',
        '--fail-on',
        'warning',
        '--format',
        'sarif',
      ],
      realIo,
    );
    expect(sarifCode).toBe(2);
    const sarif = JSON.parse(sarifStdout) as {
      version: string;
      runs: Array<{ results: Array<{ ruleId: string }> }>;
    };
    expect(sarif.version).toBe('2.1.0');
    const ruleIds = sarif.runs[0]?.results.map((r) => r.ruleId) ?? [];
    expect(ruleIds).toContain('N_PLUS_ONE_BURST');
    expect(ruleIds).toContain('SQLITE_FULL_TABLE_SCAN');

    // Verify CLI `check` extracts and checks PHP files
    const phpFile = path.join(dir, 'repo.php');
    await fs.writeFile(
      phpFile,
      `<?php DB::select('SELECT id FROM users WHERE email = ?', ['a@b.com']);`,
      'utf-8',
    );
    const phpIo = createTestIo();
    const phpCode = await runCli(
      ['check', '--file', phpFile, '--engine', 'mysql', '--format', 'json'],
      phpIo.io,
    );
    expect(phpCode).toBe(0);
    const phpCheck = JSON.parse(phpIo.getStdout()) as { checkedCount: number; passed: boolean };
    expect(phpCheck.checkedCount).toBe(1);
    expect(phpCheck.passed).toBe(true);

    // Verify CLI `check` handles dbt Jinja models & .ipynb notebooks and rejects invalid --profile
    const dbtFile = path.join(dir, 'fct_orders.sql');
    await fs.writeFile(
      dbtFile,
      [
        "{{ config(materialized='table') }}",
        "SELECT id, user_id FROM {{ ref('stg_orders') }} WHERE status = 'paid';",
      ].join('\n'),
      'utf-8',
    );
    const nbFile = path.join(dir, 'exploration.ipynb');
    await fs.writeFile(
      nbFile,
      JSON.stringify({
        cells: [
          {
            cell_type: 'code',
            source: ['%%sql\n', 'SELECT count(*) FROM stg_orders;\n'],
          },
        ],
      }),
      'utf-8',
    );
    const analyticsIo = createTestIo();
    const analyticsCheckCode = await runCli(
      ['check', '--file', nbFile, '--format', 'json'],
      analyticsIo.io,
    );
    expect(analyticsCheckCode).toBe(0);
    const nbParsed = JSON.parse(analyticsIo.getStdout()) as {
      checkedCount: number;
      passed: boolean;
    };
    expect(nbParsed.checkedCount).toBe(1);
    expect(nbParsed.passed).toBe(true);

    const dbtIo = createTestIo();
    const dbtCode = await runCli(
      ['check', '--file', dbtFile, '--format', 'json'],
      dbtIo.io,
    );
    expect(dbtCode).toBe(0);

    const badProfileIo = createTestIo();
    const badProfileCode = await runCli(
      ['check', '--sql', 'SELECT 1', '--profile', 'invalid_profile'],
      badProfileIo.io,
    );
    expect(badProfileCode).toBe(1);
    expect(badProfileIo.getStderr()).toContain('Invalid --profile');
  });
});
