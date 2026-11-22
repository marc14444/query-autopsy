import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ConnectionConfigPort, LoggerPort } from '@query-autopsy/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const vscodeMock = vi.hoisted(() => ({
  showQuickPick: vi.fn(),
  showInputBox: vi.fn(),
  showInformationMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  openTextDocument: vi.fn().mockResolvedValue({}),
  showTextDocument: vi.fn().mockResolvedValue({}),
  clipboardWriteText: vi.fn().mockResolvedValue(undefined),
  workspaceFolders: [] as Array<{ readonly uri: { readonly fsPath: string }; readonly name: string }>,
}));

vi.mock('vscode', () => ({
  Uri: {
    file: (fsPath: string) => ({ scheme: 'file', fsPath, toString: () => `file://${fsPath}` }),
  },
  ViewColumn: { One: 1 },
  env: {
    clipboard: {
      writeText: vscodeMock.clipboardWriteText,
    },
  },
  window: {
    showQuickPick: vscodeMock.showQuickPick,
    showInputBox: vscodeMock.showInputBox,
    showInformationMessage: vscodeMock.showInformationMessage,
    showWarningMessage: vscodeMock.showWarningMessage,
    showErrorMessage: vscodeMock.showErrorMessage,
    showTextDocument: vscodeMock.showTextDocument,
  },
  workspace: {
    get workspaceFolders() {
      return vscodeMock.workspaceFolders;
    },
    asRelativePath: (target: string | { fsPath: string }) =>
      typeof target === 'string' ? path.basename(target) : path.basename(target.fsPath),
    openTextDocument: vscodeMock.openTextDocument,
    getConfiguration: vi.fn(() => ({
      get: (_k: string, fallback: unknown) => fallback,
    })),
  },
}));

import { runConfigureMcpCommand } from '../../src/presentation/vscode/commands/configureMcpCommand.js';

const tempDirs: string[] = [];

const silentLogger: LoggerPort = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function createConnectionConfigMock(env: 'local' | 'production'): ConnectionConfigPort {
  const profile = {
    id: 'p1',
    name: 'App DB',
    engine: 'postgresql' as const,
    environment: env,
    readOnlyLocked: env === 'production',
    displayTarget: '127.0.0.1:5432/app',
  };
  return {
    getConnectionString: async () => 'postgresql://secret_user:topsecret@127.0.0.1:5432/app',
    saveConnectionString: async () => undefined,
    clearConnectionString: async () => undefined,
    getActiveProfile: async () => profile,
    listProfiles: async () => [profile],
    saveProfile: async () => profile,
    setActiveProfile: async () => undefined,
    setProfileReadOnlyLock: async () => undefined,
    deleteProfile: async () => undefined,
    getRuntimeSettings: () => ({
      statementTimeoutMs: 5000,
      allowWriteAnalyze: false,
      seqScanRowThreshold: 1000,
      showRawJson: false,
      redactLiteralsInReports: false,
    }),
  };
}

describe('runConfigureMcpCommand wizard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vscodeMock.workspaceFolders = [];
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  });

  it('writes .vscode/mcp.json with masked ${input:query_autopsy_uri} and NEVER leaks SecretStorage passwords', async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-wizard-'));
    tempDirs.push(ws);
    vscodeMock.workspaceFolders = [{ uri: { fsPath: ws }, name: 'app' }];

    vscodeMock.showQuickPick
      .mockResolvedValueOnce({ client: 'vscode' })
      .mockResolvedValueOnce({ mode: 'estimate' })
      .mockResolvedValueOnce({
        sourceKind: 'vscode-input',
        value: '${input:query_autopsy_uri}',
      });

    const ok = await runConfigureMcpCommand(
      createConnectionConfigMock('local'),
      silentLogger,
    );
    expect(ok).toBe(true);

    const written = await fs.readFile(path.join(ws, '.vscode', 'mcp.json'), 'utf-8');
    expect(written).not.toContain('topsecret');
    expect(written).not.toContain('secret_user');
    expect(written).toContain('${input:query_autopsy_uri}');
    expect(written).not.toContain('--no-redact');
  });

  it('hides --allow-analyze option on production profiles and supports safe preview-only JSON', async () => {
    vscodeMock.showQuickPick
      .mockResolvedValueOnce({ client: 'preview' })
      .mockImplementationOnce(async (items: Array<{ mode: string }>) => {
        expect(items.some((item) => item.mode === 'analyze-local')).toBe(false);
        return items.find((item) => item.mode === 'offline');
      });

    const ok = await runConfigureMcpCommand(
      createConnectionConfigMock('production'),
      silentLogger,
    );
    expect(ok).toBe(true);
    expect(vscodeMock.clipboardWriteText).toHaveBeenCalledTimes(1);
    const snippet = vscodeMock.clipboardWriteText.mock.calls[0]?.[0] as string;
    expect(snippet).toContain('@query-autopsy/mcp');
    expect(vscodeMock.openTextDocument).toHaveBeenCalledWith({
      language: 'json',
      content: snippet,
    });
  });

  it('falls back to editor preview + clipboard instead of overwriting invalid JSON/JSONC MCP files', async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-wizard-jsonc-'));
    tempDirs.push(ws);
    vscodeMock.workspaceFolders = [{ uri: { fsPath: ws }, name: 'app' }];

    const cursorDir = path.join(ws, '.cursor');
    await fs.mkdir(cursorDir, { recursive: true });
    const existingRaw = '// user comment\n{ "mcpServers": {} }\n';
    await fs.writeFile(path.join(cursorDir, 'mcp.json'), existingRaw, 'utf-8');

    vscodeMock.showQuickPick
      .mockResolvedValueOnce({ client: 'cursor' })
      .mockResolvedValueOnce({ mode: 'offline' });

    const ok = await runConfigureMcpCommand(
      createConnectionConfigMock('local'),
      silentLogger,
    );
    expect(ok).toBe(true);
    // Original file preserved untouched!
    expect(await fs.readFile(path.join(cursorDir, 'mcp.json'), 'utf-8')).toBe(existingRaw);
    expect(vscodeMock.showWarningMessage).toHaveBeenCalled();
    expect(vscodeMock.clipboardWriteText).toHaveBeenCalledTimes(1);
  });
});
