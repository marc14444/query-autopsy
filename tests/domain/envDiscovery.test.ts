import { describe, expect, it } from 'vitest';
import { sanitizePostgresDisplayTarget } from '../../src/domain/models/connectionProfile.js';
import {
  extractPostgresUrisFromComposeContent,
  extractPostgresUrisFromEnvContent,
} from '../../src/domain/services/envDiscovery.js';

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
});
