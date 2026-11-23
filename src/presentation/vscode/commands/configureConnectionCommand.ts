import {
  type ConnectionConfigPort,
  type DatabaseEngine,
  detectDatabaseEngineFromUri,
  type DiscoveredConnectionCandidate,
  extractConnectionHost,
  formatEngineLabel,
  isLoopbackHost,
  isRemoteUnsafeSslUri,
  type LoggerPort,
  type ProfileEnvironment,
  type QueryExecutorPort,
  resolveProfileEngine,
  sanitizeConnectionDisplayTarget,
} from '@query-autopsy/core';
import * as vscode from 'vscode';

export type DiscoverConnectionsFn = () => Promise<
  readonly DiscoveredConnectionCandidate[]
>;

export function validateConnectionUri(
  value: string,
  expectedEngine?: DatabaseEngine,
): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return 'Connection URI or path cannot be empty.';
  }

  const detected = detectDatabaseEngineFromUri(trimmed);
  const engine = expectedEngine ?? detected;

  if (engine === 'sqlite') {
    if (
      trimmed.toLowerCase() === ':memory:' ||
      trimmed.toLowerCase().startsWith('sqlite:') ||
      trimmed.toLowerCase().startsWith('file:') ||
      /\.(?:sqlite3?|db)(?:$|\?)/i.test(trimmed)
    ) {
      return undefined;
    }
    return 'Enter a .sqlite/.db file path, "sqlite:///path/to/app.db", or ":memory:".';
  }

  if (engine === 'duckdb') {
    if (
      trimmed.toLowerCase() === ':memory:' ||
      trimmed.toLowerCase() === ':memory:duckdb' ||
      trimmed.toLowerCase().startsWith('duckdb:') ||
      trimmed.toLowerCase().startsWith('file:') ||
      /\.(?:duckdb|ddb)(?:$|\?)/i.test(trimmed)
    ) {
      return undefined;
    }
    return 'Enter a .duckdb/.ddb file path, "duckdb:///path/to/analytics.duckdb", or ":memory:duckdb".';
  }

  const allowedPrefixes =
    engine === 'mysql'
      ? ['mysql://', 'mysql2://']
      : ['postgres://', 'postgresql://'];

  if (!allowedPrefixes.some((p) => trimmed.toLowerCase().startsWith(p))) {
    return engine === 'mysql'
      ? 'MySQL URI must start with "mysql://" or "mysql2://".'
      : 'PostgreSQL URI must start with "postgres://" or "postgresql://".';
  }

  const atCount = (trimmed.match(/@/g) ?? []).length;
  if (atCount > 1) {
    return 'Password contains an unencoded "@". Replace "@" in password with "%40" or use Guided Setup.';
  }

  try {
    const normalizedForUrl = trimmed.replace(/^mysql2:\/\//i, 'mysql://');
    const parsed = new URL(normalizedForUrl);
    if (!parsed.hostname) {
      return 'URI must include a hostname (e.g. 127.0.0.1). If your password contains "#", replace it with "%23" or use Guided Setup.';
    }
    if (parsed.hash) {
      return 'Unencoded "#" detected in URI. Encode "#" as "%23" or use Guided Setup.';
    }
  } catch {
    return 'Invalid URI format. If your password has special characters (@, #, /), use Guided Setup.';
  }

  return undefined;
}

export function validatePostgresUri(value: string): string | undefined {
  return validateConnectionUri(value, 'postgresql');
}

function toProfileId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || `profile-${Date.now()}`;
}

async function promptEngineChoice(): Promise<DatabaseEngine | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: '$(database) PostgreSQL',
        description: 'EXPLAIN (ANALYZE, BUFFERS) · HypoPG What-If · pg',
        engine: 'postgresql' as const,
      },
      {
        label: '$(database) MySQL 8+ / MariaDB',
        description: 'EXPLAIN ANALYZE / FORMAT=JSON · Filesort & Full Scan rules',
        engine: 'mysql' as const,
      },
      {
        label: '$(file-binary) SQLite (.sqlite / .db)',
        description: 'EXPLAIN QUERY PLAN in local WASM (zero disk mutation)',
        engine: 'sqlite' as const,
      },
      {
        label: '$(file-binary) DuckDB (.duckdb / Parquet / CSV)',
        description: 'Columnar & Parquet EXPLAIN via local DuckDB (-readonly)',
        engine: 'duckdb' as const,
      },
    ],
    {
      title: 'QueryAutopsy: Select Database Engine',
      ignoreFocusOut: true,
    },
  );
  return picked?.engine;
}

