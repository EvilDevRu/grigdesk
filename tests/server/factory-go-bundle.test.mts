import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { readFactoryGoDescriptor } from '../../server/src/lib/factoryGoDescriptor.ts';

const source = fileURLToPath(new URL('../..', import.meta.url));

test('build factory компилирует только движок и публикует bin/factory', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-factory-bundle-'));

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const ctl = path.join(root, 'grigdesk-ctl');
  const compiled = spawnSync('go', ['build', '-trimpath', '-o', ctl, './utilities/ctl/cmd/ctl'], {
    cwd: source,
    encoding: 'utf8',
    timeout: 60_000,
  });

  assert.equal(compiled.status, 0, compiled.stderr || compiled.error?.message);

  const checkout = path.join(root, 'checkout');

  for (const marker of ['VERSION', 'server/src/app.ts', 'web/package.json', 'desktop/package.json']) {
    const file = path.join(checkout, marker);

    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, marker === 'VERSION' ? '0.1.0\n' : '');
  }

  const tools = path.join(checkout, 'tools');
  const bootstrap = path.join(source, 'tools/build-factory.sh');

  await fs.mkdir(tools);
  await fs.copyFile(bootstrap, path.join(tools, 'build-factory.sh')).catch((err) => {
    if (err.code !== 'ENOENT') {
      throw err;
    }
  });
  await fs.copyFile(path.join(source, 'go.mod'), path.join(checkout, 'go.mod'));
  await fs.copyFile(path.join(source, 'go.sum'), path.join(checkout, 'go.sum'));
  await fs.mkdir(path.join(checkout, 'utilities'));
  await fs.symlink(path.join(source, 'utilities/factory'), path.join(checkout, 'utilities/factory'));

  const detachedHome = path.join(root, 'home');
  const data = path.join(root, 'data');

  await fs.mkdir(detachedHome);
  await fs.mkdir(data);
  await fs.writeFile(path.join(data, '.env'), '');

  const env = {
    PATH: process.env.PATH,
    HOME: detachedHome,
    GRIGDESK_HOME: data,
    GRIGDESK_CTL_CHECKOUT_ROOT: checkout,
    GOCACHE: process.env.GOCACHE,
    GOMODCACHE: process.env.GOMODCACHE,
    GOPROXY: process.env.GOPROXY,
    GOTOOLCHAIN: 'local',
    GOWORK: 'off',
  };
  const built = spawnSync(ctl, ['build', 'factory'], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });

  assert.equal(built.status, 0, built.stderr || built.error?.message);

  const versions = await fs.readdir(path.join(checkout, 'bin'));

  assert.deepEqual(versions, ['factory']);

  const binary = path.join(checkout, 'bin/factory');
  const metadata = spawnSync('go', ['version', '-m', binary], {
    cwd: source,
    encoding: 'utf8',
    timeout: 5000,
  });

  assert.equal(metadata.status, 0, metadata.stderr || metadata.error?.message);
  assert.match(metadata.stdout, /^\tpath\tgrigdesk\.local\/tools\/utilities\/factory\/cmd\/factory$/mu);
  assert.match(metadata.stdout, /^\tmod\tgrigdesk\.local\/tools\t/mu);

  const installed = path.join(root, 'перемещённая поставка');

  await fs.mkdir(installed);
  await fs.rename(binary, path.join(installed, 'factory'));

  const check = spawnSync(path.join(installed, 'factory'), ['capabilities', '--format', 'json'], {
    cwd: installed,
    env: { PATH: '/usr/bin:/bin' },
    encoding: 'utf8',
    timeout: 5000,
  });

  assert.equal(check.status, 0, check.stderr);
  assert.ok(JSON.parse(check.stdout).features.includes('native-subcommands'));
});

test('сборочная проба запечатывает переносимый factory и проверяет архитектуру', async (t) => {
  const { stageFactoryCandidate } = await import('../../server/scripts/binary/factoryCandidate.mts');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-factory-package-'));

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const binary = path.join(root, 'source-factory');
  const built = spawnSync('go', ['build', '-trimpath', '-o', binary, './utilities/factory/cmd/factory'], {
    cwd: source,
    encoding: 'utf8',
    timeout: 30_000,
  });

  assert.equal(built.status, 0, built.stderr);

  const destination = path.join(root, 'кандидат установки');

  await fs.mkdir(destination);

  const input = {
    root: destination,
    binary,
    profileAbi: path.join(source, 'engine/lib/delivery_contract.py'),
    os: process.platform,
    arch: process.arch,
  };
  const rejected = path.join(root, 'wrong-architecture');

  await fs.mkdir(rejected);
  await assert.rejects(() => stageFactoryCandidate({
    ...input,
    root: rejected,
    arch: process.arch === 'arm64' ? 'x64' : 'arm64',
  }), { code: 'factory_runtime_engine_invalid' });
  assert.deepEqual(await fs.readdir(rejected), []);

  const manifest = await stageFactoryCandidate(input);

  assert.ok(manifest && typeof manifest === 'object' && 'sha256' in manifest,
    'в кандидате отсутствует версия, формат и digest собранного движка');
  assert.equal((await fs.readdir(path.join(destination, 'engine/bin'))).join(','), 'factory');
  assert.equal((await fs.readdir(path.join(destination, 'engine/lib'))).join(','), 'delivery_contract.py');
  assert.deepEqual(readFactoryGoDescriptor(destination), manifest);

  const relocated = path.join(root, 'перемещённая фабрика');

  await fs.rename(destination, relocated);
  assert.deepEqual(readFactoryGoDescriptor(relocated), manifest);

  const installed = path.join(relocated, 'engine/bin/factory');
  const probe = spawnSync(installed, ['capabilities', '--format', 'json'], {
    env: { PATH: '/usr/bin:/bin' },
    cwd: relocated,
    encoding: 'utf8',
    timeout: 5000,
  });

  assert.equal(probe.status, 0, probe.stderr);

  const corrupt = path.join(relocated, 'engine/bin/corrupt');

  await fs.writeFile(corrupt, Buffer.concat([await fs.readFile(installed), Buffer.from('corrupt')]), {
    mode: 0o555,
  });
  await fs.rename(corrupt, installed);
  assert.throws(() => readFactoryGoDescriptor(relocated), { code: 'factory_runtime_engine_invalid' });
});
