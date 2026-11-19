import * as vscode from 'vscode';
import type { ConnectionConfigPort } from '../../../domain/ports/outbound/connectionConfigPort.js';

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
      if (profile.readOnlyLocked) {
        this.item.text = `$(lock) PG: ${profile.name} [RO]`;
        this.item.backgroundColor = new vscode.ThemeColor(
          'statusBarItem.warningBackground',
        );
        this.item.tooltip = `QueryAutopsy Active Profile: ${profile.name} (${profile.displayTarget}) — Read-Only Locked (mutations & index creation blocked). Click to switch.`;
      } else {
        this.item.text = `$(database) PG: ${profile.name}`;
        this.item.backgroundColor = undefined;
        this.item.tooltip = `QueryAutopsy Active Profile: ${profile.name} (${profile.displayTarget}). Click to switch or configure.`;
      }
      return;
    }

    const fallback = await this.connectionConfig.getConnectionString();
    if (fallback) {
      this.item.text = '$(database) PG: Fallback URI';
      this.item.backgroundColor = undefined;
      this.item.tooltip =
        'QueryAutopsy using workspace fallback connection URI. Click to save a named profile.';
      return;
    }

    this.item.text = '$(plug) QueryAutopsy: Connect PG';
    this.item.backgroundColor = undefined;
    this.item.tooltip =
      'Click to configure or auto-detect a PostgreSQL connection profile';
  }

  dispose(): void {
    this.item.dispose();
  }
}
