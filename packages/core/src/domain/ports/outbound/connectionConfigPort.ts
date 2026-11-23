import type {
  ConnectionProfile,
  SaveConnectionProfileInput,
} from '../../models/connectionProfile.js';
import type { WorkloadProfile } from '../../models/diagnostic.js';

export interface RuntimeSettings {
  readonly statementTimeoutMs: number;
  readonly allowWriteAnalyze: boolean;
  readonly seqScanRowThreshold: number;
  readonly showRawJson: boolean;
  readonly redactLiteralsInReports?: boolean | undefined;
  readonly workloadProfile?: WorkloadProfile | undefined;
}

export interface ConnectionConfigPort {
  getConnectionString(): Promise<string | undefined>;
  saveConnectionString(connectionString: string): Promise<void>;
  clearConnectionString(): Promise<void>;

  getActiveProfile(): Promise<ConnectionProfile | undefined>;
  listProfiles(): Promise<readonly ConnectionProfile[]>;
  saveProfile(
    profile: SaveConnectionProfileInput,
    connectionString: string,
  ): Promise<ConnectionProfile>;
  setActiveProfile(profileId: string): Promise<void>;
  setProfileReadOnlyLock(
    profileId: string,
    readOnlyLocked: boolean,
  ): Promise<void>;
  deleteProfile(profileId: string): Promise<void>;

  getRuntimeSettings(): RuntimeSettings;
}
