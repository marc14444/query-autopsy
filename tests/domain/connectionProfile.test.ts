import {
  assertSafeProfileConnection,
  type ConnectionProfile,
  connectionUriHasPlaintextPassword,
  extractConnectionHost,
  isLoopbackHost,
  isRemoteUnsafeSslUri,
  UnsafeQueryError,
  usesSslNoVerify,
} from '@query-autopsy/core';
import { describe, expect, it } from 'vitest';

describe('connectionProfile security helpers', () => {
  it('identifies loopback vs remote hostnames accurately', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('app.localhost')).toBe(true);
    expect(isLoopbackHost('db.internal.example.com')).toBe(false);
    expect(isLoopbackHost('10.0.1.5')).toBe(false);
  });

  it('detects plaintext passwords in fallback URIs while allowing passwordless local URIs', () => {
    expect(
      connectionUriHasPlaintextPassword(
        'postgresql://postgres:secret@localhost:5432/query_autopsy_dev',
      ),
    ).toBe(true);
    expect(
      connectionUriHasPlaintextPassword(
        'mysql2://app:pass@127.0.0.1:3306/app',
      ),
    ).toBe(true);
    expect(
      connectionUriHasPlaintextPassword(
        'postgresql://postgres@localhost:5432/app?password=secret',
      ),
    ).toBe(true);

    expect(
      connectionUriHasPlaintextPassword(
        'postgresql://postgres@localhost:5432/query_autopsy_dev',
      ),
    ).toBe(false);
    expect(
      connectionUriHasPlaintextPassword('sqlite:///tmp/local.db', 'sqlite'),
    ).toBe(false);
  });

  it('flags remote sslmode=no-verify URIs and forbids them on production profiles', () => {
    const remoteNoVerify =
      'postgresql://user:pw@prod-db.internal:5432/billing?sslmode=no-verify';
    const localNoVerify =
      'postgresql://user:pw@127.0.0.1:5432/dev?sslmode=no-verify';
    const remoteVerified =
      'postgresql://user:pw@prod-db.internal:5432/billing?sslmode=require';

    expect(extractConnectionHost(remoteNoVerify)).toBe('prod-db.internal');
    expect(usesSslNoVerify(remoteNoVerify)).toBe(true);
    expect(isRemoteUnsafeSslUri(remoteNoVerify)).toBe(true);
    expect(isRemoteUnsafeSslUri(localNoVerify)).toBe(false);
    expect(isRemoteUnsafeSslUri(remoteVerified)).toBe(false);

    const prodProfile: ConnectionProfile = {
      id: 'prod',
      name: 'Prod DB',
      engine: 'postgresql',
      environment: 'production',
      readOnlyLocked: true,
      displayTarget: 'prod-db.internal:5432/billing',
    };

    expect(() =>
      assertSafeProfileConnection(prodProfile, remoteNoVerify),
    ).toThrow(UnsafeQueryError);
    expect(() =>
      assertSafeProfileConnection(prodProfile, remoteVerified),
    ).not.toThrow();
    expect(() =>
      assertSafeProfileConnection(prodProfile, localNoVerify),
    ).not.toThrow();
  });
});
