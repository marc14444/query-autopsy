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
  try {
    const parsed = new URL(trimmed);
    if (!parsed.hostname) {
      return 'URI must include a hostname (e.g. localhost).';
    }
  } catch {
    return 'Invalid URL format.';
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

async function verifyAndSaveProfile(
  connectionConfig: ConnectionConfigPort,
  queryExecutor: QueryExecutorPort,
  logger: LoggerPort,
  name: string,
  environment: ProfileEnvironment,
  readOnlyLocked: boolean,
  uri: string,
): Promise<boolean> {
  const trimmedUri = uri.trim();
  const id = toProfileId(name);

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
      'Save Anyway',
      'Cancel',
    );
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
  const uriInput = await vscode.window.showInputBox({
    title: 'QueryAutopsy: PostgreSQL Connection URI',
    prompt:
      'Enter your PostgreSQL connection URI (stored encrypted in VS Code SecretStorage)',
    placeHolder:
      'postgresql://postgres:queryautopsy@localhost:5432/query_autopsy_dev',
    password: true,
    ignoreFocusOut: true,
    validateInput: validatePostgresUri,
  });

  if (!uriInput) {
    return false;
  }

  const trimmedUri = uriInput.trim();
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
      'QueryAutopsy: No PostgreSQL URIs found in .env or docker-compose files. Entering manual setup.',
    );
    return runAddManualProfileFlow(connectionConfig, queryExecutor, logger);
  }

  const picked = await vscode.window.showQuickPick(
    candidates.map((c) => ({
      label: `$(database) ${c.label}`,
      description: `from ${c.sourceFile}`,
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

  const envChoice = await promptEnvironmentChoice('local');
  if (!envChoice) {
    return false;
  }

  return verifyAndSaveProfile(
    connectionConfig,
    queryExecutor,
    logger,
    picked.candidate.displayTarget,
    envChoice.environment,
    envChoice.readOnlyLocked,
    picked.candidate.uri,
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
            label: '$(add) Enter PostgreSQL URI manually...',
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

  items.push(
    {
      label: '$(add) Add New PostgreSQL Profile...',
      description: 'Store a new connection in VS Code SecretStorage',
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
