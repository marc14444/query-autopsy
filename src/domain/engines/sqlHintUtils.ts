import { classifyPredicateColumns } from '../services/diagnosticEngine.js';

export interface SqlIndexHintColumns {
  readonly equalityCols: readonly string[];
  readonly rangeCols: readonly string[];
  readonly orderByCols: readonly string[];
}

function stripIdentifierQuotes(raw: string): string {
  return raw.replace(/[`"\[\]]/g, '').trim();
}

/**
 * Best-effort extraction of WHERE equality/range columns and ORDER BY columns from SQL
 * when engines like SQLite omit filter expressions from EXPLAIN QUERY PLAN text.
 */
export function extractQueryIndexHintColumns(
  sql: string | undefined,
  alias?: string,
): SqlIndexHintColumns {
  if (!sql) {
    return { equalityCols: [], rangeCols: [], orderByCols: [] };
  }

  const sanitizedSql = sql.replace(/[`"\[\]]/g, '');
  const whereMatch =
    /\bWHERE\b([\s\S]*?)(?=\b(?:GROUP\s+BY|HAVING|ORDER\s+BY|LIMIT|OFFSET|UNION|INTERSECT|EXCEPT)\b|;|$)/i.exec(
      sanitizedSql,
    );
  const wherePredicates = whereMatch
    ? classifyPredicateColumns(whereMatch[1], alias)
    : { equalityCols: [], rangeCols: [] };

  const orderByCols: string[] = [];
  const orderMatch =
    /\bORDER\s+BY\b([\s\S]*?)(?=\b(?:LIMIT|OFFSET|FOR|UNION|INTERSECT|EXCEPT)\b|;|$)/i.exec(
      sanitizedSql,
    );

  if (orderMatch?.[1]) {
    const aliasPrefix = alias ? `${alias}.` : undefined;
    for (const rawItem of orderMatch[1].split(',')) {
      const cleaned = stripIdentifierQuotes(rawItem);
      const colMatch =
        /^(?:([a-zA-Z_][a-zA-Z0-9_]*)\.)?([a-zA-Z_][a-zA-Z0-9_]*)(?:\s+(ASC|DESC))?$/i.exec(
          cleaned,
        );
      if (!colMatch?.[2]) {
        continue;
      }
      if (aliasPrefix && colMatch[1] && `${colMatch[1]}.` !== aliasPrefix) {
        continue;
      }
      const dir = colMatch[3] ? ` ${colMatch[3].toUpperCase()}` : '';
      orderByCols.push(`${colMatch[2]}${dir}`);
    }
  }

  return {
    equalityCols: wherePredicates.equalityCols,
    rangeCols: wherePredicates.rangeCols,
    orderByCols,
  };
}
