const DEFAULT_ALLOWED_ENVIRONMENTS = new Set([
  'local',
  'development',
  'dev',
  'test',
  'testing',
]);

export interface TraceGuardOptions {
  readonly enabled?: boolean | undefined;
  readonly allowProduction?: boolean | undefined;
  readonly currentEnvironment?: string | undefined;
  readonly allowedEnvironments?: readonly string[] | undefined;
}

/**
 * Evaluates whether runtime ORM query tracing should attach.
 * Hard-blocks production by default so live apps pay zero tracing overhead and zero risk of PII capture.
 */
export function shouldEnableTraceRecording(
  options?: TraceGuardOptions,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const currentEnv = (
    options?.currentEnvironment ??
    env['APP_ENV'] ??
    env['NODE_ENV'] ??
    'development'
  )
    .trim()
    .toLowerCase();

  if (options?.enabled === false) {
    return false;
  }

  const rawEnvToggle = env['QUERY_AUTOPSY_ENABLED']?.trim().toLowerCase();
  if (rawEnvToggle === 'false' || rawEnvToggle === '0') {
    return false;
  }

  const allowProduction = options?.allowProduction === true;
  if (currentEnv === 'production' || currentEnv === 'prod') {
    return allowProduction;
  }

  if (options?.enabled === true || rawEnvToggle === 'true' || rawEnvToggle === '1') {
    return true;
  }

  const allowed = options?.allowedEnvironments
    ? new Set(options.allowedEnvironments.map((e) => e.trim().toLowerCase()))
    : DEFAULT_ALLOWED_ENVIRONMENTS;

  return allowed.has(currentEnv);
}
