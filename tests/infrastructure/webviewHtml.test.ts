import { describe, expect, it } from 'vitest';
import { buildWebviewHtml } from '../../src/infrastructure/vscode/webview/webviewHtml.js';

describe('buildWebviewHtml', () => {
  it('renders strict CSP headers with nonce and local webview URIs without unsafe-inline or unsafe-eval', () => {
    const html = buildWebviewHtml({
      cspSource: 'https://file+.vscode-resource.vscode-cdn.net',
      nonce: 'abc123def456',
      scriptUri: 'https://file+.vscode-resource.vscode-cdn.net/main.js',
      styleUri: 'https://file+.vscode-resource.vscode-cdn.net/styles.css',
    });

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain("default-src 'none'");
    expect(html).toContain(
      'style-src https://file+.vscode-resource.vscode-cdn.net',
    );
    expect(html).toContain("script-src 'nonce-abc123def456'");
    expect(html).toContain("object-src 'none'");
    expect(html).toContain("base-uri 'none'");
    expect(html).not.toContain('unsafe-inline');
    expect(html).not.toContain('unsafe-eval');
    expect(html).toContain(
      '<script nonce="abc123def456" src="https://file+.vscode-resource.vscode-cdn.net/main.js"></script>',
    );
    expect(html).toContain(
      '<link rel="stylesheet" href="https://file+.vscode-resource.vscode-cdn.net/styles.css">',
    );
  });
});
