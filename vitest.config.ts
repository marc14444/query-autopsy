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
      '@query-autopsy/mcp': fromRoot('./packages/mcp/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,mts}'],
    exclude: ['tests/e2e/**'],
    coverage: {
      provider: 'v8',
      include: [
        'packages/core/src/**/*.ts',
        'packages/executors/src/**/*.ts',
        'packages/cli/src/**/*.ts',
        'packages/mcp/src/**/*.ts',
      ],
    },
  },
});