async function promptEnvironmentChoice(
  defaultEnv: ProfileEnvironment = 'local',
): Promise<
  { environment: ProfileEnvironment; readOnlyLocked: boolean } | undefined
> {
  const items: Array<
    vscode.QuickPickItem & {
      environment: ProfileEnvironment;
      readOnlyLocked: boolean;
    }
  > = [
    {
      label: '$(home) Local Development',
      description: 'Read/Write EXPLAIN allowed per settings (unlocked)',
      environment: 'local',
      readOnlyLocked: false,
      picked: defaultEnv === 'local',
    },
    {
      label: '$(shield) Staging (Read-Only Locked)',
      description: 'Blocks WRITE EXPLAIN ANALYZE and Create Index QuickFix',
      environment: 'staging',
      readOnlyLocked: true,
      picked: defaultEnv === 'staging',
    },
    {
      label: '$(lock) Production (Read-Only Locked)',
      description: 'Strict safety lock — Read-Only EXPLAIN & Estimate only',
      environment: 'production',
      readOnlyLocked: true,
      picked: defaultEnv === 'production',
    },
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: 'QueryAutopsy: Select Environment Safety Level',
    ignoreFocusOut: true,
  });

  return picked
    ? {
        environment: picked.environment,
        readOnlyLocked: picked.readOnlyLocked,
      }
    : undefined;
}

async function promptGuidedNetworkDbUri(
  engine: 'postgresql' | 'mysql',
): Promise<string | undefined> {
  const isMysql = engine === 'mysql';
  const engineLabel = formatEngineLabel(engine);
  const defaultPort = isMysql ? '3306' : '5432';
  const defaultUser = isMysql ? 'root' : 'postgres';
  const defaultDb = isMysql ? '' : 'postgres';

  const host = await vscode.window.showInputBox({
    title: `QueryAutopsy ${engineLabel} (1/6): Host`,
    prompt: `Use 127.0.0.1 for local Docker containers (avoids IPv6 localhost port conflicts on :${defaultPort})`,
    value: '127.0.0.1',
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : 'Host is required.'),
  });
  if (!host) {
    return undefined;
  }

  const port = await vscode.window.showInputBox({
    title: `QueryAutopsy ${engineLabel} (2/6): Port`,
    prompt: `Host port mapped to ${engineLabel} (default ${defaultPort})`,
    value: defaultPort,
    ignoreFocusOut: true,
    validateInput: (v) => {
      const n = Number(v.trim());
      return Number.isInteger(n) && n >= 1 && n <= 65535
        ? undefined
        : 'Enter a valid port (1–65535).';
    },
  });
  if (!port) {
    return undefined;
  }

  const database = await vscode.window.showInputBox({
    title: `QueryAutopsy ${engineLabel} (3/6): Database Name`,
    prompt: isMysql
      ? 'Target schema/database name (leave empty if qualifying tables in SQL)'
      : 'Target PostgreSQL database name',
    value: defaultDb,
    ignoreFocusOut: true,
    validateInput: (v) =>
      isMysql || v.trim() ? undefined : 'Database name is required.',
  });
  if (database === undefined) {
    return undefined;
  }

  const user = await vscode.window.showInputBox({
    title: `QueryAutopsy ${engineLabel} (4/6): Username`,
    value: defaultUser,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : 'Username is required.'),
  });
  if (!user) {
    return undefined;
  }

  const password = await vscode.window.showInputBox({
    title: `QueryAutopsy ${engineLabel} (5/6): Password`,
    prompt:
      'Special characters (@, #, /) are automatically encoded safely (leave empty if none)',
    password: true,
    ignoreFocusOut: true,
  });
  if (password === undefined) {
    return undefined;
  }

  const sslChoice = await vscode.window.showQuickPick(
    [
      {
        label: 'Disable SSL (Standard for local Docker / localhost)',
        queryParam: '',
      },
      {
        label: 'Require SSL — No Verify (Self-signed Docker / Cloud dev)',
        queryParam: '?sslmode=no-verify',
      },
      {
        label: 'Require SSL — Strict Certificate Verification',
        queryParam: '?sslmode=require',
      },
    ],
    {
      title: `QueryAutopsy ${engineLabel} (6/6): SSL Mode`,
      ignoreFocusOut: true,
    },
  );
  if (!sslChoice) {
    return undefined;
  }

  const scheme = isMysql ? 'mysql' : 'postgresql';
  const auth = password
    ? `${encodeURIComponent(user.trim())}:${encodeURIComponent(password)}@`
    : `${encodeURIComponent(user.trim())}@`;
  const dbPath = database.trim() ? `/${encodeURIComponent(database.trim())}` : '/';

  return `${scheme}://${auth}${host.trim()}:${port.trim()}${dbPath}${sslChoice.queryParam}`;
}

