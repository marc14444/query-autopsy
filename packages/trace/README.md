# `@query-autopsy/trace`

Lightweight `--dev` / non-production query trace bridge for **Prisma**, **Drizzle**, **TypeORM**, and Node.js apps — emits sanitized entries to `.query-autopsy/traces.jsonl` for **QueryAutopsy VS Code Trace Explorer**, **`@query-autopsy/cli`**, and **`@query-autopsy/mcp`**.

## Security Defaults
- **Zero production overhead**: Automatically disabled when `NODE_ENV=production` or `APP_ENV=production` (`allowProduction: false`).
- **PII literal & binding redaction by default**: Uses `redactSqlLiterals()` from `@query-autopsy/core` and strips bound parameter values (`bindings: []`) before writing to disk (`QUERY_AUTOPSY_REDACT_BINDINGS=true`).
- **Safe disk hygiene**: Creates `.query-autopsy/.gitignore`, blocks symlink writes, and rotates beyond `5 MiB`.

## Quick Usage

### Prisma
```ts
import { PrismaClient } from '@prisma/client';
import { JsonlTraceRecorder, attachPrismaTracing } from '@query-autopsy/trace';

const prisma = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
const recorder = new JsonlTraceRecorder({ defaultEngine: 'postgresql' });
attachPrismaTracing(prisma, recorder);
```

### Drizzle
```ts
import { drizzle } from 'drizzle-orm/node-postgres';
import { JsonlTraceRecorder, createDrizzleLogger } from '@query-autopsy/trace';

const recorder = new JsonlTraceRecorder({ defaultEngine: 'postgresql' });
export const db = drizzle(pool, { logger: createDrizzleLogger(recorder) });
```

### TypeORM
```ts
import { DataSource } from 'typeorm';
import { JsonlTraceRecorder, createTypeOrmLogger } from '@query-autopsy/trace';

const recorder = new JsonlTraceRecorder({ defaultEngine: 'postgresql' });
export const AppDataSource = new DataSource({
  type: 'postgres',
  logger: createTypeOrmLogger(recorder),
});
```

### Express Request Isolation (`N_PLUS_ONE_BURST` per request)
```ts
import { createExpressTraceMiddleware } from '@query-autopsy/trace';
app.use(createExpressTraceMiddleware(recorder));
```
