import { describe, expect, it } from 'vitest';
import {
  EmptyQueryError,
  MultipleStatementsError,
  UnsafeQueryError,
} from '../../src/domain/errors/domainErrors.js';
import {
  classifySqlStatement,
  extractSqlStatementAtOffset,
  validateSafeCreateIndexSql,
} from '../../src/domain/services/sqlClassifier.js';

describe('classifySqlStatement', () => {
  it('classifies a SELECT with comments and trailing semicolon as READ', () => {
    const sql = `
      -- fetch orders for a user
      /* outer /* nested comment */ */
      SELECT id, status FROM orders WHERE user_id = 42;
    `;
    const result = classifySqlStatement(sql);
    expect(result.kind).toBe('READ');
    expect(result.parameterIndices).toEqual([]);
    expect(result.normalizedSql).toContain('SELECT id, status FROM orders');
    expect(result.normalizedSql.endsWith(';')).toBe(false);
  });

  it('ignores semicolons and parameter-like tokens inside string or dollar-quoted literals', () => {
    const sql = `
      SELECT '$1; DROP TABLE users;' AS txt, $$hello $2; world$$ AS dq
      FROM orders
      WHERE user_id = $2 AND status = $1 AND status <> '--not comment'
    `;
    const result = classifySqlStatement(sql);
    expect(result.kind).toBe('READ');
    expect(result.parameterIndices).toEqual([1, 2]);
  });

  it('classifies read-only WITH CTE as READ and data-modifying CTE as WRITE', () => {
    const readCte = `
      WITH recent_orders AS (SELECT * FROM orders WHERE status = 'pending')
      SELECT count(*) FROM recent_orders
    `;
    expect(classifySqlStatement(readCte).kind).toBe('READ');

    const writeCte = `
      WITH purged AS (DELETE FROM orders WHERE status = 'failed' RETURNING id)
      SELECT count(*) FROM purged
    `;
    expect(classifySqlStatement(writeCte).kind).toBe('WRITE');
  });

  it('classifies DML and DDL statements accurately', () => {
    expect(
      classifySqlStatement("UPDATE orders SET status = 'paid' WHERE id = 1")
        .kind,
    ).toBe('WRITE');
    expect(classifySqlStatement('DROP TABLE orders').kind).toBe('DDL');
    expect(
      classifySqlStatement('CREATE INDEX idx_orders_uid ON orders(user_id)')
        .kind,
    ).toBe('DDL');
  });

  it('rejects multiple SQL statements', () => {
    expect(() =>
      classifySqlStatement('SELECT 1; DROP TABLE users;'),
    ).toThrow(MultipleStatementsError);
  });

  it('rejects empty or comment-only selections', () => {
    expect(() => classifySqlStatement('   \n -- only comment  ')).toThrow(
      EmptyQueryError,
    );
  });

  it('rejects queries that already start with EXPLAIN', () => {
    expect(() =>
      classifySqlStatement('EXPLAIN ANALYZE SELECT * FROM orders'),
    ).toThrow(UnsafeQueryError);
  });

  it('gives an actionable error when only a partial SQL clause fragment is selected', () => {
    expect(() => classifySqlStatement('WHERE user_id = 42;')).toThrow(
      /Partial SQL fragment selected \(starts with "WHERE"\)/,
    );
  });
});

describe('extractSqlStatementAtOffset', () => {
  const sampleFile = [
    '-- 1. First query',
    'SELECT id, status',
    'FROM orders',
    'WHERE user_id = 42;',
    '',
    '-- 2. Second query with semicolon inside string',
    "SELECT ';not a split' AS s FROM users WHERE id = 1;",
  ].join('\n');

  it('extracts the complete statement when cursor is on any line of the query', () => {
    const whereOffset = sampleFile.indexOf('user_id = 42');
    const extracted = extractSqlStatementAtOffset(sampleFile, whereOffset);
    expect(extracted).toBe('SELECT id, status\nFROM orders\nWHERE user_id = 42;');
  });

  it('ignores semicolons inside string literals when extracting statement at cursor', () => {
    const secondOffset = sampleFile.indexOf('FROM users');
    const extracted = extractSqlStatementAtOffset(sampleFile, secondOffset);
    expect(extracted).toBe("SELECT ';not a split' AS s FROM users WHERE id = 1;");
  });

  it('returns undefined when cursor is on a blank line or standalone comment', () => {
    const commentOffset = sampleFile.indexOf('First query');
    expect(extractSqlStatementAtOffset(sampleFile, commentOffset)).toBeUndefined();
  });
});

describe('validateSafeCreateIndexSql', () => {
  it('accepts valid single-statement CREATE INDEX CONCURRENTLY statements', () => {
    expect(
      validateSafeCreateIndexSql(
        'CREATE INDEX CONCURRENTLY idx_orders_user_id ON orders (user_id);',
      ),
    ).toBe('CREATE INDEX CONCURRENTLY idx_orders_user_id ON orders (user_id);');

    expect(
      validateSafeCreateIndexSql(
        'CREATE INDEX CONCURRENTLY idx_orders_status_uid ON public.orders (status, user_id)',
      ),
    ).toBe(
      'CREATE INDEX CONCURRENTLY idx_orders_status_uid ON public.orders (status, user_id);',
    );

    expect(
      validateSafeCreateIndexSql(
        'CREATE INDEX CONCURRENTLY idx_orders_esr ON orders (status, amount_cents DESC, payload);',
      ),
    ).toBe(
      'CREATE INDEX CONCURRENTLY idx_orders_esr ON orders (status, amount_cents DESC, payload);',
    );

    expect(
      validateSafeCreateIndexSql(
        'CREATE INDEX CONCURRENTLY idx_users_lower_email ON users (lower(email));',
      ),
    ).toBe(
      'CREATE INDEX CONCURRENTLY idx_users_lower_email ON users (lower(email));',
    );
  });

  it('rejects non-concurrent indexes, arbitrary DDL, and multi-statement injections', () => {
    expect(() =>
      validateSafeCreateIndexSql('CREATE INDEX idx_orders_uid ON orders (user_id);'),
    ).toThrow(UnsafeQueryError);

    expect(() =>
      validateSafeCreateIndexSql('DROP TABLE orders;'),
    ).toThrow(UnsafeQueryError);

    expect(() =>
      validateSafeCreateIndexSql(
        'CREATE INDEX CONCURRENTLY idx_a ON orders (user_id); DROP TABLE orders;',
      ),
    ).toThrow(MultipleStatementsError);
  });
});
