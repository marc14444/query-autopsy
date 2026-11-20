import {
  type ConnectionConfigPort,
  detectDatabaseEngineFromUri,
  formatEngineLabel,
  formatEngineShortCode,
  resolveProfileEngine,
} from '@query-autopsy/core';
import * as vscode from 'vscode';

export class ConnectionStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor(private readonly connectionConfig: ConnectionConfigPort) {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100,
    );
    this.item.command = 'queryAutopsy.configureConnection';
    this.item.show();
  }

  async refresh(): Promise<void> {
    const profile = await this.connectionConfig.getActiveProfile();
    if (profile) {
      const engine = resolveProfileEngine(profile);
      const shortCode = formatEngineShortCode(engine);
      const engineLabel = formatEngineLabel(engine);

      if (profile.readOnlyLocked) {
        this.item.text = `$(lock) ${shortCode}: ${profile.name} [RO]`;
        this.item.backgroundColor = new vscode.ThemeColor(
          'statusBarItem.warningBackground',
        );
        this.item.tooltip = `QueryAutopsy Active ${engineLabel} Profile: ${profile.name} (${profile.displayTarget}) — Read-Only Locked (mutations & index creation blocked). Click to switch.`;
      } else {
        this.item.text = `$(database) ${shortCode}: ${profile.name}`;
        this.item.backgroundColor = undefined;
        this.item.tooltip = `QueryAutopsy Active ${engineLabel} Profile: ${profile.name} (${profile.displayTarget}). Click to switch or configure.`;
      }
      return;
    }

    const fallback = await this.connectionConfig.getConnectionString();
    if (fallback) {
      const shortCode = formatEngineShortCode(
        detectDatabaseEngineFromUri(fallback),
      );
      this.item.text = `$(database) ${shortCode}: Fallback URI`;
      this.item.backgroundColor = undefined;
      this.item.tooltip =
        'QueryAutopsy using workspace fallback connection URI. Click to save a named profile.';
      return;
    }

    this.item.text = '$(plug) QueryAutopsy: Connect DB';
    this.item.backgroundColor = undefined;
    this.item.tooltip =
      'Click to configure or auto-detect a PostgreSQL, MySQL, or SQLite connection';
  }

  dispose(): void {
    this.item.dispose();
  }
}
