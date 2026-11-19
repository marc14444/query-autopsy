import * as vscode from 'vscode';
import {
  type ProfileEnvironment,
  sanitizePostgresDisplayTarget,
} from '../../../domain/models/connectionProfile.js';
import type { ConnectionConfigPort } from '../../../domain/ports/outbound/connectionConfigPort.js';
import type { LoggerPort } from '../../../domain/ports/outbound/loggerPort.js';
import type { QueryExecutorPort } from '../../../domain/ports/outbound/queryExecutorPort.js';
import type { DiscoveredConnectionCandidate } from '../../../domain/services/envDiscovery.js';

export type DiscoverConnectionsFn = () => Promise<
  readonly DiscoveredConnectionCandidate[]
>;

export function validatePostgresUri(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return 'PostgreSQL connection URI cannot be empty.';
  }
  if (
    !trimmed.startsWith('postgres://') &&
    !trimmed.startsWith('postgresql://')
  ) {
    return 'URI must start with "postgres://" or "postgresql://".';
  }
  const atCount = (trimmed.match(/@/g) ?? []).length;
  if (atCount > 1) {
    return 'Password contains an unencoded "@". Replace "@" in password with "%40" or use Guided Setup.';
  }
  try {
    const parsed = new URL(trimmed);
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

function toProfileId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || `profile-${Date.now()}`;
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

async function promptGuidedPostgresUri(
  initialHost = '127.0.0.1',
): Promise<string | undefined> {
  const host = await vscode.window.showInputBox({
    title: 'QueryAutopsy (1/6): PostgreSQL Host',
    prompt: 'Use 127.0.0.1 for local Docker containers (avoids IPv6 localhost conflicts with local Homebrew Postgres)',
    value: initialHost,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : 'Host is required.'),
  });
  if (!host) {
    return undefined;
  }

  const port = await vscode.window.showInputBox({
    title: 'QueryAutopsy (2/6): PostgreSQL Port',
    prompt: 'Host port mapped to PostgreSQL (e.g. 5432, 5433)',
    value: '5432',
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
    title: 'QueryAutopsy (3/6): Database Name',
    value: 'postgres',
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : 'Database name is required.'),
  });
  if (!database) {
    return undefined;
  }

  const user = await vscode.window.showInputBox({
    title: 'QueryAutopsy (4/6): PostgreSQL Username',
    value: 'postgres',
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : 'Username is required.'),
  });
  if (!user) {
    return undefined;
  }

  const password = await vscode.window.showInputBox({
    title: 'QueryAutopsy (5/6): PostgreSQL Password',
    prompt: 'Special characters (@, #, /) are automatically encoded safely (leave empty for trust auth)',
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
      title: 'QueryAutopsy (6/6): SSL Mode',
      ignoreFocusOut: true,
    },
  );
  if (!sslChoice) {
    return undefined;
  }

  const auth = password
    ? `${encodeURIComponent(user.trim())}:${encodeURIComponent(password)}@`
    : `${encodeURIComponent(user.trim())}@`;

  return `postgresql://${auth}${host.trim()}:${port.trim()}/${encodeURIComponent(database.trim())}${sslChoice.queryParam}`;
}

