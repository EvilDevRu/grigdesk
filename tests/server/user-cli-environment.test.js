import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { artifactsPath } from '../../shared/runtime/dataHome.ts';
import test from 'node:test';

import { captureUserCliParent } from '../../shared/node/userCliParentEnvironment.ts';
import {
  resolveUserCliEnvironment, resolveUserCliNpm,
} from '../../server/src/lib/providerInstall/userCliEnvironment.ts';

const artifacts = path.join(artifactsPath({ env: process.env, home: os.homedir() }),
  'external-cli-lifecycle/fixtures');

/**
 * Настоящий Bash читает только собственные rc стенда; runtime заменён короткими командами.
 * HOME владельца и установленные пакеты не участвуют в проверке окружения.
 */
async function fixture(t) {
  await fs.mkdir(artifacts, { recursive: true });

  const home = await fs.mkdtemp(path.join(artifacts, 'shell-'));
  const bin = path.join(home, 'bin');

  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'fake-cli'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await fs.writeFile(path.join(home, '.bashrc'), [
    'echo startup-noise',
    'export CUSTOM_VALUE="space and = and\nnewline"',
    'export HTTPS_PROXY="http://fixture.invalid:8080"',
    `export PATH="${bin}:/usr/bin:/bin"`,
    '',
  ].join('\n'));
  await fs.writeFile(path.join(home, '.bash_profile'), 'source "$HOME/.bashrc"\n');

  const original = { PATH: '/inherited/bin:/usr/bin:/bin', NPM_CONFIG_PREFIX: path.join(home, 'prefix') };

  return {
    home,
    bin,
    input: {
      cliName: 'fake-cli',
      scratch: path.join(home, 'scratch'),
      env: {
        HOME: home,
        SHELL: '/bin/bash',
        PATH: '/packaged/bin:/usr/bin:/bin',
        npm_config_prefix: '/packaged/state/npm-global',
        GRIGDESK_USER_CLI_PARENT_V1: captureUserCliParent(original),
        GRIGDESK_SECRET: 'private',
        NODE_OPTIONS: '--not-a-loader',
      },
    },
  };
}

test('полный shell env учитывает exports и исходный prefix, служебные данные не уходят в CLI', async (t) => {
  const stand = await fixture(t);
  const result = await resolveUserCliEnvironment(stand.input);

  assert.equal(result.env.PATH, `${stand.bin}:/usr/bin:/bin`);
  assert.equal(result.env.CUSTOM_VALUE, 'space and = and\nnewline');
  assert.equal(result.env.HTTPS_PROXY, 'http://fixture.invalid:8080');
  assert.equal(result.env.npm_config_prefix, path.join(stand.home, 'prefix'));
  assert.equal(result.env.NPM_CONFIG_PREFIX, undefined);
  assert.equal(result.env.NODE_OPTIONS, undefined);
  assert.equal(Object.keys(result.env).some((key) => key.startsWith('GRIGDESK_')), false);
  assert.equal(result.loginEnv.CUSTOM_VALUE, result.env.CUSTOM_VALUE);
});

test('исходный custom PATH сохраняется, если startup его не заменил', async (t) => {
  const stand = await fixture(t);

  await fs.writeFile(path.join(stand.home, '.bashrc'), 'export CUSTOM_VALUE=preserved\n');

  const result = await resolveUserCliEnvironment(stand.input);

  assert.ok(result.env.PATH.includes('/inherited/bin'));
});

test('разные symlink-пути к одним node, npm и CLI не считаются конфликтом оболочек', async (t) => {
  const stand = await fixture(t);
  const aliases = path.join(stand.home, 'login-bin');

  await fs.mkdir(aliases);

  for (const name of ['node', 'npm', 'fake-cli']) {
    const target = path.join(stand.bin, name);

    if (name !== 'fake-cli') {
      await fs.writeFile(target, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }

    await fs.symlink(target, path.join(aliases, name));
  }

  await fs.appendFile(path.join(stand.home, '.bash_profile'), `export PATH="${aliases}:$PATH"\n`);

  const result = await resolveUserCliEnvironment(stand.input);

  assert.equal(result.cli.path, path.join(stand.bin, 'fake-cli'));
  assert.equal(result.node.path, path.join(stand.bin, 'node'));
  assert.equal(result.npm.path, path.join(stand.bin, 'npm'));
  assert.equal(result.env.PATH, `${stand.bin}:/usr/bin:/bin`);
  assert.equal(result.loginEnv.PATH, `${aliases}:${stand.bin}:/usr/bin:/bin`);
});

test('отдельные файлы с одинаковым содержимым остаются конфликтом выбора CLI', async (t) => {
  const stand = await fixture(t);
  const other = path.join(stand.home, 'other-bin');

  await fs.mkdir(other);
  await fs.copyFile(path.join(stand.bin, 'fake-cli'), path.join(other, 'fake-cli'));
  await fs.appendFile(path.join(stand.home, '.bash_profile'), `export PATH="${other}:$PATH"\n`);

  await assert.rejects(resolveUserCliEnvironment(stand.input), { code: 'shell_conflict' });
});

test('alias и расхождение interactive/login дают отказ до npm', async (t) => {
  const stand = await fixture(t);

  await fs.appendFile(path.join(stand.home, '.bashrc'), 'alias fake-cli="echo other"\n');
  await assert.rejects(resolveUserCliEnvironment(stand.input), { code: 'shell_command_unsupported' });
  await fs.writeFile(path.join(stand.home, '.bashrc'), `export PATH="${stand.bin}:/usr/bin:/bin"\n`);
  await fs.writeFile(path.join(stand.home, '.bash_profile'), 'export PATH=/usr/bin:/bin\n');
  await assert.rejects(resolveUserCliEnvironment(stand.input), { code: 'shell_conflict' });
});

test('невалидный bootstrap и неподдержанная оболочка не подменяются средой сервера', async (t) => {
  const stand = await fixture(t);

  stand.input.env.GRIGDESK_USER_CLI_PARENT_V1 = '{broken';
  await assert.rejects(resolveUserCliEnvironment(stand.input), { code: 'parent_environment_invalid' });
  delete stand.input.env.GRIGDESK_USER_CLI_PARENT_V1;
  stand.input.env.SHELL = '/bin/sh';
  await assert.rejects(resolveUserCliEnvironment(stand.input), { code: 'shell_unsupported' });
});

test('npm prefix сверяется у обеих форм shell до допуска установки', async (t) => {
  const stand = await fixture(t);

  await fs.writeFile(path.join(stand.bin, 'node'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await fs.writeFile(path.join(stand.bin, 'npm'), '#!/bin/sh\nprintf "%s\\n" "$FIXTURE_PREFIX"\n',
    { mode: 0o755 });
  await fs.appendFile(path.join(stand.home, '.bashrc'), `export FIXTURE_PREFIX="${stand.home}/first"\n`);
  await fs.appendFile(path.join(stand.home, '.bash_profile'),
    `export FIXTURE_PREFIX="${stand.home}/other"\n`);

  const roots = {
    dataHome: path.join(stand.home, 'data'),
    installationRoot: path.join(stand.home, 'installation'),
    runtimeRoot: path.join(stand.home, 'runtime'),
  };

  await assert.rejects(resolveUserCliNpm({
    ...stand.input,
    roots,
    packageId: '@fixture/cli',
  }),
    { code: 'shell_conflict' });
});
