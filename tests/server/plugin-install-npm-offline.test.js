import assert from 'node:assert/strict';
import { lstat, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { createNpmRunner } from '../../server/src/lib/pluginInstall/npm.ts';
import { validatePluginPackage } from '../../server/src/lib/pluginInstall/validatePackage.ts';
import { runCommand } from '../../server/src/lib/pluginInstall/runCommand.ts';
import { createOfflineNpmFixture } from './helpers/pluginNpmFixture.js';

const expected = {
  version: '1.0.0',
  expectedId: null,
  reservedIds: new Set(['code']),
  cockpitVersion: '1.0.0',
};

test('N4: offline npm устанавливает production graph, omit dev и не исполняет lifecycle', async (t) => {
  const fixture = await createOfflineNpmFixture(t);
  const validated = await validatePluginPackage(fixture.cwd, expected);
  const runner = createNpmRunner(runCommand, { cacheRoot: fixture.cache, offline: true });
  const result = await runner(fixture.cwd);

  assert.equal(result.code, 0, 'настоящий npm ci успешно прочёл одноразовый cache');
  assert.deepEqual(await readdir(fixture.markers), [], 'root и transitive lifecycle не исполнены');
  assert.equal((await lstat(path.join(fixture.cwd, 'node_modules/fixture-prod'))).isDirectory(), true);
  assert.equal((await lstat(path.join(fixture.cwd, 'node_modules/fixture-transitive'))).isDirectory(), true);
  assert.equal(await lstat(path.join(fixture.cwd, 'node_modules/fixture-dev')).catch(() => null), null);
  assert.deepEqual(validated.npmDirs, ['.']);
});

test('N6: настоящий npm в подпапке игнорирует вредный parent config и project', async (t) => {
  const fixture = await createOfflineNpmFixture(t);

  await writeFile(path.join(fixture.root, '.npmrc'),
    'ignore-scripts=false\nomit=\nregistry=https://evil.example\n');
  await writeFile(path.join(fixture.root, 'package.json'), JSON.stringify({
    name: 'poison-parent',
    dependencies: { 'wrong-parent-dependency': 'git+ssh://fixture.example/repo' },
    scripts: { install: 'touch parent-marker' },
  }));

  const runner = createNpmRunner(runCommand, { cacheRoot: fixture.cache, offline: true });
  const result = await runner(fixture.cwd);

  assert.equal(result.code, 0);
  assert.deepEqual(await readdir(fixture.markers), []);
  assert.equal(await lstat(path.join(fixture.root, 'parent-marker')).catch(() => null), null);
  assert.equal(await lstat(path.join(fixture.root, 'node_modules')).catch(() => null), null);
  assert.equal(await lstat(path.join(fixture.cwd, 'node_modules/fixture-dev')).catch(() => null), null);
  assert.equal((await lstat(path.join(fixture.cwd, 'node_modules/fixture-prod'))).isDirectory(), true);
});

test('N8: версии Node/npm и cache isolation подтверждены настоящим offline процессом', async (t) => {
  const fixture = await createOfflineNpmFixture(t);
  const emptyRunner = createNpmRunner(runCommand, {
    cacheRoot: path.join(fixture.root, 'empty-cache'),
    offline: true,
  });
  const missing = await emptyRunner(fixture.cwd);

  assert.notEqual(missing.code, 0, 'без fixture cache offline установка не может получить dependency');
  assert.match(missing.stderr, /ENOTCACHED/u);

  let execution;
  const runner = createNpmRunner(async (file, args, options) => {
    execution = {
      file,
      args,
      options,
    };

    return runCommand(file, args, options);
  }, { cacheRoot: fixture.cache, offline: true });
  const installed = await runner(fixture.cwd);

  assert.equal(installed.code, 0, 'production runner использует переданный одноразовый cache');
  assert.ok(execution.args.includes('--offline'));
  assert.ok(execution.args.includes(`--cache=${fixture.cache}`));

  const version = await runCommand(execution.file, [
    '--version',
    ...execution.args.filter((arg) => /^--(?:userconfig|globalconfig|cache|prefix|registry)=/u.test(arg)),
  ], execution.options);

  assert.equal(version.code, 0, 'npm обязателен; отсутствие prerequisite является падением');
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/u);
  t.diagnostic(`Node ${process.version}; npm ${version.stdout.trim()}; offline fixture cache подтверждён`);
});
