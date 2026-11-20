import { type LoggerPort, UnsafeQueryError } from '@query-autopsy/core';
import { PgQueryExecutor } from '@query-autopsy/executors';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => {
  const poolQueryMock = vi.fn();
  const poolReleaseMock = vi.fn();
  const poolConnectMock = vi.fn();
  const poolEndMock = vi.fn().mockResolvedValue(undefined);
  const poolOnMock = vi.fn();

  const clientConnectMock = vi.fn().mockResolvedValue(undefined);
  const clientQueryMock = vi.fn();
  const clientEndMock = vi.fn().mockResolvedValue(undefined);

  return {
    poolQueryMock,
    poolReleaseMock,
    poolConnectMock,
    poolEndMock,
    poolOnMock,
    clientConnectMock,
    clientQueryMock,
    clientEndMock,
  };
});

vi.mock('pg', () => {
  class MockPool {
    connect = mockState.poolConnectMock;
    end = mockState.poolEndMock;
    on = mockState.poolOnMock;
  }

  class MockClient {
    connect = mockState.clientConnectMock;
    query = mockState.clientQueryMock;
    end = mockState.clientEndMock;
  }

  return { Pool: MockPool, Client: MockClient };
});

describe('PgQueryExecutor security invariants', () => {
  const logger: LoggerPort = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockState.poolConnectMock.mockResolvedValue({
      query: mockState.poolQueryMock,
      release: mockState.poolReleaseMock,
    });
  });

  it('executes HypoPG EXPLAIN inside BEGIN READ ONLY + statement_timeout + ROLLBACK cleanup', async () => {
    const fakePlan = [{ Plan: { 'Node Type': 'Index Scan', 'Total Cost': 8 } }];
    mockState.poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("extname = 'hypopg'")) {
        return { rows: [{ installed: true }] };
      }
      if (sql.startsWith('EXPLAIN ')) {
        return { rows: [{ 'QUERY PLAN': fakePlan }] };
      }
      return { rows: [] };
    });

    const executor = new PgQueryExecutor(logger);
    const out = await executor.simulateHypotheticalIndex(
      'postgresql://postgres@127.0.0.1:5432/dev',
      'SELECT id FROM orders WHERE user_id = $1;',
      'CREATE INDEX CONCURRENTLY idx_orders_user_id ON orders (user_id);',
      [42],
    );

    expect(out.supported).toBe(true);

    const executedSql = mockState.poolQueryMock.mock.calls.map((c) => c[0]);
    expect(executedSql).toEqual([
      "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'hypopg') AS installed",
      'SELECT hypopg_reset()',
      'SELECT * FROM hypopg_create_index($1)',
      'BEGIN READ ONLY',
      'SET LOCAL statement_timeout = 5000',
      'EXPLAIN (COSTS, VERBOSE, FORMAT JSON) SELECT id FROM orders WHERE user_id = $1',
      'ROLLBACK',
      'SELECT hypopg_reset()',
    ]);
    expect(mockState.poolReleaseMock).toHaveBeenCalledOnce();
  });

  it('rejects DDL or dangerous SQL directly inside simulateHypotheticalIndex before connecting', async () => {
    const executor = new PgQueryExecutor(logger);

    await expect(
      executor.simulateHypotheticalIndex(
        'postgresql://postgres@127.0.0.1:5432/dev',
        "SELECT pg_read_file('/etc/passwd')",
        'CREATE INDEX CONCURRENTLY idx_a ON orders (user_id);',
        [],
      ),
    ).rejects.toThrow(UnsafeQueryError);
    expect(mockState.poolConnectMock).not.toHaveBeenCalled();
  });

  it('reports isSuperuser flag accurately in testConnection', async () => {
    mockState.clientQueryMock.mockResolvedValueOnce({
      rows: [{ version: 'PostgreSQL 16.4', is_superuser: 'on' }],
    });

    const executor = new PgQueryExecutor(logger);
    const result = await executor.testConnection(
      'postgresql://postgres@127.0.0.1:5432/dev',
    );

    expect(result).toEqual({
      serverVersion: 'PostgreSQL 16.4',
      isSuperuser: true,
    });
    expect(logger.warn).toHaveBeenCalled();
  });
});
