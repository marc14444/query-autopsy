import type * as vscode from 'vscode';
import type { LoggerPort } from '../../domain/ports/outbound/loggerPort.js';

export class OutputChannelLogger implements LoggerPort {
  constructor(private readonly channel: vscode.OutputChannel) {}

  info(message: string, context?: Record<string, unknown>): void {
    this.write('INFO', message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.write('WARN', message, context);
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.write('ERROR', message, context);
  }

  private write(
    level: 'INFO' | 'WARN' | 'ERROR',
    message: string,
    context?: Record<string, unknown>,
  ): void {
    const ts = new Date().toISOString();
    const ctx =
      context && Object.keys(context).length > 0
        ? ` ${JSON.stringify(context)}`
        : '';
    this.channel.appendLine(`[${ts}] [${level}] ${message}${ctx}`);
  }
}
