import * as vscode from 'vscode';
import {
  type DiscoveredConnectionCandidate,
  extractPostgresUrisFromComposeContent,
  extractPostgresUrisFromEnvContent,
  parseEnvKeyValueMap,
} from '../../domain/services/envDiscovery.js';

const ENV_GLOB = '**/{.env,.env.local,.env.development,.env.dev}';
const COMPOSE_GLOB =
  '**/{docker-compose.yml,docker-compose.yaml,compose.yml,compose.yaml}';
const EXCLUDE_GLOB = '**/{node_modules,.git,dist}/**';

export async function discoverWorkspacePostgresConnections(): Promise<
  readonly DiscoveredConnectionCandidate[]
> {
  if (!vscode.workspace.workspaceFolders?.length) {
    return [];
  }

  const [envFiles, composeFiles] = await Promise.all([
    vscode.workspace.findFiles(ENV_GLOB, EXCLUDE_GLOB, 8),
    vscode.workspace.findFiles(COMPOSE_GLOB, EXCLUDE_GLOB, 6),
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
      pushUnique(extractPostgresUrisFromEnvContent(text, relPath));
    } catch {
      // Skip unreadable files cleanly
    }
  }

  for (const uri of composeFiles) {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const relPath = vscode.workspace.asRelativePath(uri, false);
      pushUnique(
        extractPostgresUrisFromComposeContent(
          decoder.decode(bytes),
          relPath,
          combinedEnvMap,
        ),
      );
    } catch {
      // Skip unreadable files cleanly
    }
  }

  return results;
}
