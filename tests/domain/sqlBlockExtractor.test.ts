import {
  extractJupyterNotebookSqlBlocks,
  extractSqlBlocks,
  normalizeDbtSqlTemplate,
} from '@query-autopsy/core';
import { describe, expect, it } from 'vitest';

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

  it('extracts TypeORM queryRunner data queries while skipping DDL schema statements', () => {
    const typeormFile = `
      await queryRunner.query(\`CREATE TABLE "cards"."card" ("id" UUID NOT NULL)\`);
      await queryRunner.query(\`
        SELECT id, status FROM "cards"."card" WHERE "identity_id" = $1 AND "deleted_at" IS NULL
      \`);
    `;
    const blocks = extractSqlBlocks(typeormFile, 'typescript', 'cardRepo.ts');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.sql).toContain('FROM "cards"."card"');
  });

  it('extracts PHP / Laravel DB::select, PDO::prepare, heredocs, and nowdocs while normalizing :named params', () => {
    const phpCode = `<?php
      $nonSql = "Select a payment method from the dropdown";
      $interpolated = "SELECT * FROM {$dynamicTable} WHERE id = 1";
      $fragment = $query->whereRaw('total > ?', [100]);

      $orders = DB::select(
        'SELECT id, status FROM orders WHERE user_id = ? AND deleted_at IS NULL',
        [$userId]
      );

      $stmt = $pdo->prepare(<<<'SQL'
        SELECT id, amount
        FROM invoices
        WHERE customer_email = :email AND issued_at::date >= :since
      SQL);

      // sql
      $reportSql = <<<SQL
        SELECT count(*) FROM audit_events WHERE tenant_id = ?
      SQL;
    `;

    const blocks = extractSqlBlocks(phpCode, 'php', 'app/Http/Controllers/OrderController.php');
    expect(blocks).toHaveLength(3);
    expect(blocks[0]?.sourceKind).toBe('php-sql');
    expect(blocks[0]?.sql).toBe(
      'SELECT id, status FROM orders WHERE user_id = ? AND deleted_at IS NULL',
    );
    expect(blocks[1]?.sql).toContain('customer_email = $1 AND issued_at::date >= $2');
    expect(blocks[2]?.sql).toContain('FROM audit_events WHERE tenant_id = ?');
  });

  it('extracts SQL from Jupyter (.ipynb) notebooks and Python Data Science libraries (pandas, polars, duckdb)', () => {
    const pyData = `
      import duckdb, pandas as pd, polars as pl
      df1 = pd.read_sql("SELECT user_id, SUM(amount_cents) FROM orders GROUP BY 1", conn)
      df2 = duckdb.sql("SELECT * FROM read_parquet('events.parquet') WHERE status = 'ok'")
      df3 = pl.read_database("SELECT id FROM invoices WHERE total > ?", conn)
    `;
    const pyBlocks = extractSqlBlocks(pyData, 'python', 'etl/warehouse_load.py');
    expect(pyBlocks).toHaveLength(3);

    const ipynb = JSON.stringify(
      {
        nbformat: 4,
        nbformat_minor: 5,
        cells: [
          {
            cell_type: 'markdown',
            source: ['# Daily Revenue Analysis\n'],
          },
          {
            cell_type: 'code',
            source: [
              '%%sql\n',
              'SELECT date_trunc(\'day\', created_at) AS day, COUNT(*)\n',
              'FROM orders\n',
              'GROUP BY 1;\n',
            ],
          },
          {
            cell_type: 'code',
            source: [
              '%matplotlib inline\n',
              'df = pd.read_sql("SELECT id, email FROM users WHERE active = true", engine)\n',
            ],
          },
          {
            cell_type: 'code',
            source: ['%sql SELECT id, total FROM orders WHERE user_id = 42\n'],
          },
        ],
      },
      null,
      2,
    );

    const nbBlocks = extractJupyterNotebookSqlBlocks(ipynb);
    expect(nbBlocks).toHaveLength(3);
    expect(nbBlocks.every((b) => b.sourceKind === 'notebook-cell')).toBe(true);
    expect(nbBlocks[0]?.sql).toContain('FROM orders');
    expect(nbBlocks[1]?.sql).toContain('FROM users WHERE active = true');
    expect(nbBlocks[2]?.sql).toContain('WHERE user_id = 42');
    expect(extractJupyterNotebookSqlBlocks('{invalid json')).toEqual([]);
  });

  it('normalizes dbt Jinja models cleanly while preserving SQL literals and line numbers', () => {
    const dbtModel = [
      "{{ config(materialized='incremental') }}",
      '{# Incremental daily revenue rollup #}',
      'WITH recent AS (',
      '  SELECT order_id, user_id, amount_cents',
      "  FROM {{ ref('stg_orders') }}",
      '  {% if is_incremental() %}',
      '  WHERE created_at >= (SELECT max(created_at) FROM {{ this }})',
      "  AND env_label = '{{ var(\"env\") }}'",
      '  {% endif %}',
      ')',
      'SELECT r.user_id, SUM(r.amount_cents) AS total_cents',
      'FROM recent r',
      "JOIN {{ source('raw', 'users') }} u ON u.id = r.user_id",
      'GROUP BY r.user_id;',
    ].join('\n');

    const normalized = normalizeDbtSqlTemplate(dbtModel);
    expect(normalized.split('\n')).toHaveLength(dbtModel.split('\n').length);
    expect(normalized).toContain('FROM stg_orders');
    expect(normalized).toContain('FROM dbt_this_model');
    expect(normalized).toContain('JOIN raw.users');
    expect(normalized).toContain("'{{ var(\"env\") }}'");

    const blocks = extractSqlBlocks(dbtModel, 'sql', 'models/marts/fct_revenue.sql');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.sourceKind).toBe('dbt-sql');
    expect(blocks[0]?.sql).toContain('JOIN raw.users');
  });
});
