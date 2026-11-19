import { sanitizePostgresDisplayTarget } from '../models/connectionProfile.js';

export interface DiscoveredConnectionCandidate {
  readonly label: string;
  readonly sourceFile: string;
  readonly uri: string;
  readonly displayTarget: string;
}

const POSTGRES_URI_KEYS = new Set([
  'DATABASE_URL',
  'POSTGRES_URL',
  'POSTGRESQL_URL',
  'PG_URL',
  'PG_CONNECTION_STRING',
  'POSTGRES_URI',
  'DIRECT_URL',
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

function isPostgresUri(value: string): boolean {
  if (!value.startsWith('postgres://') && !value.startsWith('postgresql://')) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Pure parser extracting PostgreSQL connection URIs from `.env` files.
 */
export function extractPostgresUrisFromEnvContent(
  content: string,
  sourceFile: string,
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

    // Strip unquoted trailing comments
    if (!rawValue.startsWith('"') && !rawValue.startsWith("'")) {
      const commentIdx = rawValue.indexOf(' #');
      if (commentIdx !== -1) {
        rawValue = rawValue.slice(0, commentIdx).trim();
      }
    }

    const value = stripWrappingQuotes(rawValue);
    if (!isPostgresUri(value)) {
      continue;
    }

    if (!POSTGRES_URI_KEYS.has(key.toUpperCase()) && !key.toUpperCase().includes('PG') && !key.toUpperCase().includes('POSTGRES') && !key.toUpperCase().includes('DATABASE')) {
      continue;
    }

    if (seenUris.has(value)) {
      continue;
    }
    seenUris.add(value);

    const displayTarget = sanitizePostgresDisplayTarget(value);
    candidates.push({
      label: `${key} (${displayTarget})`,
      sourceFile,
      uri: value,
      displayTarget,
    });
  }

  return candidates;
}

/**
 * Pure lightweight parser extracting local PostgreSQL service credentials from `docker-compose.yml` / `compose.yml`.
 */
export function extractPostgresUrisFromComposeContent(
  content: string,
  sourceFile: string,
): readonly DiscoveredConnectionCandidate[] {
  const lines = content.split(/\r?\n/);
  const candidates: DiscoveredConnectionCandidate[] = [];

  let currentServiceName = '';
  let serviceIndent = -1;
  let isPostgresService = false;
  let user = 'postgres';
  let password = '';
  let db = 'postgres';
  let hostPort = '5432';

  const flushService = (): void => {
    if (!isPostgresService) {
      return;
    }
    const auth = password
      ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}@`
      : `${encodeURIComponent(user)}@`;
    const uri = `postgresql://${auth}localhost:${hostPort}/${encodeURIComponent(db)}`;
    const displayTarget = sanitizePostgresDisplayTarget(uri);
    candidates.push({
      label: `Docker "${currentServiceName}" (${displayTarget})`,
      sourceFile,
      uri,
      displayTarget,
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
      isPostgresService = false;
      continue;
    }

    // Direct child under services: e.g. `postgres:`
    if (serviceIndent === -1 || indent === serviceIndent) {
      const svcMatch = /^([a-zA-Z0-9_-]+)\s*:\s*$/.exec(trimmed);
      if (svcMatch) {
        flushService();
        currentServiceName = svcMatch[1]!;
        serviceIndent = indent;
        isPostgresService = false;
        user = 'postgres';
        password = '';
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
      if (imageName.includes('postgres') || imageName.includes('postgis') || imageName.includes('timescaledb')) {
        isPostgresService = true;
      }
      continue;
    }

    const portMatch = /^-\s*["']?(?:[\d.]+:)?(\d+):5432["']?/.exec(trimmed);
    if (portMatch) {
      hostPort = portMatch[1]!;
      continue;
    }

    // Handles both `POSTGRES_USER: postgres` and `- POSTGRES_USER=postgres`
    const envMatch = /^(?:-\s*)?(POSTGRES_USER|POSTGRES_PASSWORD|POSTGRES_DB)\s*[:=]\s*(.+)$/.exec(trimmed);
    if (envMatch) {
      const envKey = envMatch[1];
      const envVal = stripWrappingQuotes(envMatch[2]!);
      // Skip unresolved ${VAR} templates
      if (envVal.includes('${')) {
        continue;
      }
      if (envKey === 'POSTGRES_USER' && envVal) {
        user = envVal;
      } else if (envKey === 'POSTGRES_PASSWORD') {
        password = envVal;
      } else if (envKey === 'POSTGRES_DB' && envVal) {
        db = envVal;
      }
    }
  }

  flushService();
  return candidates;
}
