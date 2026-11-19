import * as vscode from 'vscode';
import type { ConnectionConfigPort } from '../../../domain/ports/outbound/connectionConfigPort.js';
import type { LoggerPort } from '../../../domain/ports/outbound/loggerPort.js';
import type { QueryExecutorPort } from '../../../domain/ports/outbound/queryExecutorPort.js';

export function validatePostgresUri(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return 'PostgreSQL connection URI cannot be empty.';
  }
  if (!trimmed.startsWith('postgres://') && !trimmed.startsWith('postgresql://')) {
    return 'URI must start with "postgres://" or "postgresql://".';
  }
  try {
    const parsed = new URL(trimmed);
    if (!parsed.hostname) {
      return 'URI must include a hostname (e.g. localhost).';
    }
  } catch {
    return 'Invalid URL format.';
  }
  return undefined;
}

export async function runConfigureConnectionCommand(
  connectionConfig: ConnectionConfigPort,
  queryExecutor: QueryExecutorPort,
  logger: LoggerPort,
): Promise<boolean> {
  const input = await vscode.window.showInputBox({
    title: 'QueryAutopsy: Configure PostgreSQL Connection',
    prompt:
      'Enter your PostgreSQL connection URI (stored encrypted in VS Code SecretStorage)',
    placeHolder: 'postgresql://postgres:queryautopsy@localhost:5432/query_autopsy_dev',
    password: true,
    ignoreFocusOut: true,
    validateInput: validatePostgresUri,
  });

  if (!input) {
    return false;
  }

  const trimmedUri = input.trim();

  try {
    const versionInfo = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'QueryAutopsy: Testing PostgreSQL connection...',
        cancellable: false,
      },
      async () => queryExecutor.testConnection(trimmedUri),
    );

    await connectionConfig.saveConnectionString(trimmedUri);
    logger.info('PostgreSQL connection verified and saved to SecretStorage');
    void vscode.window.showInformationMessage(
      `QueryAutopsy connected: ${versionInfo.serverVersion.split(',')[0]}`,
    );
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('PostgreSQL connection test failed', { message });

    const choice = await vscode.window.showErrorMessage(
      `Connection failed: ${message}`,
      'Save Anyway',
      'Cancel',
    );
    if (choice === 'Save Anyway') {
      await connectionConfig.saveConnectionString(trimmedUri);
      void vscode.window.showWarningMessage(
        'QueryAutopsy connection URI saved (unverified).',
      );
      return true;
    }
    return false;
  }
}

export async function runClearConnectionCommand(
  connectionConfig: ConnectionConfigPort,
  logger: LoggerPort,
): Promise<void> {
  await connectionConfig.clearConnectionString();
  logger.info('Cleared stored PostgreSQL connection from SecretStorage');
  void vscode.window.showInformationMessage(
    'QueryAutopsy: Stored PostgreSQL connection cleared.',
  );
}
