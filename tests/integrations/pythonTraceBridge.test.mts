import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  analyzeQueryTraces,
  parseQueryTraceStream,
} from '@query-autopsy/core';
import { type CliIo, runCli } from '@query-autopsy/cli';
import { McpFirewallServer } from '@query-autopsy/mcp';
import { afterEach, describe, expect, it } from 'vitest';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

describe('Python Django & SQLAlchemy Bridge package contract & trace interoperability', () => {
  it('ships valid zero-dependency pyproject metadata and production guardrails', async () => {
    const pyproject = await fs.readFile(
      path.join(process.cwd(), 'packages', 'python', 'pyproject.toml'),
      'utf-8',
    );
    expect(pyproject).toContain('name = "query-autopsy-trace"');
    expect(pyproject).toContain('requires-python = ">=3.9"');
    expect(pyproject).toContain('dependencies = []');

    const guardPy = await fs.readFile(
      path.join(
        process.cwd(),
        'packages',
        'python',
        'src',
        'query_autopsy_trace',
        'guard.py',
      ),
      'utf-8',
    );
    expect(guardPy).toContain('DJANGO_ENV');
    expect(guardPy).toContain('APP_ENV');
    expect(guardPy).toContain('allow_production');
    expect(guardPy).toContain('"production", "prod"');

    const djangoPy = await fs.readFile(
      path.join(
        process.cwd(),
        'packages',
        'python',
        'src',
        'query_autopsy_trace',
        'django_bridge.py',
      ),
      'utf-8',
    );
    expect(djangoPy).toContain('QueryAutopsyDjangoMiddleware');
    expect(djangoPy).toContain('execute_wrapper');

    const saPy = await fs.readFile(
      path.join(
        process.cwd(),
        'packages',
        'python',
        'src',
        'query_autopsy_trace',
        'sqlalchemy_bridge.py',
      ),
      'utf-8',
    );
    expect(saPy).toContain('attach_sqlalchemy_tracing');
    expect(saPy).toContain('before_cursor_execute');
    expect(saPy).toContain('after_cursor_execute');
  });

  it('ingests Python-emitted .query-autopsy/traces.jsonl into @query-autopsy/core, CLI, and MCP Firewall', async () => {
    const workspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'query-autopsy-python-bridge-'),
    );
    tempDirs.push(workspaceDir);

    const traceDir = path.join(workspaceDir, '.query-autopsy');
    await fs.mkdir(traceDir, { recursive: true });
    const traceFile = path.join(traceDir, 'traces.jsonl');

    // Exact JSONL structure produced by query_autopsy_trace.JsonlTraceWriter
    const pythonLines = [
      ...Array.from({ length: 5 }, (_, idx) =>
        JSON.stringify({
          timestamp: `2026-11-22T02:10:0${idx}.250Z`,
          engine: 'postgresql',
          sql: "SELECT \"app_order\".\"id\", \"app_order\".\"total\" FROM \"app_order\" WHERE \"app_order\".\"user_id\" = %s AND \"app_order\".\"tag\" = '[REDACTED]'",
          bindings: [],
          requestId: 'py-django-req-42',
          durationMs: 4.125,
          file: 'shop/views.py',
          line: 88,
        }),
      ),
      JSON.stringify({
        timestamp: '2026-11-22T02:10:06.100Z',
        engine: 'postgresql',
        sql: "SELECT count(*) FROM audit_events WHERE actor_email = '[REDACTED]'",
        bindings: [],
        requestId: 'py-sqlalchemy-req-7',
        durationMs: 412.5,
        file: 'workers/reporting.py',
        line: 37,
      }),
    ].join('\n');

    await fs.writeFile(traceFile, `${pythonLines}\n`, 'utf-8');

    const parsed = parseQueryTraceStream(pythonLines);
    expect(parsed.entries).toHaveLength(6);
    expect(parsed.skippedLines).toBe(0);

    const analysis = analyzeQueryTraces(parsed.entries, {
      nPlusOneWarningThreshold: 3,
      slowQueryMsThreshold: 200,
    });
    expect(analysis.diagnostics.some((d) => d.ruleId === 'N_PLUS_ONE_BURST')).toBe(
      true,
    );
    expect(analysis.diagnostics.some((d) => d.ruleId === 'SLOW_TRACE_QUERY')).toBe(
      true,
    );

    let cliStdout = '';
    const cliIo: CliIo = {
      readStdin: async () => '',
      stdout: (text) => {
        cliStdout += text;
      },
      stderr: () => undefined,
      env: {},
    };
    const exitCode = await runCli(
      ['trace', '--file', traceFile, '--fail-on', 'warning', '--format', 'json'],
      cliIo,
    );
    expect(exitCode).toBe(2);
    expect(cliStdout).toContain('N_PLUS_ONE_BURST');
    expect(cliStdout).toContain('shop/views.py');

    const firewall = new McpFirewallServer({ workspaceRoot: workspaceDir });
    const mcpResult = await firewall.callTool('autopsy_analyze_traces', {});
    expect(mcpResult.isError).toBeUndefined();
    const mcpPayload = mcpResult.structuredContent as {
      diagnostics: Array<{ ruleId: string; file?: string }>;
    };
    expect(
      mcpPayload.diagnostics.some(
        (d) => d.ruleId === 'N_PLUS_ONE_BURST' && d.file === 'shop/views.py',
      ),
    ).toBe(true);
  });
});
