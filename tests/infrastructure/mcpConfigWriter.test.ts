import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { UnsafeQueryError } from '@query-autopsy/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  McpConfigParseError,
  mergeMcpConfigJson,
  resolveMcpTargetPath,
  writeSafeMcpConfigFile,
} from '../../src/infrastructure/vscode/mcpConfigWriter.js';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

describe('mcpConfigWriter', () => {
  it('generates VS Code .vscode/mcp.json with masked ${input:query_autopsy_uri} and preserves existing servers', () => {
    const existing = JSON.stringify(
      {
        servers: {
          github: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
        },
        inputs: [
          { id: 'github_pat', type: 'promptString', password: true },
        ],
      },
      null,
      2,
    );

    const merged = mergeMcpConfigJson(existing, {
      client: 'vscode',
      mode: 'estimate',
      engine: 'postgresql',
      environment: 'staging',
      dsnValue: '${input:query_autopsy_uri}',
    });

    const parsed = JSON.parse(merged) as {
      servers: Record<string, { type?: string; command: string; args: string[]; env?: Record<string, string> }>;
      inputs: Array<{ id: string; password?: boolean }>;
    };

    expect(parsed.servers['github']).toBeDefined();
    expect(parsed.servers['query-autopsy']).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@query-autopsy/mcp', '--env', 'staging', '--engine', 'postgresql'],
      env: { QUERY_AUTOPSY_URI: '${input:query_autopsy_uri}' },
    });
    expect(parsed.inputs.map((i) => i.id)).toEqual([
      'github_pat',
      'query_autopsy_uri',
    ]);
    expect(parsed.inputs[1]?.password).toBe(true);
  });

  it('builds Antigravity, Cursor, Claude Code, and Windsurf configs cleanly and merges mcpServers', () => {
    const existing = JSON.stringify({
      mcpServers: {
        existingTool: { command: 'node', args: ['server.js'] },
      },
    });

    const merged = mergeMcpConfigJson(existing, {
      client: 'cursor',
      mode: 'analyze-local',
      engine: 'mysql',
      environment: 'local',
      dsnValue: '${QUERY_AUTOPSY_URI}',
    });

    const parsed = JSON.parse(merged) as {
      mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
    };

    expect(parsed.mcpServers['existingTool']).toBeDefined();
    expect(parsed.mcpServers['query-autopsy']).toEqual({
      command: 'npx',
      args: ['-y', '@query-autopsy/mcp', '--env', 'local', '--allow-analyze', '--engine', 'mysql'],
      env: { QUERY_AUTOPSY_URI: '${QUERY_AUTOPSY_URI}' },
    });

    const offline = mergeMcpConfigJson(undefined, {
      client: 'claude-code',
      mode: 'offline',
    });
    const parsedOffline = JSON.parse(offline) as {
      mcpServers: Record<string, { args: string[]; env?: unknown }>;
    };
    expect(parsedOffline.mcpServers['query-autopsy']?.args).toEqual([
      '-y',
      '@query-autopsy/mcp',
    ]);
    expect(parsedOffline.mcpServers['query-autopsy']?.env).toBeUndefined();

    expect(resolveMcpTargetPath('antigravity', undefined, '/home/dev')).toBe(
      path.join('/home/dev', '.gemini', 'antigravity', 'mcp_config.json'),
    );
    expect(resolveMcpTargetPath('windsurf', undefined, '/home/dev')).toBe(
      path.join('/home/dev', '.codeium', 'windsurf', 'mcp_config.json'),
    );
  });

  it('enforces Zero-Trust guardrails against plaintext workspace passwords, production analyze, invalid JSON, and symlinks', async () => {
    expect(() =>
      mergeMcpConfigJson(undefined, {
        client: 'cursor',
        mode: 'estimate',
        dsnValue: 'postgresql://postgres:supersecret@127.0.0.1:5432/app',
      }),
    ).toThrow(UnsafeQueryError);

    expect(() =>
      mergeMcpConfigJson(undefined, {
        client: 'vscode',
        mode: 'estimate',
        dsnValue: 'postgresql://user@127.0.0.1:5432/app?password=secret',
      }),
    ).toThrow(UnsafeQueryError);

    expect(() =>
      mergeMcpConfigJson(undefined, {
        client: 'antigravity',
        mode: 'analyze-local',
        environment: 'production',
        dsnValue: '${QUERY_AUTOPSY_URI}',
      }),
    ).toThrow(UnsafeQueryError);

    expect(() =>
      mergeMcpConfigJson('{ // invalid json comment', {
        client: 'vscode',
        mode: 'offline',
      }),
    ).toThrow(McpConfigParseError);

    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-mcp-ws-'));
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-mcp-out-'));
    tempDirs.push(workspaceDir, outsideDir);

    const target = resolveMcpTargetPath('vscode', workspaceDir);
    const firstWrite = await writeSafeMcpConfigFile(
      target,
      {
        client: 'vscode',
        mode: 'estimate',
        dsnValue: '${input:query_autopsy_uri}',
      },
      workspaceDir,
    );
    expect(firstWrite.created).toBe(true);
    expect(await fs.readFile(target, 'utf-8')).toContain('query_autopsy_uri');

    // Second write detects existing file (created: false)
    const secondWrite = await writeSafeMcpConfigFile(
      target,
      {
        client: 'vscode',
        mode: 'offline',
      },
      workspaceDir,
    );
    expect(secondWrite.created).toBe(false);

    // Block symlink target attack inside workspace
    const outsideTarget = path.join(outsideDir, 'evil.json');
    await fs.writeFile(outsideTarget, '{}', 'utf-8');
    const symlinkTarget = path.join(workspaceDir, '.mcp.json');
    await fs.symlink(outsideTarget, symlinkTarget);

    await expect(
      writeSafeMcpConfigFile(
        symlinkTarget,
        { client: 'claude-code', mode: 'offline' },
        workspaceDir,
      ),
    ).rejects.toThrow(UnsafeQueryError);
  });
});
