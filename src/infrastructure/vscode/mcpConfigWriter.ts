import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  connectionUriHasPlaintextPassword,
  type DatabaseEngine,
  type ProfileEnvironment,
  UnsafeQueryError,
} from '@query-autopsy/core';

export type McpTargetClient =
  | 'vscode'
  | 'antigravity'
  | 'cursor'
  | 'claude-code'
  | 'windsurf'
  | 'preview';

export type McpSecurityMode = 'estimate' | 'analyze-local' | 'offline';

export interface McpConfigBuildOptions {
  readonly client: McpTargetClient;
  readonly mode: McpSecurityMode;
  readonly engine?: DatabaseEngine | undefined;
  readonly environment?: ProfileEnvironment | undefined;
  readonly dsnValue?: string | undefined;
  readonly redactLiterals?: boolean | undefined;
  readonly serverName?: string | undefined;
}

export interface McpWriteResult {
  readonly targetPath: string;
  readonly created: boolean;
  readonly content: string;
}

export class McpConfigParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpConfigParseError';
  }
}

const WORKSPACE_SCOPED_CLIENTS = new Set<McpTargetClient>([
  'vscode',
  'cursor',
  'claude-code',
  'preview',
]);

const VSCODE_INPUT_ID = 'query_autopsy_uri';

/**
 * Enforces non-negotiable security invariants before generating or writing any MCP config:
 * - Never enables `analyze-local` on `production` environments.
 * - Never writes plaintext DB passwords (`user:pass@` or `?password=...`) into workspace configs or previews.
 */
export function assertSafeMcpConfigWrite(options: McpConfigBuildOptions): void {
  if (options.mode === 'analyze-local' && options.environment === 'production') {
    throw new UnsafeQueryError(
      'Cannot enable EXPLAIN ANALYZE (--allow-analyze) on a production target inside MCP config.',
    );
  }

  const trimmedDsn = options.dsnValue?.trim();
  if (
    trimmedDsn &&
    WORKSPACE_SCOPED_CLIENTS.has(options.client) &&
    connectionUriHasPlaintextPassword(trimmedDsn, options.engine)
  ) {
    throw new UnsafeQueryError(
      'Refusing to write a plaintext database password into a workspace MCP config. Use "${input:query_autopsy_uri}", "${env:QUERY_AUTOPSY_URI}", or a passwordless URI.',
    );
  }
}

export function getMcpRootKey(client: McpTargetClient): 'servers' | 'mcpServers' {
  return client === 'vscode' ? 'servers' : 'mcpServers';
}

export function resolveMcpTargetPath(
  client: Exclude<McpTargetClient, 'preview'>,
  workspaceRootFsPath?: string,
  homeDir: string = os.homedir(),
): string {
  switch (client) {
    case 'vscode':
      if (!workspaceRootFsPath) {
        throw new Error('Open a workspace folder before writing .vscode/mcp.json.');
      }
      return path.join(workspaceRootFsPath, '.vscode', 'mcp.json');
    case 'cursor':
      if (!workspaceRootFsPath) {
        throw new Error('Open a workspace folder before writing .cursor/mcp.json.');
      }
      return path.join(workspaceRootFsPath, '.cursor', 'mcp.json');
    case 'claude-code':
      if (!workspaceRootFsPath) {
        throw new Error('Open a workspace folder before writing .mcp.json.');
      }
      return path.join(workspaceRootFsPath, '.mcp.json');
    case 'antigravity':
      return path.join(homeDir, '.gemini', 'antigravity', 'mcp_config.json');
    case 'windsurf':
      return path.join(homeDir, '.codeium', 'windsurf', 'mcp_config.json');
  }
}

export function buildMcpServerEntry(
  options: McpConfigBuildOptions,
): Record<string, unknown> {
  assertSafeMcpConfigWrite(options);

  const args: string[] = ['-y', '@query-autopsy/mcp'];

  if (options.mode === 'analyze-local') {
    args.push('--env', 'local', '--allow-analyze');
  } else if (options.mode === 'estimate' && options.environment) {
    args.push('--env', options.environment);
  }

  if (options.mode !== 'offline' && options.engine) {
    args.push('--engine', options.engine);
  }

  if (options.redactLiterals === false) {
    args.push('--no-redact');
  }

  const trimmedDsn = options.dsnValue?.trim();
  const envBlock =
    options.mode !== 'offline' && trimmedDsn
      ? { QUERY_AUTOPSY_URI: trimmedDsn }
      : undefined;

  return {
    ...(options.client === 'vscode' ? { type: 'stdio' } : {}),
    command: 'npx',
    args,
    ...(envBlock ? { env: envBlock } : {}),
  };
}

