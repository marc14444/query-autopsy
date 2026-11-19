import { sanitizeConnectionDisplayTarget } from '../models/connectionProfile.js';
import {
  type DatabaseEngine,
  detectDatabaseEngineFromUri,
} from '../models/databaseEngine.js';

export interface DiscoveredConnectionCandidate {
  readonly label: string;
  readonly sourceFile: string;
  readonly uri: string;
  readonly displayTarget: string;
  readonly engine?: DatabaseEngine | undefined;
  readonly needsPasswordPrompt?: boolean | undefined;
}

const DB_URI_KEYS = new Set([
  'DATABASE_URL',
  'POSTGRES_URL',
  'POSTGRESQL_URL',
  'PG_URL',
  'PG_CONNECTION_STRING',
  'POSTGRES_URI',
  'DIRECT_URL',
  'MYSQL_URL',
  'MYSQL_URI',
  'SQLITE_URL',
  'SQLITE_PATH',
  'DB_URL',
  'DB_CONNECTION',
]);

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function isSupportedUri(value: string): boolean {
  const lower = value.toLowerCase();
  if (
    lower.startsWith('postgres://') ||
    lower.startsWith('postgresql://') ||
    lower.startsWith('mysql://') ||
    lower.startsWith('mysql2://')
  ) {
    try {
      const parsed = new URL(value);
      return Boolean(parsed.hostname);
    } catch {
      return false;
    }
  }
  if (
    lower.startsWith('sqlite://') ||
    lower.startsWith('sqlite:') ||
    (lower.startsWith('file:') && /\.(?:sqlite3?|db)(?:$|\?)/i.test(value))
  ) {
    return value.length > 6;
  }
  return false;
}

/**
 * Pure parser extracting supported database connection URIs (PostgreSQL, MySQL, SQLite) from `.env` files.
 */
export function extractDatabaseUrisFromEnvContent(
  content: string,
  sourceFile: string,
  allowedEngines?: ReadonlySet<DatabaseEngine>,
): readonly DiscoveredConnectionCandidate[] {
  const candidates: DiscoveredConnectionCandidate[] = [];
  const seenUris = new Set<string>();

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const normalizedLine = line.startsWith('export ')
      ? line.slice('export '.length).trim()
      : line;

    const eqIndex = normalizedLine.indexOf('=');
    if (eqIndex <= 0) {
      continue;
    }

    const key = normalizedLine.slice(0, eqIndex).trim();
    let rawValue = normalizedLine.slice(eqIndex + 1).trim();

    if (!rawValue.startsWith('"') && !rawValue.startsWith("'")) {
      const commentIdx = rawValue.indexOf(' #');
      if (commentIdx !== -1) {
        rawValue = rawValue.slice(0, commentIdx).trim();
      }
    }

    const value = stripWrappingQuotes(rawValue);
    if (!isSupportedUri(value)) {
      continue;
    }

    const engine = detectDatabaseEngineFromUri(value);
    if (allowedEngines && !allowedEngines.has(engine)) {
      continue;
    }

    const upperKey = key.toUpperCase();
    if (
      !DB_URI_KEYS.has(upperKey) &&
      !upperKey.includes('PG') &&
      !upperKey.includes('POSTGRES') &&
      !upperKey.includes('MYSQL') &&
      !upperKey.includes('SQLITE') &&
      !upperKey.includes('DATABASE')
    ) {
      continue;
    }

    if (seenUris.has(value)) {
      continue;
    }
    seenUris.add(value);

    const displayTarget = sanitizeConnectionDisplayTarget(value, engine);
    candidates.push({
      label: `${key} (${displayTarget})`,
      sourceFile,
      uri: value,
      displayTarget,
      ...(allowedEngines ? {} : { engine }),
    });
  }

  return candidates;
}

export function extractPostgresUrisFromEnvContent(
  content: string,
  sourceFile: string,
): readonly DiscoveredConnectionCandidate[] {
  return extractDatabaseUrisFromEnvContent(
    content,
    sourceFile,
    new Set<DatabaseEngine>(['postgresql']),
  );
}

/**
 * Parses key-value pairs from a `.env` file for Compose variable substitution.
 */
export function parseEnvKeyValueMap(
  content: string,
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const normalized = line.startsWith('export ')
      ? line.slice('export '.length).trim()
      : line;
    const eqIndex = normalized.indexOf('=');
    if (eqIndex <= 0) {
      continue;
    }
    const key = normalized.slice(0, eqIndex).trim();
    let val = normalized.slice(eqIndex + 1).trim();
    if (!val.startsWith('"') && !val.startsWith("'")) {
      const commentIdx = val.indexOf(' #');
      if (commentIdx !== -1) {
        val = val.slice(0, commentIdx).trim();
      }
    }
    map.set(key, stripWrappingQuotes(val));
  }
  return map;
}

function resolveEnvTemplate(
  rawValue: string,
  envMap?: ReadonlyMap<string, string>,
): { readonly value: string; readonly unresolved: boolean } {
  let unresolved = false;
  const resolved = rawValue.replace(
    /\$\{([a-zA-Z_][a-zA-Z0-9_]*)(?::?-([^}]*))?\}/g,
    (_, varName: string, fallback: string | undefined) => {
      const fromEnv = envMap?.get(varName);
      if (fromEnv !== undefined && fromEnv !== '') {
        return fromEnv;
      }
      if (fallback !== undefined) {
        return fallback;
      }
      unresolved = true;
      return '';
    },
  );
  return { value: resolved, unresolved };
}

/**
 * Pure parser extracting local PostgreSQL & MySQL/MariaDB service credentials from `docker-compose.yml` / `compose.yml`.
 */
