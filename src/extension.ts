import type * as vscode from 'vscode';
import {
  createExtensionContainer,
  type ExtensionContainer,
} from './presentation/vscode/container.js';

let activeContainer: ExtensionContainer | undefined;

export function activate(context: vscode.ExtensionContext): void {
  activeContainer = createExtensionContainer(context);
}

export async function deactivate(): Promise<void> {
  if (activeContainer) {
    await activeContainer.dispose();
    activeContainer = undefined;
  }
}
