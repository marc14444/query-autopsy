import {
  type ConnectionConfigPort,
  connectionUriHasPlaintextPassword,
  detectDatabaseEngineFromUri,
  type LoggerPort,
  resolveProfileEngine,
} from '@query-autopsy/core';
import * as vscode from 'vscode';
import {
  McpConfigParseError,
  type McpSecurityMode,
  type McpTargetClient,
  mergeMcpConfigJson,
  resolveMcpTargetPath,
  writeSafeMcpConfigFile,
} from '../../../infrastructure/vscode/mcpConfigWriter.js';

export const CONFIGURE_MCP_COMMAND = 'queryAutopsy.configureMcp';

interface ClientPickItem extends vscode.QuickPickItem {
  readonly client: McpTargetClient;
}

interface ModePickItem extends vscode.QuickPickItem {
  readonly mode: McpSecurityMode;
}

interface CredentialPickItem extends vscode.QuickPickItem {
  readonly sourceKind: 'vscode-input' | 'env-var' | 'sqlite-active' | 'custom-uri';
  readonly value?: string | undefined;
}

async function openJsonPreviewDocument(content: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({
    language: 'json',
    content,
  });
  await vscode.window.showTextDocument(doc, vscode.ViewColumn.One, false);
}

/**
 * Interactive wizard generating or safely merging a Zero-Trust `@query-autopsy/mcp`
 * configuration for VS Code, Antigravity, Cursor, Claude Code, or Windsurf.
 */
