import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UnsafeQueryError } from '../../src/domain/errors/domainErrors.js';

const mockConfigGet = vi.hoisted(() => vi.fn());

vi.mock('vscode', () => {
  class MockEventEmitter {
    event = vi.fn();
    fire = vi.fn();
    dispose = vi.fn();
  }

  return {
    EventEmitter: MockEventEmitter,
    workspace: {
      getConfiguration: vi.fn(() => ({
        get: mockConfigGet,
      })),
    },
  };
});

import type * as vscode from 'vscode';
import { VsCodeConnectionStore } from '../../src/infrastructure/vscode/vscodeConnectionStore.js';

function createStore(): VsCodeConnectionStore {
  const secretMap = new Map<string, string>();
  const stateMap = new Map<string, unknown>();

  const secrets: vscode.SecretStorage = {
    get: async (key) => secretMap.get(key),
    store: async (key, value) => {
      secretMap.set(key, value);
    },
    delete: async (key) => {
      secretMap.delete(key);
    },
    keys: async () => Array.from(secretMap.keys()),
    onDidChange: vi.fn() as unknown as vscode.Event<vscode.SecretStorageChangeEvent>,
  };

  const state: vscode.Memento = {
    keys: () => Array.from(stateMap.keys()),
    get: <T>(key: string, defaultValue?: T): T =>
      (stateMap.has(key) ? stateMap.get(key) : defaultValue) as T,
    update: async (key, value) => {
      stateMap.set(key, value);
    },
  };

  return new VsCodeConnectionStore(secrets, state);
}

describe('VsCodeConnectionStore security guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refuses plaintext passwords in fallbackConnectionString settings', async () => {
    mockConfigGet.mockImplementation((key: string, fallback: unknown) => {
      if (key === 'postgres.fallbackConnectionString') {
        return 'postgresql://postgres:supersecret@localhost:5432/app';
      }
      return fallback;
    });

    const store = createStore();
    await expect(store.getConnectionString()).rejects.toThrow(UnsafeQueryError);
  });

  it('allows passwordless local fallbackConnectionString URIs when no profile exists', async () => {
    mockConfigGet.mockImplementation((key: string, fallback: unknown) => {
      if (key === 'postgres.fallbackConnectionString') {
        return 'postgresql://postgres@localhost:5432/query_autopsy_dev';
      }
      return fallback;
    });

    const store = createStore();
    await expect(store.getConnectionString()).resolves.toBe(
      'postgresql://postgres@localhost:5432/query_autopsy_dev',
    );
  });
});
