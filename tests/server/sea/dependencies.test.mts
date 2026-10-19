import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  collectLicenses,
  cleanNativeBuilds,
  extractRuntime,
  installDependencies,
  probeDependencies,
} from '../../../server/scripts/sea/dependencies.mts';
import { auditStage, normalizeStageModes } from '../../../server/scripts/sea/stage.mts';
import { readNodeRuntime } from '../../../shared/node/nodeRuntime.ts';
import { nodeArchive } from '../../../shared/node/seaBuild.ts';
import { SOURCE_ROOT } from './helperFixture.mts';

test('SEA-DEPS-01: реальный production npm ci и native ABI на Node 24 из проверенного архива', {
  timeout: 240000,
}, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-sea-deps-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  const runtime = readNodeRuntime(JSON.parse(await readFile(
    path.join(SOURCE_ROOT, 'server/build/node-runtime.json'), 'utf8',
  )), 'server runtime');

  await extractRuntime({
    archive: path.join(SOURCE_ROOT, 'b24/.cache', nodeArchive(runtime).name),
    runtime,
    target: path.join(root, 'runtime/node'),
  });
  await installDependencies({
    sourceRoot: SOURCE_ROOT,
    stageRoot: root,
    cacheDir: process.env.npm_config_cache || path.join(root, 'npm-cache'),
  });
  await cleanNativeBuilds(root);

  const report = await probeDependencies(root);
  const licenses = await collectLicenses(root);

  await normalizeStageModes(root);

  const files = await auditStage(root, {
    required: ['runtime/node/bin/node', 'runtime/node/bin/npm',
      'server/node_modules/playwright-core/package.json', 'licenses/THIRD-PARTY.json'],
    executables: ['runtime/node/bin/node', 'runtime/node/bin/npm'],
    sourceRoot: SOURCE_ROOT,
  });

  assert.equal(report.node, '24.21.0');
  assert.equal(report.abi, '137');
  assert.equal(report.native.length, 2);
  assert.equal(files.some((file) => /\/build\/(?:Makefile|config\.gypi)|\.o(?:\.d)?$/.test(file.path)),
    false);
  assert.equal(report.packages['playwright-core']!.length > 0, true);
  assert.equal(report.packages.ws!.length > 0, true);
  assert.equal(licenses.packages.length > 20, true);
  assert.equal(files.some((file) => file.path === 'runtime/node/bin/npm' && file.type === 'symlink'), true);
  console.log(JSON.stringify({
    native: report.native,
    node: report.node,
    abi: report.abi,
  }));
});
