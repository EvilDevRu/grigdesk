import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  seedPipelineStand, setStandCli, STAND_PROFILE, writableStandRoots,
} from './helpers/pipelineStandSeed.mjs';
import { isolatedEnv } from './helpers/pluginBootFixture.js';
import { discoverExternalCli } from '../../server/src/lib/providerInstall/inventory.ts';
import { resolveUserCliEnvironment } from '../../server/src/lib/providerInstall/userCliEnvironment.ts';

const run = promisify(execFile);

test('посев повторяем, CLI реально теряет npm identity и восстанавливается без личного HOME', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pipeline-stand-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFile(path.join(root, '.env'), 'FIXTURE_SENTINEL=keep\n');

  const options = {
    root,
    fePort: 5280,
    apiPort: 8150,
    systemdRuntimeDir: '/run/user/1234',
  };
  const first = await seedPipelineStand(options);
  const second = await seedPipelineStand(options);

  assert.deepEqual(second, first);
  assert.equal(first.profile, STAND_PROFILE);
  assert.deepEqual(await writableStandRoots(root), [
    path.join(root, 'home/fixture-npm/bin'),
    path.join(root, 'pipeline-fixture'),
  ]);
  assert.equal(await readFile(path.join(root, '.env'), 'utf8'),
    'FIXTURE_SENTINEL=keep\n\nXDG_RUNTIME_DIR=/run/user/1234\n');

  const env = isolatedEnv(root, 8150);
  const shell = await resolveUserCliEnvironment({
    env,
    cliName: 'kimi',
    scratch: path.join(root, 'scratch'),
  });
  const input = {
    providerId: 'kimi',
    definition: { binName: 'kimi', packageId: '@moonshot-ai/kimi-code' },
    configuredBin: 'kimi',
    env: shell.env,
    home: env.HOME,
  };
  const before = await discoverExternalCli(input);
  const selected = before.installations.find((item) => item.installationId === before.selectedId);

  assert.equal(selected.source, 'npm');
  assert.equal(selected.state, 'ready');

  const version = await run(selected.realpath, ['--version']);

  assert.match(version.stdout, /2\.4\.1/u);
  await assert.rejects(run(selected.realpath, ['-p', 'Не запускать модель']), { code: 91 });
  await setStandCli(root, 'broken');

  const broken = await discoverExternalCli(input);
  const detached = broken.installations.find((item) => item.installationId === broken.selectedId);

  assert.equal(detached.path, selected.path);
  assert.equal(detached.state, 'unverified');
  assert.equal(detached.source, 'unknown');
  await setStandCli(root, 'ready');

  const repaired = await discoverExternalCli(input);
  const ready = repaired.installations.find((item) => item.installationId === repaired.selectedId);

  assert.equal(ready.state, 'ready');
  assert.equal(ready.realpath, selected.realpath);

  const binDirectory = path.join(root, 'home/fixture-npm/bin');

  await rename(binDirectory, `${binDirectory}.saved`);
  await symlink(`${binDirectory}.saved`, binDirectory);
  await assert.rejects(writableStandRoots(root), /symlink/u);
});

test('посев не перезаписывает чужой профиль и другую настройку systemd', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pipeline-stand-owner-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  const profile = path.join(root, 'profiles', STAND_PROFILE);

  await mkdir(profile, { recursive: true });
  await writeFile(path.join(profile, 'sentinel'), 'keep');
  await assert.rejects(seedPipelineStand({
    root,
    fePort: 5280,
    apiPort: 8150,
  }), { code: 'EEXIST' });
  assert.equal(await readFile(path.join(profile, 'sentinel'), 'utf8'), 'keep');

  const other = await mkdtemp(path.join(os.tmpdir(), 'pipeline-stand-runtime-'));

  t.after(() => rm(other, { recursive: true, force: true }));
  await writeFile(path.join(other, '.env'), 'XDG_RUNTIME_DIR=/run/user/9999\n');
  await assert.rejects(seedPipelineStand({
    root: other,
    fePort: 5280,
    apiPort: 8150,
    systemdRuntimeDir: '/run/user/1234',
  }), /уже настроен/u);
  assert.equal(await readFile(path.join(other, '.env'), 'utf8'), 'XDG_RUNTIME_DIR=/run/user/9999\n');
});
