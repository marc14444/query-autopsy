import {
  type ConnectionProfile,
  inferDefaultReadOnlyLock,
  type ProfileEnvironment,
  sanitizeConnectionDisplayTarget,
  type SaveConnectionProfileInput,
} from '../../domain/models/connectionProfile.js';
import {
  type DatabaseEngine,
  detectDatabaseEngineFromUri,
} from '../../domain/models/databaseEngine.js';
import type {
  ConnectionConfigPort,
  RuntimeSettings,
} from '../../domain/ports/outbound/connectionConfigPort.js';

export interface StaticConnectionConfigOptions {
  readonly connectionString?: string | undefined;
  readonly runtimeSettings: RuntimeSettings;
  readonly environment: ProfileEnvironment;
  readonly engine?: DatabaseEngine | undefined;
  readonly profileId?: string | undefined;
  readonly forceReadOnlyLock?: boolean | undefined;
}

/**
 * Immutable ConnectionConfigPort adapter for stateless CLI / CI / MCP adapters.
 */
export class StaticConnectionConfig implements ConnectionConfigPort {
  private readonly connectionString: string | undefined;
  private readonly runtimeSettings: RuntimeSettings;
  private readonly profile: ConnectionProfile;

  constructor(options: StaticConnectionConfigOptions) {
    this.connectionString = options.connectionString;
    this.runtimeSettings = options.runtimeSettings;

    const engine =
      options.engine ??
      (options.connectionString
        ? detectDatabaseEngineFromUri(options.connectionString)
        : 'postgresql');
    const displayTarget = options.connectionString
      ? sanitizeConnectionDisplayTarget(options.connectionString, engine)
      : 'offline';

    this.profile = {
      id: options.profileId ?? 'static-target',
      name: options.connectionString ? displayTarget : 'offline',
      engine,
      environment: options.environment,
      readOnlyLocked:
        options.forceReadOnlyLock ??
        inferDefaultReadOnlyLock(options.environment),
      displayTarget,
    };
  }

  async getConnectionString(): Promise<string | undefined> {
    return this.connectionString;
  }

  async saveConnectionString(_connectionString: string): Promise<void> {}
  async clearConnectionString(): Promise<void> {}

  async getActiveProfile(): Promise<ConnectionProfile | undefined> {
    return this.profile;
  }

  async listProfiles(): Promise<readonly ConnectionProfile[]> {
    return [this.profile];
  }

  async saveProfile(
    _profile: SaveConnectionProfileInput,
    _connectionString: string,
  ): Promise<ConnectionProfile> {
    return this.profile;
  }

  async setActiveProfile(_profileId: string): Promise<void> {}
  async setProfileReadOnlyLock(
    _profileId: string,
    _readOnlyLocked: boolean,
  ): Promise<void> {}
  async deleteProfile(_profileId: string): Promise<void> {}

  getRuntimeSettings(): RuntimeSettings {
    return this.runtimeSettings;
  }
}