async function promptUriMethod(
  title: string,
): Promise<string | undefined> {
  const modePick = await vscode.window.showQuickPick(
    [
      {
        label: '$(key) Guided Setup (Host, Port, DB, User, Password)',
        description:
          'Recommended for Docker or passwords containing special characters (@, #, /)',
        mode: 'guided' as const,
      },
      {
        label: '$(link) Paste PostgreSQL Connection URI',
        description: 'postgresql://user:pass@host:5432/dbname',
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
    return promptGuidedPostgresUri();
  }

  const uriInput = await vscode.window.showInputBox({
    title: 'QueryAutopsy: PostgreSQL Connection URI',
    prompt:
      'Enter your PostgreSQL connection URI (stored encrypted in VS Code SecretStorage)',
    placeHolder:
      'postgresql://postgres:password@127.0.0.1:5432/mydb',
    password: true,
    ignoreFocusOut: true,
    validateInput: validatePostgresUri,
  });

  return uriInput?.trim();
}

async function verifyAndSaveProfile(
  connectionConfig: ConnectionConfigPort,
  queryExecutor: QueryExecutorPort,
  logger: LoggerPort,
  id: string,
  name: string,
  environment: ProfileEnvironment,
  readOnlyLocked: boolean,
  uri: string,
): Promise<boolean> {
  const trimmedUri = uri.trim();

  try {
    const versionInfo = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `QueryAutopsy: Testing connection "${name}"...`,
        cancellable: false,
      },
      async () => queryExecutor.testConnection(trimmedUri),
    );

    await connectionConfig.saveProfile(
      { id, name, environment, readOnlyLocked },
      trimmedUri,
    );
    logger.info('PostgreSQL profile verified and saved', {
      profileId: id,
      environment,
      readOnlyLocked,
    });
    void vscode.window.showInformationMessage(
      `QueryAutopsy [${name}]: Connected (${versionInfo.serverVersion.split(',')[0]})`,
    );
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('PostgreSQL connection test failed', {
      profileId: id,
      message,
    });

    const choice = await vscode.window.showErrorMessage(
      `Connection failed for "${name}": ${message}`,
      'Retry',
      'Save Anyway',
      'Cancel',
    );
    if (choice === 'Retry') {
      const retryUri = await promptUriMethod(
        `QueryAutopsy: Update URI for "${name}"`,
      );
      if (retryUri) {
        return verifyAndSaveProfile(
          connectionConfig,
          queryExecutor,
          logger,
          id,
          name,
          environment,
          readOnlyLocked,
          retryUri,
        );
      }
      return false;
    }
    if (choice === 'Save Anyway') {
      await connectionConfig.saveProfile(
        { id, name, environment, readOnlyLocked },
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
  const trimmedUri = await promptUriMethod(
    'QueryAutopsy: Choose Connection Input Method',
  );
  if (!trimmedUri) {
    return false;
  }

  const suggestedName = sanitizePostgresDisplayTarget(trimmedUri);
  const nameInput = await vscode.window.showInputBox({
    title: 'QueryAutopsy: Profile Name',
    prompt: 'Give this connection profile a recognizable name',
    value: suggestedName,
    placeHolder: 'local-dev, staging-ro, prod-replica',
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
  const candidates = await discoverConnections();
  if (candidates.length === 0) {
    void vscode.window.showInformationMessage(
      'QueryAutopsy: No PostgreSQL URIs found in .env or docker-compose files. Launching manual setup.',
    );
    return runAddManualProfileFlow(connectionConfig, queryExecutor, logger);
  }

  const picked = await vscode.window.showQuickPick(
    candidates.map((c) => ({
      label: `$(database) ${c.label}`,
      description: `from ${c.sourceFile}${c.needsPasswordPrompt ? ' · password required' : ''}`,
      candidate: c,
    })),
    {
      title: 'QueryAutopsy: Select Detected PostgreSQL Connection',
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

  const envChoice = await promptEnvironmentChoice('local');
  if (!envChoice) {
    return false;
  }

  return verifyAndSaveProfile(
    connectionConfig,
    queryExecutor,
    logger,
    toProfileId(picked.candidate.displayTarget),
    picked.candidate.displayTarget,
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
            label: '$(key) Add PostgreSQL Profile (Guided or URI)...',
            description: 'Stored encrypted in VS Code SecretStorage',
            action: 'manual' as const,
          },
        ],
        {
          title: 'QueryAutopsy: Connect to PostgreSQL',
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
      const lockBadge = p.readOnlyLocked ? '$(lock) Read-Only' : '$(unlock) Dev';
      return {
        label: `${isActive ? '$(check) ' : ''}${p.name}`,
        description: `${p.displayTarget} · ${lockBadge}`,
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
      label: '$(add) Add New PostgreSQL Profile...',
      description: 'Guided setup or URI (stored in SecretStorage)',
      action: { kind: 'add' },
    },
    {
      label: '$(search) Auto-detect from .env / docker-compose.yml...',
      description: 'Scan workspace files for local PostgreSQL URIs',
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
    title: 'QueryAutopsy: PostgreSQL Connection Profiles',
    ignoreFocusOut: true,
  });

  if (!selection) {
    return false;
  }

  switch (selection.action.kind) {
    case 'switch': {
      await connectionConfig.setActiveProfile(selection.action.profileId);
      const switched = await connectionConfig.getActiveProfile();
      logger.info('Switched active PostgreSQL profile', {
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
      const nextUri = await promptUriMethod(
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
          description: p.displayTarget,
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
  logger.info('Cleared all stored PostgreSQL connections from SecretStorage');
  void vscode.window.showInformationMessage(
    'QueryAutopsy: Cleared all stored PostgreSQL connections.',
  );
}
