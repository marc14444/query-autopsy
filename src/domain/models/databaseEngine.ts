export type DatabaseEngine = 'postgresql' | 'mysql' | 'sqlite';

/**
 * Infers the database engine from a connection URI or local SQLite file path.
 */
export function detectDatabaseEngineFromUri(
  connectionString: string,
): DatabaseEngine {
  const trimmed = connectionString.trim();
  const lower = trimmed.toLowerCase();

  if (lower.startsWith('mysql://') || lower.startsWith('mysql2://')) {
    return 'mysql';
  }

  if (
    lower === ':memory:' ||
    lower.startsWith('sqlite://') ||
    lower.startsWith('sqlite:') ||
    lower.startsWith('file:') ||
    /\.(?:sqlite3?|db)(?:$|\?)/i.test(trimmed)
  ) {
    return 'sqlite';
  }

  return 'postgresql';
}

export function formatEngineLabel(engine: DatabaseEngine): string {
  switch (engine) {
    case 'postgresql':
      return 'PostgreSQL';
    case 'mysql':
      return 'MySQL';
    case 'sqlite':
      return 'SQLite';
  }
}

export function formatEngineShortCode(engine: DatabaseEngine): string {
  switch (engine) {
    case 'postgresql':
      return 'PG';
    case 'mysql':
      return 'MySQL';
    case 'sqlite':
      return 'SQLite';
  }
}
