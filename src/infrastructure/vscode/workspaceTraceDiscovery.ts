import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

export const TRACE_GLOB = '**/.query-autopsy/*.{jsonl,ndjson}';
export const TRACE_EXCLUDE_GLOB = '**/{node_modules,.git,dist,vendor}/**';
export const MAX_TRACE_FILE_BYTES = 10 * 1024 * 1024;

export interface DiscoveredTraceFile {
  readonly uri: vscode.Uri;
  readonly relativePath: string;
  readonly folderUri: vscode.Uri;
  readonly folderName: string;
}

export interface ResolvedTraceSourceTarget {
  readonly uri: vscode.Uri;
  readonly line: number;
}

function isStrictlyInsideDirectory(rootReal: string, candidateReal: string): boolean {
  const rel = path.relative(rootReal, candidateReal);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Discovers `.query-autopsy/*.{jsonl,ndjson}` files across open workspace folders
 * without opening any database connections or running external commands.
 */
export async function discoverWorkspaceTraceFiles(): Promise<
  readonly DiscoveredTraceFile[]
> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return [];
  }

  const uris = await vscode.workspace.findFiles(
    TRACE_GLOB,
    TRACE_EXCLUDE_GLOB,
    12,
  );

  const items: DiscoveredTraceFile[] = uris.map((uri) => {
    const folder = vscode.workspace.getWorkspaceFolder(uri) ?? folders[0]!;
    return {
      uri,
      relativePath: vscode.workspace.asRelativePath(uri, false),
      folderUri: folder.uri,
      folderName: folder.name,
    };
  });

  items.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return items;
}

/**
 * Reads a workspace trace file safely with symlink escape and size protections.
 */
export async function readSafeWorkspaceTraceFile(
  uri: vscode.Uri,
  confineToFolderUri?: vscode.Uri,
  maxBytes = MAX_TRACE_FILE_BYTES,
): Promise<string> {
  if (uri.scheme === 'file') {
    const ext = path.extname(uri.fsPath).toLowerCase();
    if (ext !== '.jsonl' && ext !== '.ndjson') {
      throw new Error('Trace file must use a .jsonl or .ndjson extension.');
    }

    const targetReal = await fs.realpath(uri.fsPath);
    if (confineToFolderUri && confineToFolderUri.scheme === 'file') {
      const rootReal = await fs.realpath(confineToFolderUri.fsPath);
      if (!isStrictlyInsideDirectory(rootReal, targetReal)) {
        throw new Error(
          'Blocked reading trace file because its resolved path escapes the workspace folder.',
        );
      }
    }

    const stat = await fs.stat(targetReal);
    if (!stat.isFile()) {
      throw new Error('Selected trace path is not a regular file.');
    }
    if (stat.size > maxBytes) {
      throw new Error(
        `Trace file exceeds maximum size limit (${Math.round(maxBytes / (1024 * 1024))} MB).`,
      );
    }

    return fs.readFile(targetReal, 'utf-8');
  }

  const stat = await vscode.workspace.fs.stat(uri);
  if (stat.size > maxBytes) {
    throw new Error(
      `Trace file exceeds maximum size limit (${Math.round(maxBytes / (1024 * 1024))} MB).`,
    );
  }
  const bytes = await vscode.workspace.fs.readFile(uri);
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * Resolves a trace entry's `file` and `line` strictly within workspace folders,
 * preventing path-traversal (`../`) or symlink escapes from malicious trace files.
 */
export async function resolveSafeWorkspaceSourceTarget(
  rawFilePath: string,
  line = 1,
  preferredFolderUri?: vscode.Uri,
): Promise<ResolvedTraceSourceTarget | undefined> {
  if (!rawFilePath || rawFilePath.includes('\0')) {
    return undefined;
  }

  const trimmed = rawFilePath.trim();
  if (!trimmed) {
    return undefined;
  }

  const folderUris: vscode.Uri[] = [];
  if (preferredFolderUri) {
    folderUris.push(preferredFolderUri);
  }
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (!folderUris.some((u) => u.toString() === folder.uri.toString())) {
      folderUris.push(folder.uri);
    }
  }

  for (const folderUri of folderUris) {
    if (folderUri.scheme !== 'file') {
      continue;
    }

    let rootReal: string;
    try {
      rootReal = await fs.realpath(folderUri.fsPath);
    } catch {
      continue;
    }

    const candidateLexical = path.isAbsolute(trimmed)
      ? path.resolve(trimmed)
      : path.resolve(rootReal, trimmed);

    if (!isStrictlyInsideDirectory(rootReal, candidateLexical)) {
      continue;
    }

    try {
      const targetReal = await fs.realpath(candidateLexical);
      if (!isStrictlyInsideDirectory(rootReal, targetReal)) {
        continue;
      }
      const stat = await fs.stat(targetReal);
      if (!stat.isFile()) {
        continue;
      }

      const normalizedLine = Number.isFinite(line) && line >= 1 ? Math.trunc(line) : 1;
      return {
        uri: vscode.Uri.file(targetReal),
        line: normalizedLine,
      };
    } catch {
      // File missing or unreadable in this workspace folder; try next folder
    }
  }

  return undefined;
}