async function promptLocalFileConnectionUri(
  engine: 'sqlite' | 'duckdb',
): Promise<string | undefined> {
  const isDuckDb = engine === 'duckdb';
  const label = isDuckDb ? 'DuckDB' : 'SQLite';
  const memToken = isDuckDb ? ':memory:duckdb' : ':memory:';

  const method = await vscode.window.showQuickPick(
    [
      {
        label: isDuckDb
          ? '$(folder-opened) Browse local .duckdb / .ddb file...'
          : '$(folder-opened) Browse local .sqlite / .db file...',
        description: isDuckDb
          ? 'Inspects plans safely in DuckDB -readonly mode'
          : 'Reads an isolated in-memory WASM copy for safe EXPLAIN',
        mode: 'browse' as const,
      },
      {
        label: `$(edit) Enter ${label} path or "${memToken}"`,
        description: isDuckDb
          ? 'e.g. /path/to/warehouse.duckdb or ":memory:duckdb" for read_parquet()'
          : 'e.g. /path/to/app.db or sqlite:///path/to/app.db',
        mode: 'manual' as const,
      },
    ],
    {
      title: `QueryAutopsy ${label}: Choose Database File`,
      ignoreFocusOut: true,
    },
  );
  if (!method) {
    return undefined;
  }

  if (method.mode === 'browse') {
    const defaultUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    const pickedFiles = await vscode.window.showOpenDialog({
      canSelectMany: false,
      ...(defaultUri ? { defaultUri } : {}),
      openLabel: `Select ${label} Database`,
      filters: {
        ...(isDuckDb
          ? { 'DuckDB Databases': ['duckdb', 'ddb'] }
          : { 'SQLite Databases': ['sqlite', 'sqlite3', 'db'] }),
        'All Files': ['*'],
      },
    });
    const selected = pickedFiles?.[0];
    return selected ? `${engine}://${selected.fsPath}` : undefined;
  }

  const rawPath = await vscode.window.showInputBox({
    title: `QueryAutopsy ${label}: File Path`,
    prompt: `Enter path to database file or ${memToken}`,
    placeHolder: isDuckDb
      ? '/path/to/analytics.duckdb or :memory:duckdb'
      : '/path/to/prisma/dev.db',
    ignoreFocusOut: true,
    validateInput: (val) => validateConnectionUri(val, engine),
  });
  if (!rawPath) {
    return undefined;
  }
  const trimmed = rawPath.trim();
  const lower = trimmed.toLowerCase();
  if (lower === ':memory:' || lower === ':memory:duckdb') {
    return isDuckDb ? ':memory:duckdb' : ':memory:';
  }
  if (
    lower.startsWith(`${engine}:`) ||
    lower.startsWith('file:')
  ) {
    return trimmed;
  }
  return `${engine}://${trimmed}`;
}

