export type ProfileEnvironment = 'local' | 'staging' | 'production';

export interface ConnectionProfile {
  readonly id: string;
  readonly name: string;
  readonly environment: ProfileEnvironment;
  readonly readOnlyLocked: boolean;
  /** Safe display summary (host:port/database) with credentials stripped. */
  readonly displayTarget: string;
}

export interface SaveConnectionProfileInput {
  readonly id: string;
  readonly name: string;
  readonly environment: ProfileEnvironment;
  readonly readOnlyLocked: boolean;
}

/**
 * Extracts a safe `host:port/database` label from a PostgreSQL URI without leaking credentials.
 */
export function sanitizePostgresDisplayTarget(connectionString: string): string {
  try {
    const parsed = new URL(connectionString.trim());
    const host = parsed.hostname || 'localhost';
    const port = parsed.port ? `:${parsed.port}` : '';
    const db = parsed.pathname.replace(/^\/+/, '');
    return db ? `${host}${port}/${db}` : `${host}${port}`;
  } catch {
    return 'postgresql';
  }
}

export function inferDefaultReadOnlyLock(
  environment: ProfileEnvironment,
): boolean {
  return environment !== 'local';
}