export async function runConfigureMcpCommand(
  connectionConfig: ConnectionConfigPort,
  logger: LoggerPort,
): Promise<boolean> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const activeProfile = await connectionConfig.getActiveProfile();
  const activeEngine = activeProfile
    ? resolveProfileEngine(activeProfile)
    : undefined;

  const clientPick = await vscode.window.showQuickPick<ClientPickItem>(
    [
      {
        label: '$(hubot) VS Code / GitHub Copilot',
        description: '.vscode/mcp.json',
        detail:
          'Uses native masked ${input:query_autopsy_uri} session prompt (zero secrets on disk)',
        client: 'vscode',
      },
      {
        label: '$(sparkle) Antigravity',
        description: '~/.gemini/antigravity/mcp_config.json',
        detail: 'Global user MCP config for Google Antigravity',
        client: 'antigravity',
      },
      {
        label: '$(edit) Cursor',
        description: '.cursor/mcp.json',
        detail: 'Project-scoped Cursor MCP config (workspace-safe env reference)',
        client: 'cursor',
      },
      {
        label: '$(terminal) Claude Code',
        description: '.mcp.json',
        detail: 'Project-scoped Claude Code MCP config',
        client: 'claude-code',
      },
      {
        label: '$(cloud) Windsurf',
        description: '~/.codeium/windsurf/mcp_config.json',
        detail: 'Global user MCP config for Windsurf',
        client: 'windsurf',
      },
      {
        label: '$(clippy) Preview & Copy JSON Only',
        description: 'No file written',
        detail:
          'Generates a clean @query-autopsy/mcp snippet in an untitled tab + clipboard',
        client: 'preview',
      },
    ],
    {
      title: 'QueryAutopsy: Configure Safe AI MCP Server (Step 1/3 — Target Client)',
      ignoreFocusOut: true,
    },
  );
  if (!clientPick) {
    return false;
  }

  const isProdProfile = activeProfile?.environment === 'production';
  const modeOptions: ModePickItem[] = [
    {
      label: '$(shield) Estimate-Only + PII Redaction (Recommended)',
      description: 'Default Zero-Trust mode',
      detail:
        'Runs EXPLAIN without executing SQL, strips comments, redacts PII literals, and blocks raw SQL / DDL / index writes.',
      mode: 'estimate',
    },
    ...(!isProdProfile
      ? [
          {
            label: '$(beaker) Local Dev with EXPLAIN ANALYZE (--allow-analyze)',
            description: 'Non-production loopback only',
            detail:
              'Adds --env local --allow-analyze (still strictly blocks WRITE ANALYZE, DDL, and production hosts).',
            mode: 'analyze-local' as const,
          },
        ]
      : []),
    {
      label: '$(file-code) Offline Traces & SQL Check Only (Zero DB Access)',
      description: 'No connection URI required',
      detail:
        'Exposes autopsy_check_sql and autopsy_analyze_traces (.query-autopsy/traces.jsonl) with zero database credentials.',
      mode: 'offline',
    },
  ];

  const modePick = await vscode.window.showQuickPick<ModePickItem>(modeOptions, {
    title: 'QueryAutopsy: Select MCP Security Level (Step 2/3)',
    ignoreFocusOut: true,
  });
  if (!modePick) {
    return false;
  }

  let dsnValue: string | undefined;
  let resolvedEngine = activeEngine;

  if (modePick.mode !== 'offline') {
    const credentialChoices: CredentialPickItem[] = [];

    if (clientPick.client === 'vscode') {
      credentialChoices.push({
        label: '$(key) Masked Session Prompt: ${input:query_autopsy_uri} (Recommended)',
        description: 'Zero secrets saved on disk',
        detail:
          'VS Code prompts securely when starting the MCP server without storing passwords in .vscode/mcp.json.',
        sourceKind: 'vscode-input',
        value: '${input:query_autopsy_uri}',
      });
    }

    credentialChoices.push({
      label: '$(symbol-variable) Environment Variable Reference: ${env:QUERY_AUTOPSY_URI}',
      description: 'Safe to commit to Git',
      detail:
        clientPick.client === 'vscode'
          ? 'Reads QUERY_AUTOPSY_URI from your shell or .env environment'
          : 'Configure QUERY_AUTOPSY_URI in your local shell environment before starting the IDE',
      sourceKind: 'env-var',
      value:
        clientPick.client === 'vscode'
          ? '${env:QUERY_AUTOPSY_URI}'
          : '${QUERY_AUTOPSY_URI}',
    });

    if (activeProfile && resolveProfileEngine(activeProfile) === 'sqlite') {
      const rawUri = await connectionConfig.getConnectionString();
      if (rawUri && !connectionUriHasPlaintextPassword(rawUri, 'sqlite')) {
        credentialChoices.push({
          label: `$(file-binary) Active SQLite Database (${activeProfile.displayTarget})`,
          description: 'Zero password required',
          detail: rawUri,
          sourceKind: 'sqlite-active',
          value: rawUri,
        });
      }
    }

    credentialChoices.push({
      label: '$(edit) Enter Custom Connection URI...',
      description:
        clientPick.client === 'antigravity' || clientPick.client === 'windsurf'
          ? 'User-home global config'
          : 'Passwordless / SQLite URI only for workspace configs',
      sourceKind: 'custom-uri',
    });

    const credPick = await vscode.window.showQuickPick<CredentialPickItem>(
      credentialChoices,
      {
        title: 'QueryAutopsy: Select Database URI Source (Step 3/3)',
        ignoreFocusOut: true,
      },
    );
    if (!credPick) {
      return false;
    }

    if (credPick.sourceKind === 'custom-uri') {
      const isWorkspaceTarget =
        clientPick.client !== 'antigravity' && clientPick.client !== 'windsurf';
      const entered = await vscode.window.showInputBox({
        title: 'QueryAutopsy MCP: Database URI',
        prompt: isWorkspaceTarget
          ? 'Enter a passwordless URI or placeholder (e.g. postgresql://ro_user@127.0.0.1:5432/app_dev or sqlite:///path/to/app.db). Plaintext passwords are blocked in workspace files.'
          : 'Enter read-only database URI (e.g. postgresql://ro_user:password@127.0.0.1:5432/app_dev)',
        password: !isWorkspaceTarget,
        ignoreFocusOut: true,
        validateInput: (val) => {
          const trimmed = val.trim();
          if (!trimmed) {
            return 'URI cannot be empty.';
          }
          if (
            isWorkspaceTarget &&
            connectionUriHasPlaintextPassword(trimmed, resolvedEngine)
          ) {
            return 'Plaintext passwords are blocked in workspace configs. Use ${env:QUERY_AUTOPSY_URI} or omit the password.';
          }
          return undefined;
        },
      });
      if (!entered) {
        return false;
      }
      dsnValue = entered.trim();
      resolvedEngine = detectDatabaseEngineFromUri(dsnValue);
    } else {
      dsnValue = credPick.value;
    }
  }

  const buildOptions = {
    client: clientPick.client,
    mode: modePick.mode,
    engine: resolvedEngine,
    environment: activeProfile?.environment,
    dsnValue,
    // Non-negotiable Zero-Trust MCP default: ALWAYS keep PII literal redaction enabled
    redactLiterals: true,
  };

  if (clientPick.client === 'preview') {
    const jsonText = mergeMcpConfigJson(undefined, buildOptions);
    await vscode.env.clipboard.writeText(jsonText);
    await openJsonPreviewDocument(jsonText);
    void vscode.window.showInformationMessage(
      'QueryAutopsy: Safe MCP JSON config copied to clipboard and opened in editor.',
    );
    return true;
  }

  let targetPath: string;
  try {
    targetPath = resolveMcpTargetPath(
      clientPick.client,
      workspaceFolder?.uri.fsPath,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`QueryAutopsy: ${msg}`);
    return false;
  }

  const isWorkspaceScoped =
    clientPick.client === 'vscode' ||
    clientPick.client === 'cursor' ||
    clientPick.client === 'claude-code';

  try {
    const result = await writeSafeMcpConfigFile(
      targetPath,
      buildOptions,
      isWorkspaceScoped ? workspaceFolder?.uri.fsPath : undefined,
    );

    logger.info('Configured QueryAutopsy MCP server', {
      client: clientPick.client,
      mode: modePick.mode,
      created: result.created,
    });

    const action = await vscode.window.showInformationMessage(
      `QueryAutopsy MCP configured in "${vscode.workspace.asRelativePath(targetPath, false)}" (${modePick.mode} mode).`,
      'Open Config File',
      'Copy JSON',
    );
    if (action === 'Open Config File') {
      const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.file(result.targetPath),
      );
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.One, false);
    } else if (action === 'Copy JSON') {
      await vscode.env.clipboard.writeText(result.content);
    }
    return true;
  } catch (err) {
    if (err instanceof McpConfigParseError) {
      const fallbackJson = mergeMcpConfigJson(undefined, buildOptions);
      await vscode.env.clipboard.writeText(fallbackJson);
      await openJsonPreviewDocument(fallbackJson);
      void vscode.window.showWarningMessage(
        `QueryAutopsy: ${err.message} Copied server snippet to clipboard and opened preview instead.`,
      );
      return true;
    }

    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to configure MCP server', { message: msg });
    void vscode.window.showErrorMessage(`QueryAutopsy: ${msg}`);
    return false;
  }
}