/**
 * Safely merges the `query-autopsy` MCP server definition into an existing JSON config file,
 * preserving all pre-existing MCP servers, VS Code inputs, and unrelated properties.
 */
export function mergeMcpConfigJson(
  existingRawText: string | undefined,
  options: McpConfigBuildOptions,
): string {
  assertSafeMcpConfigWrite(options);

  let root: Record<string, unknown> = {};
  if (existingRawText !== undefined && existingRawText.trim().length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existingRawText);
    } catch {
      throw new McpConfigParseError(
        'Existing MCP config file is not strict JSON (e.g. contains comments or syntax errors). Opening preview instead so existing entries are preserved.',
      );
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new McpConfigParseError(
        'Existing MCP config root must be a JSON object.',
      );
    }
    root = { ...(parsed as Record<string, unknown>) };
  }

  const rootKey = getMcpRootKey(options.client);
  const existingServersRaw = root[rootKey];
  if (
    existingServersRaw !== undefined &&
    (typeof existingServersRaw !== 'object' ||
      existingServersRaw === null ||
      Array.isArray(existingServersRaw))
  ) {
    throw new McpConfigParseError(
      `Existing "${rootKey}" field in MCP config is not a JSON object.`,
    );
  }

  const serverName = options.serverName?.trim() || 'query-autopsy';
  const mergedServers: Record<string, unknown> = {
    ...((existingServersRaw as Record<string, unknown> | undefined) ?? {}),
    [serverName]: buildMcpServerEntry(options),
  };

  root[rootKey] = mergedServers;

  if (
    options.client === 'vscode' &&
    options.mode !== 'offline' &&
    options.dsnValue?.trim() === `\${input:${VSCODE_INPUT_ID}}`
  ) {
    const existingInputs = Array.isArray(root['inputs'])
      ? [...(root['inputs'] as unknown[])]
      : [];
    const alreadyHasInput = existingInputs.some(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        (item as Record<string, unknown>)['id'] === VSCODE_INPUT_ID,
    );
    if (!alreadyHasInput) {
      existingInputs.push({
        id: VSCODE_INPUT_ID,
        type: 'promptString',
        description:
          'Read-only PostgreSQL/MySQL/SQLite URI for QueryAutopsy MCP (masked prompt, never written to disk)',
        password: true,
      });
    }
    root['inputs'] = existingInputs;
  }

  return `${JSON.stringify(root, null, 2)}\n`;
}

async function assertNotEscapingSymlink(
  targetPath: string,
  confinementRootFsPath?: string,
): Promise<void> {
  const checkSingleLstat = async (p: string): Promise<boolean> => {
    try {
      const st = await fs.lstat(p);
      return st.isSymbolicLink();
    } catch {
      return false;
    }
  };

  if (await checkSingleLstat(targetPath)) {
    throw new UnsafeQueryError(
      'Refusing to write MCP config through a symbolic link target.',
    );
  }

  const parentDir = path.dirname(targetPath);
  if (await checkSingleLstat(parentDir)) {
    throw new UnsafeQueryError(
      'Refusing to write MCP config inside a symbolic link directory.',
    );
  }

  if (confinementRootFsPath) {
    const rootReal = await fs.realpath(confinementRootFsPath);
    const resolvedTarget = path.resolve(rootReal, path.relative(confinementRootFsPath, targetPath));
    const rel = path.relative(rootReal, resolvedTarget);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new UnsafeQueryError(
        'MCP workspace config path must stay inside the workspace folder.',
      );
    }
  }
}

export async function writeSafeMcpConfigFile(
  targetPath: string,
  options: McpConfigBuildOptions,
  confinementRootFsPath?: string,
): Promise<McpWriteResult> {
  assertSafeMcpConfigWrite(options);
  await assertNotEscapingSymlink(targetPath, confinementRootFsPath);

  let existingText: string | undefined;
  let created = false;
  try {
    existingText = await fs.readFile(targetPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      created = true;
    } else {
      throw err;
    }
  }

  const merged = mergeMcpConfigJson(existingText, options);
  await fs.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o750 });
  await fs.writeFile(targetPath, merged, 'utf-8');

  return {
    targetPath,
    created,
    content: merged,
  };
}
