import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  analyzeQueryTraces,
  parseQueryTraceStream,
} from '@query-autopsy/core';
import { type CliIo, runCli } from '@query-autopsy/cli';
import { McpFirewallServer } from '@query-autopsy/mcp';
import {
  attachPrismaTracing,
  createDrizzleLogger,
  createExpressTraceMiddleware,
  createTypeOrmLogger,
  JsonlTraceRecorder,
  normalizeTraceEngine,
  shouldEnableTraceRecording,
} from '@query-autopsy/trace';
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

describe('@query-autopsy/trace Node.js / TypeScript ORM bridge', () => {
  it('blocks production environments by default and respects explicit toggles', () => {
    expect(shouldEnableTraceRecording(undefined, { NODE_ENV: 'production' })).toBe(
      false,
    );
    expect(shouldEnableTraceRecording(undefined, { APP_ENV: 'production' })).toBe(
      false,
    );
    expect(shouldEnableTraceRecording(undefined, { NODE_ENV: 'development' })).toBe(
      true,
    );
    expect(shouldEnableTraceRecording(undefined, { APP_ENV: 'local' })).toBe(true);
    expect(
      shouldEnableTraceRecording(
        { allowProduction: true },
        { NODE_ENV: 'production' },
      ),
    ).toBe(true);
    expect(
      shouldEnableTraceRecording(
        { enabled: false },
        { NODE_ENV: 'development' },
      ),
    ).toBe(false);
    expect(
      shouldEnableTraceRecording(undefined, {
        NODE_ENV: 'development',
        QUERY_AUTOPSY_ENABLED: '0',
      }),
    ).toBe(false);

    expect(normalizeTraceEngine('pg')).toBe('postgresql');
    expect(normalizeTraceEngine('mariadb')).toBe('mysql');
    expect(normalizeTraceEngine('better-sqlite3')).toBe('sqlite');
    expect(normalizeTraceEngine('unknown-db')).toBeUndefined();
  });

  it('captures Prisma, Drizzle, and TypeORM queries with PII scrubbing, AsyncLocalStorage isolation, and CLI/MCP ingestion', async () => {
    const workspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'query-autopsy-node-bridge-'),
    );
    tempDirs.push(workspaceDir);

    const recorder = new JsonlTraceRecorder({
      workspaceRoot: workspaceDir,
      currentEnvironment: 'local',
      defaultEngine: 'postgresql',
    });

    // 1. Prisma hook ($on('query'))
    let prismaHandler: ((event: { query: string; params?: string; duration?: number }) => void) | undefined;
    attachPrismaTracing(
      {
        $on: (_event, cb) => {
          prismaHandler = cb;
        },
      },
      recorder,
    );

    // 2. Express middleware isolation + auto flush on finish
    const middleware = createExpressTraceMiddleware(recorder);
    const res = new EventEmitter();
    middleware(
      { headers: { 'x-request-id': 'express-req-101' } },
      res as unknown as { on(event: 'finish' | 'close', listener: () => void): void },
      () => {
        for (let i = 0; i < 4; i++) {
          prismaHandler?.({
            query: "SELECT * FROM \"orders\" WHERE \"user_id\" = $1 AND \"email\" = 'secret@example.com'",
            params: JSON.stringify([i + 1, 'secret@example.com']),
            duration: 5.5,
          });
        }
      },
    );
    res.emit('finish');
    await recorder.flush();

    // 3. Drizzle + TypeORM loggers inside manual runWithRequest scope
    const drizzle = createDrizzleLogger(recorder, { engine: 'mysql' });
    const typeorm = createTypeOrmLogger(recorder, { engine: 'postgresql' });

    await recorder.runWithRequest('orm-batch-2', async () => {
      drizzle.logQuery("SELECT * FROM invoices WHERE token = 'tok_live_123'", [
        'tok_live_123',
      ]);
      // Migration noise is automatically ignored
      typeorm.logQuery('SELECT * FROM "typeorm_metadata"');
      typeorm.logQuerySlow(
        350.4,
        "SELECT count(*) FROM audit_logs WHERE note = 'pii-note'",
        ['pii-note'],
      );
      await recorder.flush();
    });

    const tracePath = recorder.getTracePath();
    const gitignorePath = path.join(workspaceDir, '.query-autopsy', '.gitignore');
    const [rawTrace, rawGitignore] = await Promise.all([
      fs.readFile(tracePath, 'utf-8'),
      fs.readFile(gitignorePath, 'utf-8'),
    ]);

    expect(rawGitignore).toContain('*.jsonl');

    const parsed = parseQueryTraceStream(rawTrace);
    expect(parsed.entries).toHaveLength(6);
    expect(parsed.skippedLines).toBe(0);
    expect(rawTrace).not.toContain('secret@example.com');
    expect(rawTrace).not.toContain('tok_live_123');
    expect(rawTrace).not.toContain('pii-note');
    expect(rawTrace).not.toContain('typeorm_metadata');

    for (const entry of parsed.entries) {
      expect(entry.bindings).toEqual([]);
    }

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
      stdout: (chunk) => {
        cliStdout += chunk;
      },
      stderr: () => undefined,
      env: {},
    };
    const exitCode = await runCli(
      ['trace', '--file', tracePath, '--fail-on', 'warning', '--format', 'json'],
      cliIo,
    );
    expect(exitCode).toBe(2);
    expect(cliStdout).toContain('N_PLUS_ONE_BURST');

    const firewall = new McpFirewallServer({ workspaceRoot: workspaceDir });
    const mcpResult = await firewall.callTool('autopsy_analyze_traces', {});
    expect(mcpResult.isError).toBeUndefined();
    const structured = mcpResult.structuredContent as {
      diagnostics: Array<{ ruleId: string }>;
    };
    expect(structured.diagnostics.some((d) => d.ruleId === 'N_PLUS_ONE_BURST')).toBe(
      true,
    );
  });

  it('refuses symlink trace destinations and rotates logs at maxTraceBytes', async () => {
    const workspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'query-autopsy-node-guard-'),
    );
    tempDirs.push(workspaceDir);

    const traceDir = path.join(workspaceDir, '.query-autopsy');
    await fs.mkdir(traceDir, { recursive: true });
    const outsideFile = path.join(workspaceDir, 'outside.jsonl');
    await fs.writeFile(outsideFile, '', 'utf-8');
    await fs.symlink(outsideFile, path.join(traceDir, 'traces.jsonl'));

    const symlinkRecorder = new JsonlTraceRecorder({
      workspaceRoot: workspaceDir,
      currentEnvironment: 'local',
    });
    symlinkRecorder.record({ sql: 'SELECT 1' });
    await expect(symlinkRecorder.flush()).rejects.toThrow(/symlink/i);

    await fs.unlink(path.join(traceDir, 'traces.jsonl'));
    const rotRecorder = new JsonlTraceRecorder({
      workspaceRoot: workspaceDir,
      currentEnvironment: 'local',
      maxTraceBytes: 4096,
    });
    for (let i = 0; i < 40; i++) {
      rotRecorder.record({ sql: `SELECT id, payload FROM items WHERE id = ${i}` });
    }
    await rotRecorder.flush();
    for (let i = 0; i < 40; i++) {
      rotRecorder.record({
        sql: `SELECT id, payload FROM items WHERE id = ${i + 100}`,
      });
    }
    await rotRecorder.flush();

    const rotatedStat = await fs.stat(path.join(traceDir, 'traces.jsonl.1'));
    const activeStat = await fs.stat(path.join(traceDir, 'traces.jsonl'));
    expect(rotatedStat.size).toBeGreaterThanOrEqual(4096);
    expect(activeStat.size).toBeGreaterThan(0);
  });
});