export function extractDatabaseUrisFromComposeContent(
  content: string,
  sourceFile: string,
  envMap?: ReadonlyMap<string, string>,
  includeEngineField = true,
): readonly DiscoveredConnectionCandidate[] {
  const lines = content.split(/\r?\n/);
  const candidates: DiscoveredConnectionCandidate[] = [];

  let currentServiceName = '';
  let serviceIndent = -1;
  let detectedEngine: DatabaseEngine | undefined;
  let user = 'postgres';
  let password = '';
  let passwordUnresolved = false;
  let db = 'postgres';
  let hostPort = '5432';

  const flushService = (): void => {
    if (!detectedEngine) {
      return;
    }
    const scheme = detectedEngine === 'mysql' ? 'mysql' : 'postgresql';
    const auth = password
      ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}@`
      : `${encodeURIComponent(user)}@`;
    const uri = `${scheme}://${auth}localhost:${hostPort}/${encodeURIComponent(db)}`;
    const displayTarget = sanitizeConnectionDisplayTarget(uri, detectedEngine);
    candidates.push({
      label: `Docker "${currentServiceName}" (${displayTarget})`,
      sourceFile,
      uri,
      displayTarget,
      ...(includeEngineField ? { engine: detectedEngine } : {}),
      ...(passwordUnresolved ? { needsPasswordPrompt: true } : {}),
    });
  };

  let inServices = false;
  let servicesIndent = -1;

  for (const rawLine of lines) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) {
      continue;
    }

    const indent = rawLine.length - rawLine.trimStart().length;
    const trimmed = rawLine.trim();

    if (/^services\s*:\s*$/.test(trimmed)) {
      inServices = true;
      servicesIndent = indent;
      continue;
    }

    if (!inServices) {
      continue;
    }

    if (indent <= servicesIndent) {
      flushService();
      inServices = false;
      detectedEngine = undefined;
      continue;
    }

    if (serviceIndent === -1 || indent === serviceIndent) {
      const svcMatch = /^([a-zA-Z0-9_-]+)\s*:\s*$/.exec(trimmed);
      if (svcMatch) {
        flushService();
        currentServiceName = svcMatch[1]!;
        serviceIndent = indent;
        detectedEngine = undefined;
        user = 'postgres';
        password = '';
        passwordUnresolved = false;
        db = 'postgres';
        hostPort = '5432';
        continue;
      }
    }

    if (serviceIndent === -1 || indent <= serviceIndent) {
      continue;
    }

    const imageMatch = /^image\s*:\s*(.+)$/.exec(trimmed);
    if (imageMatch) {
      const imageName = stripWrappingQuotes(imageMatch[1]!).toLowerCase();
      if (
        imageName.includes('postgres') ||
        imageName.includes('postgis') ||
        imageName.includes('timescaledb')
      ) {
        detectedEngine = 'postgresql';
        user = 'postgres';
        db = 'postgres';
        hostPort = '5432';
      } else if (
        imageName.includes('mysql') ||
        imageName.includes('mariadb') ||
        imageName.includes('percona')
      ) {
        detectedEngine = 'mysql';
        user = 'root';
        db = '';
        hostPort = '3306';
      }
      continue;
    }

    const portMatch =
      /^-\s*["']?(?:[\d.]+:)?(\d+|\$\{[^}]+\}):(5432|3306)["']?/.exec(
        trimmed,
      );
    if (portMatch) {
      const resolvedPort = resolveEnvTemplate(portMatch[1]!, envMap);
      if (/^\d+$/.test(resolvedPort.value)) {
        hostPort = resolvedPort.value;
      }
      continue;
    }

    const envMatch =
      /^(?:-\s*)?(POSTGRES_USER|POSTGRES_PASSWORD|POSTGRES_DB|MYSQL_ROOT_PASSWORD|MYSQL_USER|MYSQL_PASSWORD|MYSQL_DATABASE|MARIADB_ROOT_PASSWORD|MARIADB_USER|MARIADB_PASSWORD|MARIADB_DATABASE)\s*[:=]\s*(.+)$/.exec(
        trimmed,
      );
    if (envMatch) {
      const envKey = envMatch[1]!;
      const rawVal = stripWrappingQuotes(envMatch[2]!);
      const resolved = resolveEnvTemplate(rawVal, envMap);

      if (envKey === 'POSTGRES_USER' && resolved.value) {
        user = resolved.value;
      } else if (envKey === 'POSTGRES_PASSWORD') {
        password = resolved.value;
        passwordUnresolved = resolved.unresolved;
      } else if (envKey === 'POSTGRES_DB' && resolved.value) {
        db = resolved.value;
      } else if (
        (envKey === 'MYSQL_USER' || envKey === 'MARIADB_USER') &&
        resolved.value
      ) {
        user = resolved.value;
      } else if (
        envKey === 'MYSQL_PASSWORD' ||
        envKey === 'MARIADB_PASSWORD' ||
        envKey === 'MYSQL_ROOT_PASSWORD' ||
        envKey === 'MARIADB_ROOT_PASSWORD'
      ) {
        password = resolved.value;
        passwordUnresolved = resolved.unresolved;
      } else if (
        (envKey === 'MYSQL_DATABASE' || envKey === 'MARIADB_DATABASE') &&
        resolved.value
      ) {
        db = resolved.value;
      }
    }
  }

  flushService();
  return candidates;
}

export function extractPostgresUrisFromComposeContent(
  content: string,
  sourceFile: string,
  envMap?: ReadonlyMap<string, string>,
): readonly DiscoveredConnectionCandidate[] {
  return extractDatabaseUrisFromComposeContent(
    content,
    sourceFile,
    envMap,
    false,
  ).filter((c) => detectDatabaseEngineFromUri(c.uri) === 'postgresql');
}
