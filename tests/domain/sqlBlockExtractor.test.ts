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

  it('extracts TypeORM / Knex / Prisma quoted calls in TypeScript', () => {
    const tsCode = `
      await dataSource.query('SELECT * FROM orders WHERE status = ? ORDER BY id DESC', ['pending']);
      await knex.raw("SELECT id FROM users WHERE org_id = ?", [99]);
      await prisma.$queryRawUnsafe('SELECT * FROM invoices WHERE user_id = $1', 42);
    `;

    const blocks = extractSqlBlocks(tsCode, 'typescript', 'orm.ts');
    expect(blocks).toHaveLength(3);
    expect(blocks[0]?.sourceKind).toBe('ts-orm-call');
    expect(blocks[1]?.sql).toBe('SELECT id FROM users WHERE org_id = ?');
    expect(blocks[2]?.sql).toBe('SELECT * FROM invoices WHERE user_id = $1');
  });

  it('extracts Python psycopg, SQLAlchemy, and sqlite3 queries while normalizing %s and :named params', () => {
    const pyCode = `
      """Module docstring explaining that we select items from inventory safely."""
      cur.execute(
          "SELECT id, total FROM orders WHERE user_id = %s AND created_at::date >= %s",
          (42, "2026-01-01"),
      )
      stmt = text("SELECT * FROM invoices WHERE tenant_id = :tid AND status = :status")
      # sql
      raw_sql = """
        SELECT id FROM audit_logs
        WHERE actor_id = %s
        ORDER BY id DESC
      """
    `;

    const blocks = extractSqlBlocks(pyCode, 'python', 'repo.py');
    expect(blocks).toHaveLength(3);
    expect(blocks[0]?.sourceKind).toBe('python-sql');
    expect(blocks[0]?.sql).toBe(
      'SELECT id, total FROM orders WHERE user_id = $1 AND created_at::date >= $2',
    );
    expect(blocks[1]?.sql).toBe(
      'SELECT * FROM invoices WHERE tenant_id = $1 AND status = $2',
    );
    expect(blocks[2]?.sql).toContain('WHERE actor_id = $1');
  });

  it('extracts Go database/sql, pgx, and sqlx raw/quoted queries without false positives', () => {
    const goCode = `
      msg := "Select an option from menu"
      rows, err := db.QueryContext(ctx, "SELECT email FROM users WHERE id = $1", id)
      row := pool.QueryRowContext(ctx, \`
        SELECT id, status
        FROM orders
        WHERE user_id = $1
      \`, userID)
    `;

    const blocks = extractSqlBlocks(goCode, 'go', 'repo.go');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.sourceKind).toBe('go-sql');
    expect(blocks[0]?.sql).toBe('SELECT email FROM users WHERE id = $1');
    expect(blocks[1]?.sql).toContain('WHERE user_id = $1');
  });
});
