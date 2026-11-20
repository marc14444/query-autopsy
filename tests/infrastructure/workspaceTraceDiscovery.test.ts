import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const workspaceState = vi.hoisted(() => ({
  folders: [] as Array<{ readonly uri: { readonly fsPath: string; readonly scheme: string; toString: () => string }; readonly name: string }>,
}));

vi.mock('vscode', () => ({
  Uri: {
    file: (fsPath: string) => ({
      scheme: 'file',
      fsPath,
      toString: () => `file://${fsPath}`,
    }),
  },
  workspace: {
    get workspaceFolders() {
      return workspaceState.folders;
    },
    findFiles: vi.fn().mockResolvedValue([]),
    getWorkspaceFolder: vi.fn(() => undefined),
    asRelativePath: vi.fn((uri: { fsPath: string }) => uri.fsPath),
    fs: {
      stat: vi.fn(),
      readFile: vi.fn(),
    },
  },
}));

import * as vscode from 'vscode';
import {
  readSafeWorkspaceTraceFile,
  resolveSafeWorkspaceSourceTarget,
} from '../../src/infrastructure/vscode/workspaceTraceDiscovery.js';

const tempDirs: string[] = [];

afterEach(async () => {
  workspaceState.folders = [];
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

describe('workspaceTraceDiscovery security & confinement', () => {
  it('reads valid workspace .jsonl traces while blocking symlink escapes, non-JSONL extensions, and oversized files', async () => {
    const workspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qa-trace-ws-'),
    );
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-trace-out-'));
    tempDirs.push(workspaceDir, outsideDir);

    const traceDir = path.join(workspaceDir, '.query-autopsy');
    await fs.mkdir(traceDir, { recursive: true });
    const traceFile = path.join(traceDir, 'traces.jsonl');
    await fs.writeFile(
      traceFile,
      `${JSON.stringify({ sql: 'SELECT 1', requestId: 'r1' })}\n`,
      'utf-8',
    );

    const folderUri = vscode.Uri.file(workspaceDir);
    const loaded = await readSafeWorkspaceTraceFile(
      vscode.Uri.file(traceFile),
      folderUri,
    );
    expect(loaded).toContain('SELECT 1');

    // Non-jsonl rejected
    const envFile = path.join(workspaceDir, '.env');
    await fs.writeFile(envFile, 'SECRET=1', 'utf-8');
    await expect(
      readSafeWorkspaceTraceFile(vscode.Uri.file(envFile), folderUri),
    ).rejects.toThrow('.jsonl or .ndjson');

    // Symlink escape outside workspace rejected
    const outsideJsonl = path.join(outsideDir, 'outside.jsonl');
    await fs.writeFile(outsideJsonl, '{"sql":"SELECT 2"}\n', 'utf-8');
    const escapingLink = path.join(traceDir, 'escape.jsonl');
    await fs.symlink(outsideJsonl, escapingLink);

    await expect(
      readSafeWorkspaceTraceFile(vscode.Uri.file(escapingLink), folderUri),
    ).rejects.toThrow('escapes the workspace folder');

    // Oversized file rejected
    await expect(
      readSafeWorkspaceTraceFile(vscode.Uri.file(traceFile), folderUri, 8),
    ).rejects.toThrow('maximum size limit');
  });

  it('resolves workspace source file:line strictly inside workspace and blocks traversal & symlink escapes', async () => {
    const workspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qa-src-ws-'),
    );
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-src-out-'));
    tempDirs.push(workspaceDir, outsideDir);

    const phpDir = path.join(workspaceDir, 'app', 'Http', 'Controllers');
    await fs.mkdir(phpDir, { recursive: true });
    const controllerPath = path.join(phpDir, 'OrderController.php');
    await fs.writeFile(controllerPath, '<?php\n// line 2\n', 'utf-8');

    const outsideSecret = path.join(outsideDir, 'secret.txt');
    await fs.writeFile(outsideSecret, 'TOP SECRET', 'utf-8');
    const symlinkInWorkspace = path.join(workspaceDir, 'leak.php');
    await fs.symlink(outsideSecret, symlinkInWorkspace);

    const folderUri = vscode.Uri.file(workspaceDir);
    workspaceState.folders = [{ uri: folderUri, name: 'app' }];

    // Valid relative file:line resolves cleanly
    const resolved = await resolveSafeWorkspaceSourceTarget(
      'app/Http/Controllers/OrderController.php',
      42,
      folderUri,
    );
    expect(resolved?.line).toBe(42);
    expect(resolved?.uri.fsPath).toBe(await fs.realpath(controllerPath));

    // Traversal, external absolute path, null byte, and escaping symlink must ALL return undefined
    expect(
      await resolveSafeWorkspaceSourceTarget('../secret.txt', 1, folderUri),
    ).toBeUndefined();
    expect(
      await resolveSafeWorkspaceSourceTarget(outsideSecret, 1, folderUri),
    ).toBeUndefined();
    expect(
      await resolveSafeWorkspaceSourceTarget('leak.php', 1, folderUri),
    ).toBeUndefined();
    expect(
      await resolveSafeWorkspaceSourceTarget('app\0/Order.php', 1, folderUri),
    ).toBeUndefined();
  });
});