async function promptConnectionUriForEngine(
  engine: DatabaseEngine,
  title: string,
): Promise<string | undefined> {
  if (engine === 'sqlite' || engine === 'duckdb') {
    return promptLocalFileConnectionUri(engine);
  }

  const engineLabel = formatEngineLabel(engine);
  const modePick = await vscode.window.showQuickPick(
    [
      {
        label: `$(key) Guided Setup (Host, Port, DB, User, Password)`,
        description:
          'Recommended for Docker or passwords containing special characters (@, #, /)',
        mode: 'guided' as const,
      },
      {
        label: `$(link) Paste ${engineLabel} Connection URI`,
        description:
          engine === 'mysql'
            ? 'mysql://user:pass@127.0.0.1:3306/dbname'
            : 'postgresql://user:pass@127.0.0.1:5432/dbname',
        mode: 'uri' as const,
      },
    ],
    {
      title,
      ignoreFocusOut: true,
    },
  );
  if (!modePick) {
    return undefined;
  }

  if (modePick.mode === 'guided') {
    return promptGuidedNetworkDbUri(engine);
  }

  const uriInput = await vscode.window.showInputBox({
    title: `QueryAutopsy: ${engineLabel} Connection URI`,
    prompt: `Enter your ${engineLabel} connection URI (stored encrypted in VS Code SecretStorage)`,
    placeHolder:
      engine === 'mysql'
        ? 'mysql://root:password@127.0.0.1:3306/mydb'
        : 'postgresql://postgres:password@127.0.0.1:5432/mydb',
    password: true,
    ignoreFocusOut: true,
    validateInput: (val) => validateConnectionUri(val, engine),
  });

  return uriInput?.trim();
}

async function verifyAndSaveProfile(
  connectionConfig: ConnectionConfigPort,
  queryExecutor: QueryExecutorPort,
  logger: LoggerPort,
  id: string,
  name: string,
  engine: DatabaseEngine,
  environment: ProfileEnvironment,
  readOnlyLocked: boolean,
  uri: string,
): Promise<boolean> {
  const trimmedUri = uri.trim();

  if (isRemoteUnsafeSslUri(trimmedUri, engine)) {
    const targetHost = extractConnectionHost(trimmedUri, engine) ?? 'remote host';
    if (environment === 'production') {
      logger.warn('Blocked insecure sslmode=no-verify on remote production host', {
        profileId: id,
        engine,
      });
      void vscode.window.showErrorMessage(
        `QueryAutopsy: Production profile "${name}" cannot use "?sslmode=no-verify" on remote host "${targetHost}". Use "?sslmode=require" to verify TLS certificates.`,
      );
      return false;
    }

    const tlsConfirm = await vscode.window.showWarningMessage(
      `TLS certificate verification is disabled (?sslmode=no-verify) for remote host "${targetHost}". Only continue for trusted self-signed dev servers.`,
      { modal: true },
      'Save & Connect Anyway',
    );
    if (tlsConfirm !== 'Save & Connect Anyway') {
      return false;
    }
  }

  try {
    const versionInfo = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `QueryAutopsy: Testing ${formatEngineLabel(engine)} connection "${name}"...`,
        cancellable: false,
      },
      async () => queryExecutor.testConnection(trimmedUri),
    );

    await connectionConfig.saveProfile(
      { id, name, engine, environment, readOnlyLocked },
      trimmedUri,
    );
    logger.info('Database profile verified and saved', {
      profileId: id,
      engine,
      environment,
      readOnlyLocked,
    });
    if (versionInfo.isSuperuser) {
      void vscode.window.showWarningMessage(
        `QueryAutopsy [${name}]: Connected as a PostgreSQL superuser (${versionInfo.serverVersion.split(',')[0]}). Prefer a least-privilege read-only role outside local dev.`,
      );
    } else {
      void vscode.window.showInformationMessage(
        `QueryAutopsy [${name}]: Connected (${versionInfo.serverVersion.split(',')[0]})`,
      );
    }
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Database connection test failed', {
      profileId: id,
      engine,
      message,
    });

    const choice = await vscode.window.showErrorMessage(
      `Connection failed for "${name}": ${message}`,
      'Retry',
      'Save Anyway',
      'Cancel',
    );
    if (choice === 'Retry') {
      const retryUri = await promptConnectionUriForEngine(
        engine,
        `QueryAutopsy: Update URI for "${name}"`,
      );
      if (retryUri) {
        return verifyAndSaveProfile(
          connectionConfig,
          queryExecutor,
          logger,
          id,
          name,
          engine,
          environment,
          readOnlyLocked,
          retryUri,
        );
      }
      return false;
    }
    if (choice === 'Save Anyway') {
      await connectionConfig.saveProfile(
        { id, name, engine, environment, readOnlyLocked },
        trimmedUri,
      );
      void vscode.window.showWarningMessage(
        `QueryAutopsy profile "${name}" saved (unverified).`,
      );
      return true;
    }
    return false;
  }
}

