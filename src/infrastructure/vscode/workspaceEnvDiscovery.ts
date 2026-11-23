import * as path from 'node:path';
import {
  type DiscoveredConnectionCandidate,
  extractDatabaseUrisFromComposeContent,
  extractDatabaseUrisFromEnvContent,
  parseEnvKeyValueMap,
  sanitizeConnectionDisplayTarget,
} from '@query-autopsy/core';
import * as vscode from 'vscode';

const ENV_GLOB = '**/{.env,.env.local,.env.development,.env.dev}';
const COMPOSE_GLOB =
  '**/{docker-compose.yml,docker-compose.yaml,compose.yml,compose.yaml}';
const SQLITE_GLOB = '**/*.{sqlite,sqlite3,db}';
const DUCKDB_GLOB = '**/*.{duckdb,ddb}';
const EXCLUDE_GLOB = '**/{node_modules,.git,dist}/**';

function absolutizeEnvLocalDbCandidate(
  candidate: DiscoveredConnectionCandidate,
  envFileFsPath: string,
): DiscoveredConnectionCandidate {
  if (candidate.engine !== 'sqlite' && candidate.engine !== 'duckdb') {
    return candidate;
  }

  let rawPath = candidate.uri;
  for (const prefix of [
    /^file:/i,
    /^sqlite:\/\//i,
    /^sqlite:/i,
    /^duckdb:\/\//i,
    /^duckdb:/i,
  ]) {
    if (prefix.test(rawPath)) {
      rawPath = rawPath.replace(prefix, '');
      break;
    }
  }

  rawPath = (rawPath.split('?')[0] ?? rawPath).trim();
  if (
    !rawPath ||
    rawPath === ':memory:' ||
    rawPath === ':memory:duckdb' ||
    path.isAbsolute(rawPath)
  ) {
    return candidate;
  }

  const resolvedPath = path.resolve(path.dirname(envFileFsPath), rawPath);
  const absUri = `${candidate.engine}://${resolvedPath}`;
  return {
    ...candidate,
    uri: absUri,
    displayTarget: sanitizeConnectionDisplayTarget(absUri, candidate.engine),
  };
}

export async function discoverWorkspaceDatabaseConnections(): Promise<
  readonly DiscoveredConnectionCandidate[]
> {
  if (!vscode.workspace.isTrusted || !vscode.workspace.workspaceFolders?.length) {
    return [];
  }

  const [envFiles, composeFiles, sqliteFiles, duckdbFiles] = await Promise.all([
    vscode.workspace.findFiles(ENV_GLOB, EXCLUDE_GLOB, 8),
    vscode.workspace.findFiles(COMPOSE_GLOB, EXCLUDE_GLOB, 6),
    vscode.workspace.findFiles(SQLITE_GLOB, EXCLUDE_GLOB, 8),
    vscode.workspace.findFiles(DUCKDB_GLOB, EXCLUDE_GLOB, 8),
  ]);

  const decoder = new TextDecoder('utf-8');
  const results: DiscoveredConnectionCandidate[] = [];
  const seenUris = new Set<string>();
  const combinedEnvMap = new Map<string, string>();

  const pushUnique = (items: readonly DiscoveredConnectionCandidate[]): void => {
    for (const item of items) {
      if (!seenUris.has(item.uri)) {
        seenUris.add(item.uri);
        results.push(item);
      }
    }
  };

  for (const uri of envFiles) {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = decoder.decode(bytes);
      for (const [k, v] of parseEnvKeyValueMap(text)) {
        combinedEnvMap.set(k, v);
      }
      const relPath = vscode.workspace.asRelativePath(uri, false);
      const envCandidates = extractDatabaseUrisFromEnvContent(text, relPath).map(
        (c) => absolutizeEnvLocalDbCandidate(c, uri.fsPath),
      );
      pushUnique(envCandidates);
    } catch {
      // Skip unreadable files cleanly
    }
  }

  for (const uri of composeFiles) {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const relPath = vscode.workspace.asRelativePath(uri, false);
      pushUnique(
        extractDatabaseUrisFromComposeContent(
          decoder.decode(bytes),
          relPath,
          combinedEnvMap,
        ),
      );
    } catch {
      // Skip unreadable files cleanly
    }
  }

  for (const uri of sqliteFiles) {
    const relPath = vscode.workspace.asRelativePath(uri, false);
    const sqliteUri = `sqlite://${uri.fsPath}`;
    pushUnique([
      {
        label: `SQLite (${relPath})`,
        sourceFile: relPath,
        uri: sqliteUri,
        displayTarget: sanitizeConnectionDisplayTarget(sqliteUri, 'sqlite'),
        engine: 'sqlite',
      },
    ]);
  }

  for (const uri of duckdbFiles) {
    const relPath = vscode.workspace.asRelativePath(uri, false);
    const duckdbUri = `duckdb://${uri.fsPath}`;
    pushUnique([
      {
        label: `DuckDB (${relPath})`,
        sourceFile: relPath,
        uri: duckdbUri,
        displayTarget: sanitizeConnectionDisplayTarget(duckdbUri, 'duckdb'),
        engine: 'duckdb',
      },
    ]);
  }

  return results;
}

export const discoverWorkspacePostgresConnections =
  discoverWorkspaceDatabaseConnections;
