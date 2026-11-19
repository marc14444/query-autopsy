export interface RuntimeSettings {
  readonly statementTimeoutMs: number;
  readonly allowWriteAnalyze: boolean;
  readonly seqScanRowThreshold: number;
  readonly showRawJson: boolean;
}

export interface ConnectionConfigPort {
  getConnectionString(): Promise<string | undefined>;
  saveConnectionString(connectionString: string): Promise<void>;
  clearConnectionString(): Promise<void>;
  getRuntimeSettings(): RuntimeSettings;
}