async function runAddManualProfileFlow(
  connectionConfig: ConnectionConfigPort,
  queryExecutor: QueryExecutorPort,
  logger: LoggerPort,
): Promise<boolean> {
  const engine = await promptEngineChoice();
  if (!engine) {
    return false;
  }

  const trimmedUri = await promptConnectionUriForEngine(
    engine,
    `QueryAutopsy (${formatEngineLabel(engine)}): Choose Input Method`,
  );
  if (!trimmedUri) {
    return false;
  }

  const suggestedName = sanitizeConnectionDisplayTarget(trimmedUri, engine);
  const nameInput = await vscode.window.showInputBox({
    title: 'QueryAutopsy: Profile Name',
    prompt: 'Give this connection profile a recognizable name',
    value: suggestedName,
    placeHolder: 'local-pg, mysql-dev, sqlite-local',
    ignoreFocusOut: true,
    validateInput: (val) =>
      val.trim().length > 0 ? undefined : 'Profile name cannot be empty.',
  });

  if (!nameInput) {
    return false;
  }

  const lowerName = nameInput.toLowerCase();
  const defaultEnv: ProfileEnvironment = lowerName.includes('prod')
    ? 'production'
    : lowerName.includes('stag')
      ? 'staging'
      : 'local';

  const envChoice = await promptEnvironmentChoice(defaultEnv);
  if (!envChoice) {
    return false;
  }

  return verifyAndSaveProfile(
    connectionConfig,
    queryExecutor,
    logger,
    toProfileId(nameInput),
    nameInput.trim(),
    engine,
    envChoice.environment,
    envChoice.readOnlyLocked,
    trimmedUri,
  );
}

