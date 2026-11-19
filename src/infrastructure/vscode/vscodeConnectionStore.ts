import * as vscode from 'vscode';
import {
  type ConnectionProfile,
  type SaveConnectionProfileInput,
  sanitizeConnectionDisplayTarget,
} from '../../domain/models/connectionProfile.js';
import { detectDatabaseEngineFromUri } from '../../domain/models/databaseEngine.js';
import type {
  ConnectionConfigPort,
  RuntimeSettings,
} from '../../domain/ports/outbound/connectionConfigPort.js';

const LEGACY_SECRET_CONNECTION_KEY = 'queryAutopsy.postgres.connectionString';
const PROFILE_SECRET_PREFIX = 'queryAutopsy.postgres.profile.';
const PROFILES_STATE_KEY = 'queryAutopsy.profiles';
const ACTIVE_PROFILE_STATE_KEY = 'queryAutopsy.activeProfileId';

export class VsCodeConnectionStore
  implements ConnectionConfigPort, vscode.Disposable
{
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeProfile = this.changeEmitter.event;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly state: vscode.Memento,
  ) {}

  private profileSecretKey(profileId: string): string {
    return `${PROFILE_SECRET_PREFIX}${profileId}`;
  }

  private async ensureMigrated(): Promise<void> {
    const existing = this.state.get<ConnectionProfile[]>(PROFILES_STATE_KEY);
    if (existing && existing.length > 0) {
      return;
    }

    const legacyDsn = await this.secrets.get(LEGACY_SECRET_CONNECTION_KEY);
    if (!legacyDsn || !legacyDsn.trim()) {
      return;
    }

    const trimmed = legacyDsn.trim();
    const migrated: ConnectionProfile = {
      id: 'default',
      name: 'Local Default',
      engine: detectDatabaseEngineFromUri(trimmed),
      environment: 'local',
      readOnlyLocked: false,
      displayTarget: sanitizeConnectionDisplayTarget(trimmed),
    };

    await this.secrets.store(this.profileSecretKey(migrated.id), trimmed);
    await this.state.update(PROFILES_STATE_KEY, [migrated]);
    await this.state.update(ACTIVE_PROFILE_STATE_KEY, migrated.id);
    await this.secrets.delete(LEGACY_SECRET_CONNECTION_KEY);
  }

  async listProfiles(): Promise<readonly ConnectionProfile[]> {
    await this.ensureMigrated();
    return this.state.get<ConnectionProfile[]>(PROFILES_STATE_KEY, []);
  }

  async getActiveProfile(): Promise<ConnectionProfile | undefined> {
    const profiles = await this.listProfiles();
    if (profiles.length === 0) {
      return undefined;
    }
    const activeId = this.state.get<string>(ACTIVE_PROFILE_STATE_KEY);
    return (
      profiles.find((p) => p.id === activeId) ?? profiles[0]
    );
  }

  async saveProfile(
    input: SaveConnectionProfileInput,
    connectionString: string,
  ): Promise<ConnectionProfile> {
    await this.ensureMigrated();
    const trimmedDsn = connectionString.trim();
    const engine = input.engine ?? detectDatabaseEngineFromUri(trimmedDsn);
    const profile: ConnectionProfile = {
      id: input.id,
      name: input.name.trim(),
      engine,
      environment: input.environment,
      readOnlyLocked: input.readOnlyLocked,
      displayTarget: sanitizeConnectionDisplayTarget(trimmedDsn, engine),
    };

    const existing = this.state.get<ConnectionProfile[]>(PROFILES_STATE_KEY, []);
    const idx = existing.findIndex((p) => p.id === profile.id);
    const updated =
      idx >= 0
        ? existing.map((p, i) => (i === idx ? profile : p))
        : [...existing, profile];

    await this.secrets.store(this.profileSecretKey(profile.id), trimmedDsn);
    await this.state.update(PROFILES_STATE_KEY, updated);
    await this.state.update(ACTIVE_PROFILE_STATE_KEY, profile.id);
    this.changeEmitter.fire();
    return profile;
  }

  async setProfileReadOnlyLock(
    profileId: string,
    readOnlyLocked: boolean,
  ): Promise<void> {
    const existing = await this.listProfiles();
    const updated = existing.map((p) =>
      p.id === profileId ? { ...p, readOnlyLocked } : p,
    );
    await this.state.update(PROFILES_STATE_KEY, updated);
    this.changeEmitter.fire();
  }

  async setActiveProfile(profileId: string): Promise<void> {
    const profiles = await this.listProfiles();
    if (!profiles.some((p) => p.id === profileId)) {
      return;
    }
    await this.state.update(ACTIVE_PROFILE_STATE_KEY, profileId);
    this.changeEmitter.fire();
  }

  async deleteProfile(profileId: string): Promise<void> {
    const profiles = await this.listProfiles();
    const remaining = profiles.filter((p) => p.id !== profileId);
    await this.secrets.delete(this.profileSecretKey(profileId));
    await this.state.update(PROFILES_STATE_KEY, remaining);

    const activeId = this.state.get<string>(ACTIVE_PROFILE_STATE_KEY);
    if (activeId === profileId) {
      await this.state.update(ACTIVE_PROFILE_STATE_KEY, remaining[0]?.id);
    }
    this.changeEmitter.fire();
  }

  async getConnectionString(): Promise<string | undefined> {
    const active = await this.getActiveProfile();
    if (active) {
      const secretDsn = await this.secrets.get(
        this.profileSecretKey(active.id),
      );
      if (secretDsn && secretDsn.trim().length > 0) {
        return secretDsn.trim();
      }
    }

    const config = vscode.workspace.getConfiguration('queryAutopsy');
    const fallbackDsn = config.get<string>(
      'postgres.fallbackConnectionString',
      '',
    );
    return fallbackDsn.trim().length > 0 ? fallbackDsn.trim() : undefined;
  }

  async saveConnectionString(connectionString: string): Promise<void> {
    const active = await this.getActiveProfile();
    if (active) {
      await this.saveProfile(
        {
          id: active.id,
          name: active.name,
          engine: active.engine ?? detectDatabaseEngineFromUri(connectionString),
          environment: active.environment,
          readOnlyLocked: active.readOnlyLocked,
        },
        connectionString,
      );
      return;
    }

    await this.saveProfile(
      {
        id: 'default',
        name: 'Local Default',
        engine: detectDatabaseEngineFromUri(connectionString),
        environment: 'local',
        readOnlyLocked: false,
      },
      connectionString,
    );
  }

  async clearConnectionString(): Promise<void> {
    const profiles = await this.listProfiles();
    for (const profile of profiles) {
      await this.secrets.delete(this.profileSecretKey(profile.id));
    }
    await this.secrets.delete(LEGACY_SECRET_CONNECTION_KEY);
    await this.state.update(PROFILES_STATE_KEY, []);
    await this.state.update(ACTIVE_PROFILE_STATE_KEY, undefined);
    this.changeEmitter.fire();
  }

  getRuntimeSettings(): RuntimeSettings {
    const config = vscode.workspace.getConfiguration('queryAutopsy');
    return {
      statementTimeoutMs: config.get<number>(
        'postgres.statementTimeoutMs',
        5000,
      ),
      allowWriteAnalyze: config.get<boolean>(
        'postgres.allowWriteAnalyze',
        false,
      ),
      seqScanRowThreshold: config.get<number>(
        'diagnostics.seqScanRowThreshold',
        1000,
      ),
      showRawJson: config.get<boolean>('output.showRawJson', false),
    };
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}
