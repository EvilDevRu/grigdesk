import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { build } from '../../voice/node_modules/esbuild/lib/main.js';
import { parseBuildArgs } from '../../voice/scripts/buildSteps.mts';

const packageDir = fileURLToPath(new URL('../../voice/', import.meta.url));
const root = path.resolve(packageDir, '..');

test('voice-build-аргументы-до-эффектов', () => {
  assert.deepEqual(parseBuildArgs([], '/work/voice', packageDir), {
    outDir: path.join(root, 'bin'),
    cacheDir: path.join(packageDir, '.cache'),
  });

  for (const args of [['--unknown'], ['--out-dir', '/a', '--out-dir', '/b']]) {
    const parsed = parseBuildArgs(args, '/work/voice', packageDir);

    assert.ok('error' in parsed);
    assert.match(parsed.error, /npm --prefix voice run build/u);
  }
});

test('voice-build-runtime-собирается-в-CJS-без-предупреждений', async () => {
  const result = await build({
    entryPoints: [path.join(packageDir, 'src/main.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    logLevel: 'silent',
    write: false,
  });

  assert.deepEqual(result.warnings, []);
  assert.ok(result.outputFiles[0]!.contents.length > 0);
});