export async function runAutoDetectConnectionCommand(
  connectionConfig: ConnectionConfigPort,
  queryExecutor: QueryExecutorPort,
  discoverConnections: DiscoverConnectionsFn,
  logger: LoggerPort,
): Promise<boolean> {
  if (!vscode.workspace.isTrusted) {
    void vscode.window.showWarningMessage(
      'QueryAutopsy: Auto-detecting databases from .env / docker-compose is disabled in Untrusted Workspaces.',
    );
    return false;
  }

  const candidates = await discoverConnections();
  if (candidates.length === 0) {
    void vscode.window.showInformationMessage(
      'QueryAutopsy: No local databases found in .env, docker-compose, or workspace .sqlite files. Launching manual setup.',
    );
    return runAddManualProfileFlow(connectionConfig, queryExecutor, logger);
  }

  const picked = await vscode.window.showQuickPick(
    candidates.map((c) => {
      const eng = c.engine ?? detectDatabaseEngineFromUri(c.uri);
      return {
        label: `$(database) [${formatEngineLabel(eng)}] ${c.label}`,
        description: `from ${c.sourceFile}${c.needsPasswordPrompt ? ' · password required' : ''}`,
        candidate: c,
        engine: eng,
      };
    }),
    {
      title: 'QueryAutopsy: Select Detected Database Connection',
      placeHolder:
        'Choose a discovered local connection (stored in VS Code SecretStorage)',
      ignoreFocusOut: true,
    },
  );

  if (!picked) {
    return false;
  }

  let finalUri = picked.candidate.uri;
  if (picked.candidate.needsPasswordPrompt) {
    const pw = await vscode.window.showInputBox({
      title: `QueryAutopsy: Password for ${picked.candidate.displayTarget}`,
      prompt:
        'docker-compose references an unresolved password variable — enter the password to connect',
      password: true,
      ignoreFocusOut: true,
    });
    if (pw === undefined) {
      return false;
    }
    if (pw.length > 0) {
      const parsed = new URL(finalUri);
      parsed.password = encodeURIComponent(pw);
      finalUri = parsed.toString();
    }
  }

  const discoveredHost = extractConnectionHost(finalUri, picked.engine);
  const defaultDiscoveredEnv: ProfileEnvironment =
    discoveredHost && !isLoopbackHost(discoveredHost) ? 'staging' : 'local';

  const envChoice = await promptEnvironmentChoice(defaultDiscoveredEnv);
  if (!envChoice) {
    return false;
  }

  return verifyAndSaveProfile(
    connectionConfig,
    queryExecutor,
    logger,
    toProfileId(picked.candidate.displayTarget),
    picked.candidate.displayTarget,
    picked.engine,
    envChoice.environment,
    envChoice.readOnlyLocked,
    finalUri,
  );
}

