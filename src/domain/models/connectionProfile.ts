import {
  type DatabaseEngine,
  detectDatabaseEngineFromUri,
} from './databaseEngine.js';

export type ProfileEnvironment = 'local' | 'staging' | 'production';

export interface ConnectionProfile {
  readonly id: string;
  readonly name: string;
  readonly engine?: DatabaseEngine | undefined;
  readonly environment: ProfileEnvironment;
  readonly readOnlyLocked: boolean;
  /** Safe display summary (host:port/database or db filename) with credentials stripped. */
  readonly displayTarget: string;
}

export interface SaveConnectionProfileInput {
  readonly id: string;
  readonly name: string;
  readonly engine?: DatabaseEngine | undefined;
  readonly environment: ProfileEnvironment;
  readonly readOnlyLocked: boolean;
}

export function resolveProfileEngine(
  profile?: ConnectionProfile,
): DatabaseEngine {
  return profile?.engine ?? 'postgresql';
}

function sanitizeSqliteDisplayTarget(connectionString: string): string {
  const trimmed = connectionString.trim();
  if (trimmed.toLowerCase() === ':memory:') {
    return ':memory:';
  }

  let normalizedPath = trimmed;
  if (/^sqlite:\/\//i.test(normalizedPath)) {
    normalizedPath = normalizedPath.slice('sqlite://'.length);
  } else if (/^sqlite:/i.test(normalizedPath)) {
    normalizedPath = normalizedPath.slice('sqlite:'.length);
  } else if (/^file:/i.test(normalizedPath)) {
    normalizedPath = normalizedPath.slice('file:'.length);
  }

  const withoutQuery = normalizedPath.split('?')[0] ?? normalizedPath;
  const parts = withoutQuery.split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0) {
    return 'sqlite';
  }
  return parts[parts.length - 1] ?? 'sqlite';
}

/**
 * Extracts a safe display label from any supported connection URI or SQLite path without leaking credentials.
 */
export function sanitizeConnectionDisplayTarget(
  connectionString: string,
  explicitEngine?: DatabaseEngine,
): string {
  const engine =
    explicitEngine ?? detectDatabaseEngineFromUri(connectionString);
  if (engine === 'sqlite') {
    return sanitizeSqliteDisplayTarget(connectionString);
  }

  try {
    const parsed = new URL(connectionString.trim());
    const host = parsed.hostname || 'localhost';
    const port = parsed.port ? `:${parsed.port}` : '';
    const db = parsed.pathname.replace(/^\/+/, '');
    return db ? `${host}${port}/${db}` : `${host}${port}`;
  } catch {
    return engine;
  }
}

/**
 * Extracts a safe `host:port/database` label from a PostgreSQL URI without leaking credentials.
 */
export function sanitizePostgresDisplayTarget(connectionString: string): string {
  return sanitizeConnectionDisplayTarget(connectionString);
}

export function inferDefaultReadOnlyLock(
  environment: ProfileEnvironment,
): boolean {
  return environment !== 'local';
}
