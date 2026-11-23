import { UnsafeQueryError } from '../errors/domainErrors.js';
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

function sanitizeLocalFileDisplayTarget(
  connectionString: string,
  fallbackLabel: 'sqlite' | 'duckdb',
): string {
  const trimmed = connectionString.trim();
  const lower = trimmed.toLowerCase();
  if (lower === ':memory:' || lower === ':memory:duckdb') {
    return trimmed;
  }

  let normalizedPath = trimmed;
  for (const prefix of [
    /^sqlite:\/\//i,
    /^sqlite:/i,
    /^duckdb:\/\//i,
    /^duckdb:/i,
    /^file:/i,
  ]) {
    if (prefix.test(normalizedPath)) {
      normalizedPath = normalizedPath.replace(prefix, '');
      break;
    }
  }

  const withoutQuery = normalizedPath.split('?')[0] ?? normalizedPath;
  const parts = withoutQuery.split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0) {
    return fallbackLabel;
  }
  return parts[parts.length - 1] ?? fallbackLabel;
}

/**
 * Extracts a safe display label from any supported connection URI or local SQLite/DuckDB path without leaking credentials.
 */
export function sanitizeConnectionDisplayTarget(
  connectionString: string,
  explicitEngine?: DatabaseEngine,
): string {
  const engine =
    explicitEngine ?? detectDatabaseEngineFromUri(connectionString);
  if (engine === 'sqlite' || engine === 'duckdb') {
    return sanitizeLocalFileDisplayTarget(connectionString, engine);
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

function normalizeParsedConnectionUrl(
  connectionString: string,
  explicitEngine?: DatabaseEngine,
): URL | undefined {
  const engine =
    explicitEngine ?? detectDatabaseEngineFromUri(connectionString);
  if (engine === 'sqlite' || engine === 'duckdb') {
    return undefined;
  }

  try {
    const normalized = connectionString
      .trim()
      .replace(/^mysql2:\/\//i, 'mysql://');
    return new URL(normalized);
  } catch {
    return undefined;
  }
}

export function extractConnectionHost(
  connectionString: string,
  explicitEngine?: DatabaseEngine,
): string | undefined {
  const parsed = normalizeParsedConnectionUrl(
    connectionString,
    explicitEngine,
  );
  const host = parsed?.hostname.trim().toLowerCase();
  return host && host.length > 0 ? host : undefined;
}

export function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!normalized) {
    return false;
  }
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === '::1' ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

/**
 * Returns true if a PostgreSQL/MySQL connection string embeds a plaintext password
 * in userinfo (`user:password@host`) or query parameters (`?password=...`).
 */
export function connectionUriHasPlaintextPassword(
  connectionString: string,
  explicitEngine?: DatabaseEngine,
): boolean {
  const parsed = normalizeParsedConnectionUrl(
    connectionString,
    explicitEngine,
  );
  if (!parsed) {
    return false;
  }

  if (parsed.password.length > 0) {
    return true;
  }

  for (const [key, value] of parsed.searchParams.entries()) {
    const lowerKey = key.toLowerCase();
    if (
      (lowerKey === 'password' ||
        lowerKey === 'passwd' ||
        lowerKey === 'pass') &&
      value.length > 0
    ) {
      return true;
    }
  }

  return false;
}

export function usesSslNoVerify(
  connectionString: string,
  explicitEngine?: DatabaseEngine,
): boolean {
  const parsed = normalizeParsedConnectionUrl(
    connectionString,
    explicitEngine,
  );
  if (!parsed) {
    return false;
  }
  return parsed.searchParams.get('sslmode')?.toLowerCase() === 'no-verify';
}

export function isRemoteUnsafeSslUri(
  connectionString: string,
  explicitEngine?: DatabaseEngine,
): boolean {
  if (!usesSslNoVerify(connectionString, explicitEngine)) {
    return false;
  }
  const host = extractConnectionHost(connectionString, explicitEngine);
  return host !== undefined && !isLoopbackHost(host);
}

/**
 * Enforces profile-level transport security invariants (e.g., forbids
 * `sslmode=no-verify` against non-localhost hosts on production profiles).
 */
export function assertSafeProfileConnection(
  profile: ConnectionProfile | undefined,
  connectionString: string,
): void {
  const engine = profile
    ? resolveProfileEngine(profile)
    : detectDatabaseEngineFromUri(connectionString);

  if (
    profile?.environment === 'production' &&
    isRemoteUnsafeSslUri(connectionString, engine)
  ) {
    throw new UnsafeQueryError(
      `Production profile "${profile.name}" cannot disable TLS certificate verification (?sslmode=no-verify) on a remote host. Switch to ?sslmode=require.`,
    );
  }
}
