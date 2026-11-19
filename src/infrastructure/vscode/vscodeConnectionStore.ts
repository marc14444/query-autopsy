import * as vscode from 'vscode';
import type {
  ConnectionConfigPort,
  RuntimeSettings,
} from '../../domain/ports/outbound/connectionConfigPort.js';

const SECRET_CONNECTION_KEY = 'queryAutopsy.postgres.connectionString';

export class VsCodeConnectionStore implements ConnectionConfigPort {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async getConnectionString(): Promise<string | undefined> {
    const secretDsn = await this.secrets.get(SECRET_CONNECTION_KEY);
    if (secretDsn && secretDsn.trim().length > 0) {
      return secretDsn.trim();
    }

    const config = vscode.workspace.getConfiguration('queryAutopsy');
    const fallbackDsn = config.get<string>(
      'postgres.fallbackConnectionString',
      '',
    );
    return fallbackDsn.trim().length > 0 ? fallbackDsn.trim() : undefined;
  }

  async saveConnectionString(connectionString: string): Promise<void> {
    await this.secrets.store(SECRET_CONNECTION_KEY, connectionString.trim());
  }

  async clearConnectionString(): Promise<void> {
    await this.secrets.delete(SECRET_CONNECTION_KEY);
  }

  getRuntimeSettings(): RuntimeSettings {
    const config = vscode.workspace.getConfiguration('queryAutopsy');
    return {
      statementTimeoutMs: config.get<number>(
        'postgres.statementTimeoutMs',
        5000,
      ),
      allowWriteAnalyze: config.get<boolean>(
        'postgres.allowWriteAnalyze',
        false,
      ),
      seqScanRowThreshold: config.get<number>(
        'diagnostics.seqScanRowThreshold',
        1000,
      ),
      showRawJson: config.get<boolean>('output.showRawJson', false),
    };
  }
}
