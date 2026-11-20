import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const fromRoot = (relPath: string) =>
  fileURLToPath(new URL(relPath, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@query-autopsy/core': fromRoot('./packages/core/src/index.ts'),
      '@query-autopsy/executors': fromRoot('./packages/executors/src/index.ts'),
      '@query-autopsy/cli': fromRoot('./packages/cli/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/e2e/**/*.e2e.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
