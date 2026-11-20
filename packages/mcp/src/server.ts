import type { McpFirewallServer } from './firewall.js';

export interface JsonRpcRequest {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
}

export interface JsonRpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: string | number | null;
  readonly result?: unknown;
  readonly error?: {
    readonly code: number;
    readonly message: string;
  };
}

const SUPPORTED_PROTOCOL_VERSIONS = [
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;

const SERVER_INFO = {
  name: '@query-autopsy/mcp',
  version: '1.4.0',
};

function isValidRpcId(id: unknown): id is string | number | null {
  return (
    id === null ||
    typeof id === 'string' ||
    (typeof id === 'number' && Number.isFinite(id))
  );
}

/**
 * Pure newline-delimited JSON-RPC 2.0 MCP server transport for local `stdio`
 * execution (zero HTTP server / zero exposed network sockets).
 */
export class McpStdioTransport {
  constructor(private readonly firewall: McpFirewallServer) {}

  async handleMessage(raw: unknown): Promise<JsonRpcResponse | undefined> {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid JSON-RPC Request.' },
      };
    }

    const req = raw as JsonRpcRequest;
    const hasId = 'id' in req && req.id !== undefined;
    const id = hasId && isValidRpcId(req.id) ? req.id : null;

    if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32600, message: 'Invalid JSON-RPC 2.0 request envelope.' },
      };
    }

    // Notifications carry no id and expect no response in JSON-RPC 2.0
    if (!hasId) {
      return undefined;
    }

    switch (req.method) {
      case 'initialize': {
        const clientVersion =
          typeof req.params === 'object' &&
          req.params !== null &&
          'protocolVersion' in req.params &&
          typeof (req.params as Record<string, unknown>)['protocolVersion'] ===
            'string'
            ? ((req.params as Record<string, unknown>)[
                'protocolVersion'
              ] as string)
            : SUPPORTED_PROTOCOL_VERSIONS[0];

        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(
          clientVersion as (typeof SUPPORTED_PROTOCOL_VERSIONS)[number],
        )
          ? clientVersion
          : SUPPORTED_PROTOCOL_VERSIONS[0];

        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion,
            capabilities: {
              tools: {
                listChanged: false,
              },
            },
            serverInfo: SERVER_INFO,
          },
        };
      }

      case 'ping':
        return {
          jsonrpc: '2.0',
          id,
          result: {},
        };

      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: this.firewall.listTools(),
          },
        };

      case 'tools/call': {
        if (typeof req.params !== 'object' || req.params === null || Array.isArray(req.params)) {
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32602, message: 'Invalid tools/call params object.' },
          };
        }
        const params = req.params as Record<string, unknown>;
        if (typeof params['name'] !== 'string' || !params['name']) {
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32602, message: 'tools/call requires a non-empty tool "name".' },
          };
        }

        const result = await this.firewall.callTool(
          params['name'],
          params['arguments'],
        );
        return {
          jsonrpc: '2.0',
          id,
          result,
        };
      }

      default:
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32601,
            message: `Method "${req.method}" is not supported by QueryAutopsy MCP.`,
          },
        };
    }
  }

  async processLine(
    line: string,
    writeStdout: (text: string) => void,
  ): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      writeStdout(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error: invalid JSON.' },
        } satisfies JsonRpcResponse)}\n`,
      );
      return;
    }

    const response = await this.handleMessage(parsed);
    if (response !== undefined) {
      writeStdout(`${JSON.stringify(response)}\n`);
    }
  }

  async runStdio(
    stdin: AsyncIterable<string | Buffer>,
    writeStdout: (text: string) => void,
  ): Promise<void> {
    let buffer = '';
    for await (const chunk of stdin) {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        await this.processLine(line, writeStdout);
      }
    }

    if (buffer.trim().length > 0) {
      await this.processLine(buffer, writeStdout);
    }
  }
}
