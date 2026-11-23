import {
  extractDatabaseUrisFromComposeContent,
  extractDatabaseUrisFromEnvContent,
  extractPostgresUrisFromComposeContent,
  extractPostgresUrisFromEnvContent,
  parseEnvKeyValueMap,
  sanitizeConnectionDisplayTarget,
  sanitizePostgresDisplayTarget,
} from '@query-autopsy/core';
import { describe, expect, it } from 'vitest';

describe('sanitizePostgresDisplayTarget', () => {
  it('strips username and password from PostgreSQL URIs', () => {
    expect(
      sanitizePostgresDisplayTarget(
        'postgresql://admin:supersecret@db.prod.internal:5432/billing',
      ),
    ).toBe('db.prod.internal:5432/billing');
  });
});

describe('extractPostgresUrisFromEnvContent', () => {
  it('extracts quoted, exported, and commented Postgres URIs while ignoring non-Postgres variables', () => {
    const envText = `
      # Local env
      REDIS_URL=redis://localhost:6379
      DATABASE_URL="postgresql://postgres:secret@localhost:5432/app_dev"
      export POSTGRES_URL='postgres://readonly:pw@staging.db:5433/app_staging'
      PG_URL=postgresql://user:pass@127.0.0.1:5432/db # inline comment
      UNRELATED_API_KEY=postgresql_not_a_uri
    `;

    const candidates = extractPostgresUrisFromEnvContent(envText, '.env');
    expect(candidates).toHaveLength(3);
    expect(candidates[0]?.displayTarget).toBe('localhost:5432/app_dev');
    expect(candidates[1]?.displayTarget).toBe('staging.db:5433/app_staging');
    expect(candidates[2]?.displayTarget).toBe('127.0.0.1:5432/db');
  });
});

describe('extractPostgresUrisFromComposeContent', () => {
  it('extracts postgres service credentials and mapped host port while skipping non-postgres services', () => {
    const compose = `
services:
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: queryautopsy
      POSTGRES_DB: query_autopsy_dev
    ports:
      - "5433:5432"
`;

    const candidates = extractPostgresUrisFromComposeContent(
      compose,
      'docker/docker-compose.yml',
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toEqual({
      label: 'Docker "postgres" (localhost:5433/query_autopsy_dev)',
      sourceFile: 'docker/docker-compose.yml',
      uri: 'postgresql://postgres:queryautopsy@localhost:5433/query_autopsy_dev',
      displayTarget: 'localhost:5433/query_autopsy_dev',
    });
  });

  it('resolves ${VAR:-default} and .env placeholders in docker-compose services', () => {
    const envMap = parseEnvKeyValueMap(`
POSTGRES_USER=app_user
POSTGRES_PASSWORD=s3cr@t#pass
PG_PORT=5439
`);

    const composeContent = `
services:
  db:
    image: postgres:16-alpine
    ports:
      - "\${PG_PORT:-5432}:5432"
    environment:
      POSTGRES_USER: "\${POSTGRES_USER:-postgres}"
      POSTGRES_PASSWORD: "\${POSTGRES_PASSWORD}"
      POSTGRES_DB: "\${POSTGRES_DB:-analytics_db}"
`;

    const candidates = extractPostgresUrisFromComposeContent(
      composeContent,
      'docker-compose.yml',
      envMap,
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toEqual({
      label: 'Docker "db" (localhost:5439/analytics_db)',
      sourceFile: 'docker-compose.yml',
      uri: 'postgresql://app_user:s3cr%40t%23pass@localhost:5439/analytics_db',
      displayTarget: 'localhost:5439/analytics_db',
    });
  });

  it('marks candidates with unresolved password variables via needsPasswordPrompt', () => {
    const composeContent = `
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: myuser
      POSTGRES_PASSWORD: \${MISSING_DB_PASSWORD}
      POSTGRES_DB: appdb
`;

    const candidates = extractPostgresUrisFromComposeContent(
      composeContent,
      'compose.yaml',
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toEqual({
      label: 'Docker "postgres" (localhost:5432/appdb)',
      sourceFile: 'compose.yaml',
      uri: 'postgresql://myuser@localhost:5432/appdb',
      displayTarget: 'localhost:5432/appdb',
      needsPasswordPrompt: true,
    });
  });
});

describe('Multi-Engine Database Discovery (v0.4.0)', () => {
  it('extracts MySQL and SQLite URIs from .env and sanitizes display targets', () => {
    const envContent = `
DATABASE_URL="file:./prisma/dev.db"
MYSQL_URL=mysql://shop_user:secret@127.0.0.1:3306/shop_db
`;
    const candidates = extractDatabaseUrisFromEnvContent(envContent, '.env');
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toEqual({
      label: 'DATABASE_URL (dev.db)',
      sourceFile: '.env',
      uri: 'file:./prisma/dev.db',
      displayTarget: 'dev.db',
      engine: 'sqlite',
    });
    expect(candidates[1]).toEqual({
      label: 'MYSQL_URL (127.0.0.1:3306/shop_db)',
      sourceFile: '.env',
      uri: 'mysql://shop_user:secret@127.0.0.1:3306/shop_db',
      displayTarget: '127.0.0.1:3306/shop_db',
      engine: 'mysql',
    });
    expect(sanitizeConnectionDisplayTarget('/tmp/test.sqlite')).toBe('test.sqlite');
  });

  it('extracts mysql and mariadb services from docker-compose.yml', () => {
    const compose = `
services:
  mysql:
    image: mysql:8.4
    ports:
      - "3307:3306"
    environment:
      MYSQL_USER: app
      MYSQL_PASSWORD: secret
      MYSQL_DATABASE: orders_db
`;
    const candidates = extractDatabaseUrisFromComposeContent(
      compose,
      'docker-compose.yml',
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toEqual({
      label: 'Docker "mysql" (localhost:3307/orders_db)',
      sourceFile: 'docker-compose.yml',
      uri: 'mysql://app:secret@localhost:3307/orders_db',
      displayTarget: 'localhost:3307/orders_db',
      engine: 'mysql',
    });
  });

  it('discovers DuckDB URIs from .env files and formats display labels cleanly', () => {
    const envText = `
      DUCKDB_PATH=duckdb:///workspace/analytics/warehouse.duckdb
      ANALYTICS_URL=file:./data/lake.ddb
    `;
    const candidates = extractDatabaseUrisFromEnvContent(envText, '.env');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toEqual({
      label: 'DUCKDB_PATH (warehouse.duckdb)',
      sourceFile: '.env',
      uri: 'duckdb:///workspace/analytics/warehouse.duckdb',
      displayTarget: 'warehouse.duckdb',
      engine: 'duckdb',
    });
  });
});
