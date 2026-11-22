import type { DatabaseEngine } from '@query-autopsy/core';
import type { JsonlTraceRecorder } from './recorder.js';

export interface PrismaQueryEventLike {
  readonly query: string;
  readonly params?: string | undefined;
  readonly duration?: number | undefined;
}

export interface PrismaClientLike {
  $on(event: 'query', callback: (event: PrismaQueryEventLike) => void): void;
}

export interface DrizzleLoggerLike {
  logQuery(query: string, params: unknown[]): void;
}

export interface TypeOrmLoggerLike {
  logQuery(query: string, parameters?: unknown[]): void;
  logQueryError(
    error: string | Error,
    query: string,
    parameters?: unknown[],
  ): void;
  logQuerySlow(time: number, query: string, parameters?: unknown[]): void;
  logSchemaBuild(message: string): void;
  logMigration(message: string): void;
  log(level: 'log' | 'info' | 'warn', message: unknown): void;
}

function parsePrismaParams(raw?: string): readonly unknown[] | undefined {
  if (!raw || !raw.trim()) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Hooks a Prisma client configured with `{ log: [{ emit: 'event', level: 'query' }] }`.
 * No-ops cleanly if tracing is disabled (e.g. `NODE_ENV === 'production'`).
 */
export function attachPrismaTracing(
  prisma: PrismaClientLike,
  recorder: JsonlTraceRecorder,
  options?: { readonly engine?: DatabaseEngine | undefined },
): void {
  if (!recorder.isEnabled()) {
    return;
  }

  prisma.$on('query', (event) => {
    recorder.record({
      sql: event.query,
      bindings: parsePrismaParams(event.params),
      durationMs: event.duration,
      engine: options?.engine,
    });
  });
}

/**
 * Returns a Drizzle-compatible `Logger` (`drizzle(pool, { logger: createDrizzleLogger(recorder) })`).
 */
export function createDrizzleLogger(
  recorder: JsonlTraceRecorder,
  options?: { readonly engine?: DatabaseEngine | undefined },
): DrizzleLoggerLike {
  return {
    logQuery: (query, params) => {
      recorder.record({
        sql: query,
        bindings: params,
        engine: options?.engine,
      });
    },
  };
}

/**
 * Returns a TypeORM-compatible `Logger` capturing executed and slow queries while ignoring DDL/migrations.
 */
export function createTypeOrmLogger(
  recorder: JsonlTraceRecorder,
  options?: { readonly engine?: DatabaseEngine | undefined },
): TypeOrmLoggerLike {
  return {
    logQuery: (query, parameters) => {
      recorder.record({
        sql: query,
        bindings: parameters,
        engine: options?.engine,
      });
    },
    logQueryError: (_error, query, parameters) => {
      recorder.record({
        sql: query,
        bindings: parameters,
        engine: options?.engine,
      });
    },
    logQuerySlow: (time, query, parameters) => {
      recorder.record({
        sql: query,
        bindings: parameters,
        durationMs: time,
        engine: options?.engine,
      });
    },
    logSchemaBuild: () => undefined,
    logMigration: () => undefined,
    log: () => undefined,
  };
}

export interface HttpRequestLike {
  readonly headers?: Record<string, string | string[] | undefined> | undefined;
}

export interface HttpResponseLike {
  on?(event: 'finish' | 'close', listener: () => void): void;
}

/**
 * Express / Connect / Fastify-compatible middleware isolating each HTTP request into its
 * own `requestId` window via AsyncLocalStorage and flushing buffered traces on response finish.
 */
export function createExpressTraceMiddleware(
  recorder: JsonlTraceRecorder,
): (req: HttpRequestLike, res: HttpResponseLike, next: () => void) => void {
  return (req, res, next) => {
    if (!recorder.isEnabled()) {
      next();
      return;
    }

    const rawHeader = req.headers?.['x-request-id'];
    const reqId = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

    let flushed = false;
    const flushOnce = (): void => {
      if (flushed) {
        return;
      }
      flushed = true;
      void recorder.flush().catch(() => undefined);
    };

    res.on?.('finish', flushOnce);
    res.on?.('close', flushOnce);

    recorder.runWithRequest(reqId, () => {
      next();
    });
  };
}