export async function runConfigureConnectionCommand(
  connectionConfig: ConnectionConfigPort,
  queryExecutor: QueryExecutorPort,
  discoverConnections: DiscoverConnectionsFn,
  logger: LoggerPort,
): Promise<boolean> {
  const profiles = await connectionConfig.listProfiles();
  const activeProfile = await connectionConfig.getActiveProfile();

  if (profiles.length === 0) {
    const discovered = await discoverConnections();
    if (discovered.length > 0) {
      const setupChoice = await vscode.window.showQuickPick(
        [
          {
            label: `$(search) Auto-detect from workspace (${discovered.length} found)`,
            description: discovered.map((d) => d.sourceFile).join(', '),
            action: 'discover' as const,
          },
          {
            label: '$(key) Add Database Profile (PostgreSQL / MySQL / SQLite)...',
            description: 'Stored encrypted in VS Code SecretStorage',
            action: 'manual' as const,
          },
        ],
        {
          title: 'QueryAutopsy: Connect to Database',
          ignoreFocusOut: true,
        },
      );
      if (!setupChoice) {
        return false;
      }
      return setupChoice.action === 'discover'
        ? runAutoDetectConnectionCommand(
            connectionConfig,
            queryExecutor,
            discoverConnections,
            logger,
          )
        : runAddManualProfileFlow(connectionConfig, queryExecutor, logger);
    }

    return runAddManualProfileFlow(connectionConfig, queryExecutor, logger);
  }

  type MenuAction =
    | { kind: 'switch'; profileId: string }
    | { kind: 'edit-active' }
    | { kind: 'add' }
    | { kind: 'discover' }
    | { kind: 'toggle-lock' }
    | { kind: 'delete' };

  const items: Array<vscode.QuickPickItem & { action: MenuAction }> =
    profiles.map((p) => {
      const isActive = p.id === activeProfile?.id;
      const engLabel = formatEngineLabel(resolveProfileEngine(p));
      const lockBadge = p.readOnlyLocked ? '$(lock) Read-Only' : '$(unlock) Dev';
      return {
        label: `${isActive ? '$(check) ' : ''}${p.name}`,
        description: `${engLabel} · ${p.displayTarget} · ${lockBadge}`,
        detail: isActive ? 'Currently active profile' : 'Click to switch profile',
        action: { kind: 'switch', profileId: p.id },
      };
    });

  if (activeProfile) {
    items.push({
      label: `$(edit) Update Credentials / URI for "${activeProfile.name}"`,
      description: activeProfile.displayTarget,
      action: { kind: 'edit-active' },
    });
  }

  items.push(
    {
      label: '$(add) Add New Database Profile (PG / MySQL / SQLite)...',
      description: 'Guided setup, URI, or local SQLite file (stored in SecretStorage)',
      action: { kind: 'add' },
    },
    {
      label: '$(search) Auto-detect from .env / docker-compose / .sqlite...',
      description: 'Scan workspace files for local PostgreSQL, MySQL, or SQLite DBs',
      action: { kind: 'discover' },
    },
  );

  if (activeProfile) {
    items.push({
      label: activeProfile.readOnlyLocked
        ? `$(unlock) Unlock "${activeProfile.name}" (allow Dev writes/indexes)`
        : `$(lock) Lock "${activeProfile.name}" as Read-Only`,
      description: activeProfile.readOnlyLocked
        ? 'Currently blocks write ANALYZE & Create Index QuickFix'
        : 'Recommended for staging & production databases',
      action: { kind: 'toggle-lock' },
    });
  }

  items.push({
    label: '$(trash) Delete a Profile...',
    description: 'Remove a stored connection from SecretStorage',
    action: { kind: 'delete' },
  });

  const selection = await vscode.window.showQuickPick(items, {
    title: 'QueryAutopsy: Database Connection Profiles',
    ignoreFocusOut: true,
  });

  if (!selection) {
    return false;
  }

  switch (selection.action.kind) {
    case 'switch': {
      await connectionConfig.setActiveProfile(selection.action.profileId);
      const switched = await connectionConfig.getActiveProfile();
      logger.info('Switched active database profile', {
        profileId: selection.action.profileId,
      });
      void vscode.window.showInformationMessage(
        `QueryAutopsy: Active profile set to "${switched?.name ?? selection.action.profileId}"`,
      );
      return true;
    }
    case 'edit-active': {
      if (!activeProfile) {
        return false;
      }
      const activeEngine = resolveProfileEngine(activeProfile);
      const nextUri = await promptConnectionUriForEngine(
        activeEngine,
        `QueryAutopsy: Update Credentials for "${activeProfile.name}"`,
      );
      if (!nextUri) {
        return false;
      }
      return verifyAndSaveProfile(
        connectionConfig,
        queryExecutor,
        logger,
        activeProfile.id,
        activeProfile.name,
        activeEngine,
        activeProfile.environment,
        activeProfile.readOnlyLocked,
        nextUri,
      );
    }
    case 'add':
      return runAddManualProfileFlow(connectionConfig, queryExecutor, logger);
    case 'discover':
      return runAutoDetectConnectionCommand(
        connectionConfig,
        queryExecutor,
        discoverConnections,
        logger,
      );
    case 'toggle-lock': {
      if (!activeProfile) {
        return false;
      }
      const nextLocked = !activeProfile.readOnlyLocked;
      await connectionConfig.setProfileReadOnlyLock(
        activeProfile.id,
        nextLocked,
      );
      void vscode.window.showInformationMessage(
        `QueryAutopsy: "${activeProfile.name}" is now ${nextLocked ? 'Read-Only Locked' : 'Unlocked'}.`,
      );
      return true;
    }
    case 'delete': {
      const target = await vscode.window.showQuickPick(
        profiles.map((p) => ({
          label: p.name,
          description: `${formatEngineLabel(resolveProfileEngine(p))} · ${p.displayTarget}`,
          profileId: p.id,
        })),
        { title: 'Select profile to delete', ignoreFocusOut: true },
      );
      if (!target) {
        return false;
      }
      await connectionConfig.deleteProfile(target.profileId);
      void vscode.window.showInformationMessage(
        `QueryAutopsy: Deleted profile "${target.label}".`,
      );
      return false;
    }
  }
}

export async function runClearConnectionCommand(
  connectionConfig: ConnectionConfigPort,
  logger: LoggerPort,
): Promise<void> {
  await connectionConfig.clearConnectionString();
  logger.info('Cleared all stored database connections from SecretStorage');
  void vscode.window.showInformationMessage(
    'QueryAutopsy: Cleared all stored database connections.',
  );
}
