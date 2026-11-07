import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  EXTERNAL_BASELINE_PATH,
  externalNpmEnvironment,
  externalVersion,
  npmInstallArgs,
  npmInstallCommandText,
  readGlobalPrefix,
  resolveExternalRuntime,
  selectInstallPrefix,
} from '../../server/src/lib/providerInstall/npmEnvironment.ts';

/**
 * Стенд держит D/I/R во временной папке и внешний Node/npm в собственном bin.
 * Настоящий PATH машины и её npm не участвуют: только явно созданные файлы.
 */
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-npm-env-'));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'external', 'bin');
  const roots = {
    dataHome: path.join(root, 'data'),
    installationRoot: path.join(root, 'installation'),
    runtimeRoot: path.join(root, 'runtime'),
  };

  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(bin, { recursive: true });
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(roots.dataHome, { recursive: true });
  await fs.mkdir(roots.installationRoot, { recursive: true });
  await fs.mkdir(roots.runtimeRoot, { recursive: true });

  const script = path.join(bin, 'npm');
  const prefix = options.prefix ?? path.join(root, 'prefix');

  await fs.writeFile(script, [
    '#!/bin/sh',
    `if [ "$1" = "prefix" ]; then printf '%s\\n' ${JSON.stringify(prefix)}; exit 0; fi`,
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 });
  await fs.writeFile(path.join(bin, 'node'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  const env = {
    PATH: `${bin}:${EXTERNAL_BASELINE_PATH}`,
    HOME: home,
    USER: 'fixture',
    SHELL: '/bin/bash',
    ...options.env,
  };

  return {
    root,
    home,
    bin,
    roots,
    env,
    npm: script,
    prefix,
  };
}

/**
 * Права каталога возвращаются даже после удаления стенда: очистка может
 * выполниться раньше и уже не найти путь. Отсутствие пути — не ошибка теста.
 */
const chmod = (target, mode) => fs.chmod(target, mode).catch(() => {});

async function failure(run, code) {
  await assert.rejects(async () => run(), (error) => {
    assert.equal(error.code, code, error.stack);
    assert.equal(error.message.includes('npm_config_prefix'), false, 'секрет попал в сообщение');

    return true;
  });
}

test('защитный D-prefix снимается, исходный env не меняется', async (t) => {
  const { env, roots, home, root } = await fixture(t);
  const source = {
    ...env,
    npm_config_prefix: path.join(roots.dataHome, 'state', 'npm-global'),
    HTTP_PROXY: 'http://proxy.fixture:3128',
    NPM_CONFIG_USERCONFIG: path.join(root, 'user.npmrc'),
  };
  const before = structuredClone(source);
  const prepared = externalNpmEnvironment({
    env: source,
    roots,
    home,
  });

  assert.equal(prepared.npm_config_prefix, undefined);
  assert.equal(prepared.NPM_CONFIG_PREFIX, undefined);
  assert.equal(prepared.HTTP_PROXY, 'http://proxy.fixture:3128');
  assert.equal(prepared.NPM_CONFIG_USERCONFIG, path.join(root, 'user.npmrc'));
  assert.deepEqual(source, before, 'исходное окружение сервера мутировано');
});

test('внешний env-prefix сохраняется, нижний регистр приоритетнее', async (t) => {
  const { env, roots, home, root } = await fixture(t);
  const external = path.join(root, 'custom-prefix');
  const prepared = externalNpmEnvironment({
    env: {
      ...env,
      NPM_CONFIG_PREFIX: path.join(root, 'upper'),
      npm_config_prefix: external,
    },
    roots,
    home,
  });

  assert.equal(prepared.npm_config_prefix, external);
  assert.equal(prepared.NPM_CONFIG_PREFIX, undefined, 'остались две формы одного ключа');

  const lowerOnly = externalNpmEnvironment({
    env: { ...env, NPM_CONFIG_PREFIX: external },
    roots,
    home,
  });

  assert.equal(lowerOnly.npm_config_prefix, external, 'верхняя форма не стала канонической');
  assert.equal(lowerOnly.NPM_CONFIG_PREFIX, undefined);
});

test('внутренний и относительный env-prefix — явный отказ, не «навязанный»', async (t) => {
  const { env, roots, home, root } = await fixture(t);

  for (const prefix of [
    path.join(roots.runtimeRoot, 'prefix'),
    path.join(roots.installationRoot, 'prefix'),
    path.join(roots.dataHome, 'other', 'prefix'),
    'relative/prefix',
  ]) {
    await failure(() => externalNpmEnvironment({
      env: {
        ...env,
        npm_config_prefix: prefix,
      },
      roots,
      home,
    }), 'npm_prefix_invalid');
  }
});

test('внешний runtime требует и npm, и внешний Node', async (t) => {
  const { env, roots, home, bin, npm } = await fixture(t);
  const runtime = await resolveExternalRuntime({
    env,
    roots,
    home,
  });

  assert.equal(runtime.npm, npm);
  assert.equal(runtime.node, path.join(bin, 'node'));
  assert.equal(runtime.env.npm_config_prefix, undefined);
  assert.ok(runtime.env.PATH.split(':')[0] === bin, 'внешний Node не закреплён в PATH npm');

  await fs.rm(npm);
  await failure(() => resolveExternalRuntime({
    env,
    roots,
    home,
  }), 'npm_missing');

  await fs.writeFile(npm, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await fs.rm(path.join(bin, 'node'));
  await failure(() => resolveExternalRuntime({
    env,
    roots,
    home,
  }), 'npm_runtime_missing');
});

test('npm с realpath внутри серверных корней не становится внешним', async (t) => {
  const { env, roots, home, bin, root } = await fixture(t);
  const inner = path.join(roots.runtimeRoot, 'node', 'bin');

  await fs.mkdir(inner, { recursive: true });
  await fs.writeFile(path.join(inner, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await fs.writeFile(path.join(inner, 'node'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await fs.symlink(path.join(inner, 'npm'), path.join(bin, 'npm-link'));
  await fs.rm(path.join(bin, 'npm'));

  // Ссылка из пользовательского bin на внутренний npm — не внешний runtime.
  await failure(() => resolveExternalRuntime({
    env: {
      ...env,
      PATH: `${bin}`,
    },
    roots,
    home,
  }), 'npm_missing');

  await fs.writeFile(path.join(bin, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  const runtime = await resolveExternalRuntime({
    env,
    roots,
    home,
  });

  assert.equal(runtime.npm, path.join(bin, 'npm'));
  assert.ok(root.startsWith(path.dirname(root)));
});

test('effective prefix читается выбранным npm из безопасного cwd', async (t) => {
  const { env, roots, home, prefix } = await fixture(t);
  const runtime = await resolveExternalRuntime({
    env,
    roots,
    home,
  });

  assert.equal(await readGlobalPrefix(runtime, { cwd: os.tmpdir(), timeoutMs: 5000 }), prefix);
});

test('одинаковый effective prefix из разных источников даёт одну политику', async (t) => {
  const { env, roots, home, prefix } = await fixture(t);

  await fs.mkdir(prefix, { recursive: true });

  const first = await selectInstallPrefix({
    runtime: await resolveExternalRuntime({
    env,
    roots,
    home,
  }),
    packageId: 'pkg',
    roots,
    home,
  });
  const second = await selectInstallPrefix({
    runtime: await resolveExternalRuntime({
      env: {
        ...env,
        NPM_CONFIG_USERCONFIG: path.join(home, 'other.npmrc'),
      },
      roots,
      home,
    }),
    packageId: 'pkg',
    roots,
    home,
  });

  assert.deepEqual({ prefix: first.prefix, fallback: first.fallback },
    { prefix: second.prefix, fallback: second.fallback });
  assert.equal(first.prefix, prefix);
});

test('недоступный для записи prefix даёт заранее показанный ~/.local', async (t) => {
  const { env, roots, home, root } = await fixture(t);
  const locked = path.join(root, 'locked-prefix');

  await fs.mkdir(locked, { recursive: true });
  await chmod(locked, 0o555);
  t.after(() => chmod(locked, 0o755));

  const runtime = await resolveExternalRuntime({
    env,
    roots,
    home,
  });
  const selection = await selectInstallPrefix({
    runtime,
    requested: locked,
    packageId: 'pkg',
    roots,
    home,
  });

  assert.equal(selection.prefix, path.join(home, '.local'));
  assert.equal(selection.fallback, true);

  await chmod(home, 0o555);
  t.after(() => chmod(home, 0o755));
  await failure(() => selectInstallPrefix({
    runtime,
    requested: locked,
    packageId: 'pkg',
    roots,
    home,
  }), 'npm_prefix_unwritable');
});

test('относительный, пустой и внутренний effective prefix отклоняются', async (t) => {
  const { env, roots, home, root } = await fixture(t);
  const runtime = await resolveExternalRuntime({
    env,
    roots,
    home,
  });
  const dataPrefix = path.join(roots.dataHome, 'state', 'npm-global');

  await fs.mkdir(dataPrefix, { recursive: true });

  for (const prefix of ['relative/prefix', '', dataPrefix, path.join(roots.runtimeRoot, 'x'),
    path.join(roots.installationRoot, 'x')]) {
    await failure(() => selectInstallPrefix({
      runtime,
      requested: prefix,
      packageId: 'pkg',
      roots,
      home,
    }), 'npm_prefix_invalid');
  }

  assert.ok(root);
});

test('ссылка посреди пути не обходит запрет внутренних каталогов', async (t) => {
  const {
    env,
    roots,
    home,
  } = await fixture(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-outside-'));

  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.symlink(roots.dataHome, path.join(outside, 'link'));

  const runtime = await resolveExternalRuntime({
    env,
    roots,
    home,
  });

  await failure(() => selectInstallPrefix({
    runtime,
    requested: path.join(outside, 'link', 'new'),
    packageId: 'pkg',
    roots,
    home,
  }), 'npm_prefix_invalid');
});

test('недоступный bin/lib выбранного пакета — до запуска npm', async (t) => {
  const {
    env,
    roots,
    home,
  } = await fixture(t);
  const prefix = path.join(home, '.local');

  await fs.mkdir(path.join(prefix, 'lib', 'node_modules'), { recursive: true });
  await chmod(path.join(prefix, 'lib', 'node_modules'), 0o555);
  t.after(() => chmod(path.join(prefix, 'lib', 'node_modules'), 0o755));

  const runtime = await resolveExternalRuntime({
    env,
    roots,
    home,
  });

  await failure(() => selectInstallPrefix({
    runtime,
    requested: prefix,
    packageId: 'pkg',
    roots,
    home,
  }), 'npm_prefix_unwritable');
});

test('prefix внутри версии nvm даёт предупреждение, а не отказ', async (t) => {
  const { env, roots, home, root } = await fixture(t);
  const nvmPrefix = path.join(home, '.nvm', 'versions', 'node', 'v24.1.0');
  const runtime = await resolveExternalRuntime({
    env,
    roots,
    home,
  });

  await fs.mkdir(nvmPrefix, { recursive: true });

  const selection = await selectInstallPrefix({
    runtime,
    requested: nvmPrefix,
    packageId: 'pkg',
    roots,
    home,
  });

  assert.equal(selection.prefix, nvmPrefix);
  assert.equal(selection.fallback, false);
  assert.deepEqual(selection.warnings.map((entry) => entry.code), ['npm_prefix_nvm_scoped']);
  assert.ok(root);
});

test('команда и argv несут выбранный prefix с корректным quoting', async (t) => {
  const prefix = '/home/user/.local';
  const args = npmInstallArgs('@scope/pkg', prefix);

  assert.deepEqual(args, ['i', '-g', '@scope/pkg@latest', '--prefix', prefix]);
  assert.equal(npmInstallCommandText('npm', '@scope/pkg', prefix),
    `npm i -g ${'@scope/pkg'}@latest --prefix ${prefix}`);

  const spaced = '/home/user/Мои файлы';
  const command = npmInstallCommandText('npm', 'pkg', spaced);

  assert.equal(command, `npm i -g pkg@latest --prefix '${spaced}'`);
  assert.equal(npmInstallArgs('pkg', spaced).includes(spaced), true);
});

test('версия нативного npm-bin проверяется прямым запуском, включая имя .exe', async (t) => {
  const box = await fixture(t);
  const binary = path.join(box.bin, 'native-cli.exe');

  await fs.symlink(process.execPath, binary);

  const version = await externalVersion({
    node: process.execPath,
    npm: box.npm,
    home: box.home,
    env: {
      HOME: box.home,
      PATH: box.bin,
    },
  }, binary);

  assert.equal(version, `v${process.versions.node}`);
});

test('JavaScript npm-bin использует выбранный внешний Node независимо от shebang', async (t) => {
  const box = await fixture(t);
  const binary = path.join(box.bin, 'script-cli.js');

  await fs.writeFile(binary, '#!/unavailable/node\nconsole.log("7.8.9");\n', { mode: 0o755 });

  const version = await externalVersion({
    node: process.execPath,
    npm: box.npm,
    home: box.home,
    env: {
      HOME: box.home,
      PATH: '',
    },
  }, binary);

  assert.equal(version, '7.8.9');
});
