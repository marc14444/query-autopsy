import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const tscBin = require.resolve('typescript/bin/tsc');

function runTsc(tsconfigPath) {
  execFileSync(process.execPath, [tscBin, '-p', tsconfigPath], {
    stdio: 'inherit',
  });
}

function writeFormatMarker(dirPath, moduleType) {
  mkdirSync(dirPath, { recursive: true });
  writeFileSync(
    join(dirPath, 'package.json'),
    `${JSON.stringify({ type: moduleType }, null, 2)}\n`,
    'utf-8',
  );
}

// 1. @query-autopsy/core (dual CJS + ESM)
runTsc('packages/core/tsconfig.json');
writeFormatMarker('packages/core/dist/cjs', 'commonjs');
runTsc('packages/core/tsconfig.esm.json');
writeFormatMarker('packages/core/dist/esm', 'module');

// 2. @query-autopsy/executors (dual CJS + ESM)
runTsc('packages/executors/tsconfig.json');
writeFormatMarker('packages/executors/dist/cjs', 'commonjs');
runTsc('packages/executors/tsconfig.esm.json');
writeFormatMarker('packages/executors/dist/esm', 'module');

// 3. @query-autopsy/cli (ESM binary + library)
mkdirSync(dirname('packages/cli/dist/index.js'), { recursive: true });
runTsc('packages/cli/tsconfig.json');
