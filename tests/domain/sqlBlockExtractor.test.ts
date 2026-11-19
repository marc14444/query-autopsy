import { describe, expect, it } from 'vitest';
import { extractSqlBlocks } from '../../src/domain/services/sqlBlockExtractor.js';

describe('extractSqlBlocks', () => {
  it('extracts inspectable statements from SQL scripts and skips DDL/ANALYZE', () => {
    const sqlFile = [
      'CREATE TABLE orders (id BIGINT);',
      '',
      '-- Query 1',
      'SELECT id, status',
      'FROM orders',
      'WHERE user_id = 42;',
      '',
      'ANALYZE orders;',
    ].join('\n');

    const blocks = extractSqlBlocks(sqlFile, 'mssql', 'sample.sql');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      sql: 'SELECT id, status\nFROM orders\nWHERE user_id = 42;',
      startLine: 3,
      startColumn: 0,
      endLine: 5,
      endColumn: 19,
      sourceKind: 'sql-file',
    });
  });

  it('extracts tagged sql templates in TypeScript and converts ${...} to $1..$n', () => {
    const tsCode = `
      const rows = await sql\`
        SELECT id, status
        FROM orders
        WHERE user_id = \${user.id} AND status = \${status ?? 'pending'}
      \`;

      const prismaRows = await tx.\$queryRaw(Prisma.sql\`
        SELECT count(*) FROM users WHERE id = \${id}
      \`);
    `;

    const blocks = extractSqlBlocks(tsCode, 'typescript', 'ordersRepo.ts');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.sourceKind).toBe('ts-tagged-template');
    expect(blocks[0]?.sql).toContain('WHERE user_id = $1 AND status = $2');
    expect(blocks[1]?.sql).toContain('WHERE id = $1');
  });

  it('extracts /* sql */ comment-tagged and .query() template literals', () => {
    const tsCode = `
      const queryText = /* sql */ \`SELECT * FROM users WHERE id = $1\`;
      await pool.query(\`
        UPDATE orders SET status = 'paid' WHERE user_id = $1
      \`, [42]);
    `;

    const blocks = extractSqlBlocks(tsCode, 'typescript', 'db.ts');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.sql).toBe('SELECT * FROM users WHERE id = $1');
    expect(blocks[1]?.sql).toContain("UPDATE orders SET status = 'paid'");
  });

  it('avoids false positives on English template strings and regex literals', () => {
    const tsCode = `
      const regexWithBacktick = /\`SELECT \* FROM users\`/g;
      const uiMessage = \`Select an item from your cart\`;
      const validStandalone = \`SELECT id, email FROM users WHERE id = $1\`;
    `;

    const blocks = extractSqlBlocks(tsCode, 'typescript', 'ui.ts');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.sql).toBe('SELECT id, email FROM users WHERE id = $1');
  });
});
