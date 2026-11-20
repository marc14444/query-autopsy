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

describe('Laravel Composer Bridge package contract & trace interoperability', () => {
  it('ships valid Composer auto-discovery metadata and zero-production-impact PHP config defaults', async () => {
    const composerRaw = await fs.readFile(
      path.join(process.cwd(), 'packages', 'laravel', 'composer.json'),
      'utf-8',
    );
    const composer = JSON.parse(composerRaw) as {
      name: string;
      require: Record<string, string>;
      autoload: { 'psr-4': Record<string, string> };
      extra: { laravel: { providers: string[] } };
    };

    expect(composer.name).toBe('marc14444/laravel-query-autopsy');
    expect(composer.require['php']).toBe('^8.1');
    expect(composer.require['illuminate/support']).toBe('^10.0|^11.0|^12.0');
    expect(composer.require['illuminate/database']).toBe('^10.0|^11.0|^12.0');
    expect(composer.require['illuminate/console']).toBe('^10.0|^11.0|^12.0');
    expect(composer.autoload['psr-4']['QueryAutopsy\\Laravel\\']).toBe('src/');
    expect(composer.extra.laravel.providers).toEqual([
      'QueryAutopsy\\Laravel\\QueryAutopsyServiceProvider',
    ]);

    const configPhp = await fs.readFile(
      path.join(process.cwd(), 'packages', 'laravel', 'config', 'query-autopsy.php'),
      'utf-8',
    );
    expect(configPhp).toContain("'allowed_environments' => ['local', 'testing']");
    expect(configPhp).toContain("'allow_production' => false");
    expect(configPhp).toContain('QUERY_AUTOPSY_REDACT_BINDINGS');

    const serviceProviderPhp = await fs.readFile(
      path.join(
        process.cwd(),
        'packages',
        'laravel',
        'src',
        'QueryAutopsyServiceProvider.php',
      ),
      'utf-8',
    );
    expect(serviceProviderPhp).toContain('EnvironmentGuard::shouldEnable');
    expect(serviceProviderPhp).toContain("afterResolving('db'");
  });

  it('ingests Laravel-emitted .query-autopsy/traces.jsonl seamlessly into @query-autopsy/core, CLI, and MCP Firewall', async () => {
    const workspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'query-autopsy-laravel-bridge-'),
    );
    tempDirs.push(workspaceDir);

    const traceDir = path.join(workspaceDir, '.query-autopsy');
    await fs.mkdir(traceDir, { recursive: true });
    const traceFile = path.join(traceDir, 'traces.jsonl');

    // Exact JSONL structure produced by QueryAutopsy\Laravel\Trace\JsonlTraceWriter
    const laravelLines = [
      ...Array.from({ length: 5 }, (_, idx) =>
        JSON.stringify({
          timestamp: `2026-11-20T12:30:0${idx}.120Z`,
          sql: "SELECT * FROM `order_items` WHERE `order_id` = ? AND `note` = '[REDACTED]'",
          bindings: [],
          durationMs: 3.25,
          requestId: 'req-a1b2c3d4e5f60718',
          engine: 'mysql',
          file: 'app/Http/Controllers/CheckoutController.php',
          line: 54,
        }),
      ),
      JSON.stringify({
        timestamp: '2026-11-20T12:30:06.010Z',
        sql: "SELECT count(*) FROM `audit_logs` WHERE `actor_email` = '[REDACTED]'",
        bindings: [],
        durationMs: 345.8,
        requestId: 'req-a1b2c3d4e5f60718',
        engine: 'mysql',
        file: 'app/Jobs/ExportOrdersJob.php',
        line: 31,
      }),
    ].join('\n');

    await fs.writeFile(traceFile, `${laravelLines}\n`, 'utf-8');

    const parsed = parseQueryTraceStream(laravelLines);
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
      stdout: (t) => {
        cliStdout += t;
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
    expect(cliStdout).toContain('CheckoutController.php');

    const firewall = new McpFirewallServer({ workspaceRoot: workspaceDir });
    const mcpResult = await firewall.callTool('autopsy_analyze_traces', {});
    expect(mcpResult.isError).toBeUndefined();
    const mcpPayload = mcpResult.structuredContent as {
      diagnostics: Array<{ ruleId: string; file?: string }>;
    };
    expect(
      mcpPayload.diagnostics.some(
        (d) =>
          d.ruleId === 'N_PLUS_ONE_BURST' &&
          d.file === 'app/Http/Controllers/CheckoutController.php',
      ),
    ).toBe(true);
  });
});
