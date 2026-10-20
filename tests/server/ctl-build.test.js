import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const repository = path.resolve(import.meta.dirname, '../..');
const sourceMarkers = ['server/src/app.ts', 'web/package.json', 'desktop/package.json'];
const archiveBytes = Buffer.from('тестовый закреплённый архив');
const metadata = {
  format: 1,
  hostContract: 1,
  version: '0.1.0',
  packagingVersion: 2,
  packageId: 'a'.repeat(64),
  runtime: {
    node: '24.21.0',
    abi: '137',
    platform: 'linux',
    arch: 'x64',
  },
  capabilities: ['api', 'ipc', 'helpers', 'engine'],
  engine: { protocol: 'route-v2', sha256: 'b'.repeat(64) },
  payload: {
    sha256: 'c'.repeat(64),
    size: 12,
    entryCount: 1,
  },
};

/**
 * Команды пишут структурированный argv вместо сборки или управления процессами.
 * Сбой задаётся файлом внутри фикстуры и не требует новых переменных продукта.
 */
async function commandStub(file, command, calls, failure) {
  await fs.writeFile(file, [
    `#!${process.execPath}`,
    'const fs = require("node:fs");',
    `const command = ${JSON.stringify(command)};`,
    'const args = process.argv.slice(2);',
    'const event = { command, args, cwd: process.cwd() };',
    `fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(event) + "\\n");`,
    `const failure = JSON.parse(fs.readFileSync(${JSON.stringify(failure)}, "utf8"));`,
    'process.exit(failure.command === command && args.includes(failure.argument) ? failure.code : 0);',
  ].join('\n'), { mode: 0o755 });
}

/**
 * Весь checkout, ELF и HOME/XDG находятся в os.tmpdir, живой установки здесь нет.
 * Настоящий маленький ELF даёт metadata, но отказывает при попытке подготовки runtime.
 */
async function fixture(t, { source = true, binary = true, release = false } = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-ctl-build-'));
  const root = path.join(temporary, 'source with spaces');
  const home = path.join(temporary, 'home');
  const stubs = path.join(temporary, 'commands');
  const callsFile = path.join(temporary, 'calls.jsonl');
  const failure = path.join(temporary, 'failure.json');

  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  await fs.cp(path.join(repository, 'deploy'), path.join(root, 'deploy'), { recursive: true });

  for (const directory of ['bin', 'cli', 'tools', 'server/src', 'server/node_modules',
    'web/node_modules', 'desktop', 'shared/desktop', 'shared/runtime', 'shared/node',
    'server/scripts', 'server/build']) {
    await fs.mkdir(path.join(root, directory), { recursive: true });
  }

  await fs.mkdir(home);
  await fs.mkdir(stubs);
  await fs.writeFile(callsFile, '');
  await fs.writeFile(failure, '{}');
  await fs.cp(path.join(repository, 'bin/grigdesk-ctl'), path.join(root, 'bin/grigdesk-ctl'));
  await fs.writeFile(path.join(root, 'cli/main.ts'), 'console.log("СПРАВКА");\n');

  for (const name of ['shared/desktop/desktopRuntime.ts', 'shared/runtime/legacyBrand.ts',
    'shared/node/hash.ts', 'shared/node/nodeRuntime.ts', 'shared/node/seaBuild.ts',
    'server/scripts/ctlBuild.mts']) {
    await fs.copyFile(path.join(repository, name), path.join(root, name));
  }

  if (source) {
    for (const marker of sourceMarkers) {
      await fs.writeFile(path.join(root, marker), '{}\n');
    }
  }

  if (binary) {
    const entry = path.join(temporary, 'server.c');

    await fs.writeFile(entry, [
      '#include <stdio.h>',
      '#include <string.h>',
      'int main(int argc, char **argv) {',
      '  if (argc > 1 && !strcmp(argv[1], "--runtime-info")) {',
      `    puts(${JSON.stringify(JSON.stringify(metadata))});`,
      '    return 0;',
      '  }',
      '  return 96;',
      '}',
    ].join('\n'));
    await execute('cc', [entry, '-o', path.join(root, 'bin/grigdesk-server')]);
  }

  if (release) {
    await fs.writeFile(path.join(root, 'release.json'), '{}');
    await fs.mkdir(path.join(root, 'runtime/node/bin'), { recursive: true });
    await fs.symlink(process.execPath, path.join(root, 'runtime/node/bin/node'));
    await fs.writeFile(path.join(root, 'server/grigdesk-server'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  }

  for (const command of ['npm', 'systemctl', 'kill', 'xdg-open']) {
    await commandStub(path.join(stubs, command), command, callsFile, failure);
  }

  for (const command of ['mobile', 'release']) {
    await commandStub(path.join(root, 'tools', command), command, callsFile, failure);
  }

  await commandStub(path.join(root, 'deploy/desktop.sh'), 'desktop', callsFile, failure);

  const env = {
    PATH: `${stubs}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: home,
    XDG_CACHE_HOME: path.join(temporary, 'cache with spaces'),
    XDG_CONFIG_HOME: path.join(temporary, 'config'),
    XDG_DATA_HOME: path.join(temporary, 'data'),
    GRIGDESK_HOME: path.join(temporary, 'grigdesk'),
    npm_config_cache: path.join(temporary, 'npm'),
    ELECTRON_BUILDER_CACHE: path.join(temporary, 'electron'),
  };

  await fs.writeFile(path.join(root, 'server/build/node-runtime.json'), JSON.stringify({
    version: '24.21.0',
    platform: 'linux-x64',
    sha256: createHash('sha256').update(archiveBytes).digest('hex'),
  }));

  for (const base of [env.XDG_CACHE_HOME, path.join(home, '.cache')]) {
    const cache = path.join(base, 'grigdesk/server-binary/cache');

    await fs.mkdir(cache, { recursive: true });
    await fs.writeFile(path.join(cache, 'node-v24.21.0-linux-x64.tar.xz'), archiveBytes);
  }

  return {
    root,
    env,
    calls: async () => {
      const content = await fs.readFile(callsFile, 'utf8');

      return content.trim().split('\n').filter(Boolean).map(JSON.parse);
    },
    fail: (command, argument, code) => fs.writeFile(failure, JSON.stringify({
      command,
      argument,
      code,
    })),
    run: async (args, extra = {}) => {
      try {
        return { code: 0, ...await execute('/bin/bash', [path.join(root, 'bin/grigdesk-ctl'), ...args], {
          env: { ...env, ...extra },
          cwd: '/',
          timeout: 15000,
        }) };
      } catch (error) {
        return {
          code: error.code,
          stdout: error.stdout ?? '',
          stderr: error.stderr ?? '',
        };
      }
    },
  };
}

/**
 * Контракт all перечислен полностью: веб собирается один раз до упаковки окна.
 * Отдельные цели получают только свои стадии, без управления живыми компонентами.
 */
function expectedBuildCalls(box, target = 'all') {
  const cache = path.join(box.env.XDG_CACHE_HOME, 'grigdesk/server-binary');
  const server = [
    {
      command: 'npm',
      cwd: '/',
      args: ['--prefix', path.join(box.root, 'server'), 'run', 'build:binary', '--',
        '--out-dir', path.join(cache, 'out'), '--cache-dir', path.join(cache, 'cache')],
    },
    {
      command: 'npm',
      cwd: '/',
      args: ['--prefix', path.join(box.root, 'server'), 'run', 'install:binary', '--',
        '--binary', path.join(cache, 'out/grigdesk-server'),
        '--target', path.join(box.root, 'bin/grigdesk-server'),
        '--releases-dir', path.join(box.env.GRIGDESK_HOME, 'runtimes/server/releases')],
    },
  ];
  const web = [
    {
      command: 'npm',
      cwd: path.join(box.root, 'server'),
      args: ['run', '--silent', 'deepseek:prepare'],
    },
    {
      command: 'npm',
      cwd: path.join(box.root, 'web'),
      args: ['run', 'build'],
    },
  ];
  const window = [
    {
      command: 'npm',
      cwd: '/',
      args: ['--prefix', path.join(box.root, 'desktop'), 'run', 'dist'],
    },
    {
      command: 'desktop',
      cwd: '/',
      args: ['install'],
    },
  ];

  if (target === 'server') {
    return server;
  }

  if (target === 'web') {
    return web;
  }

  return target === 'window' ? [...web, ...window] : [...server, ...web, ...window];
}

test('build: исходники с установленным ELF сохраняют путь разработчика', async (t) => {
  const box = await fixture(t);
  const result = await box.run(['build', 'web']);

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual((await box.calls()).map((call) => call.args), [
    ['run', '--silent', 'deepseek:prepare'],
    ['run', 'build'],
  ]);
});

test('build: исходники без ELF сохраняют прежнюю сборку web', async (t) => {
  const box = await fixture(t, { binary: false });

  assert.equal((await box.run(['build', 'web'])).code, 0);
  assert.equal((await box.calls()).at(-1).cwd, path.join(box.root, 'web'));
});

test('build: без каждого признака исходников ELF сохраняет прежний отказ байт в байт', async (t) => {
  for (const marker of sourceMarkers) {
    const box = await fixture(t);

    await fs.rm(path.join(box.root, marker));

    for (const command of ['dev', 'build', 'deps', 'mobile', 'release']) {
      const result = await box.run([command]);

      assert.equal(result.code, 1);
      assert.equal(result.stderr, `Команда ${command} доступна в установке из исходников.\n`);
      assert.deepEqual(await box.calls(), []);
    }
  }
});

test('build: release.json сохраняет отказ готовой поставки даже с признаками исходников', async (t) => {
  for (const binary of [false, true]) {
    const box = await fixture(t, { binary, release: true });
    const result = await box.run(['build']);

    assert.equal(result.code, 1);
    assert.equal(result.stderr, 'Команда build доступна в установке из исходников.\n');
    assert.deepEqual(await box.calls(), []);
  }
});

test('build: --help и -h в исходниках не вызывают сборку и установку', async (t) => {
  for (const binary of [false, true]) {
    const box = await fixture(t, { binary });

    for (const flag of ['--help', '-h']) {
      const result = await box.run(['build', 'window', flag]);

      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /СПРАВКА/);
      assert.deepEqual(await box.calls(), []);
    }
  }
});

test('build: deps/mobile/release в исходниках обходят установленный ELF', async (t) => {
  for (const command of ['deps', 'mobile', 'release']) {
    const box = await fixture(t);
    const result = await box.run([command, 'probe']);

    assert.equal(result.code, 0, result.stderr);
    assert.ok((await box.calls()).length > 0);
  }
});

test('build: all по умолчанию и отдельные цели соблюдают точный порядок и argv', async (t) => {
  for (const target of [undefined, 'all', 'server', 'web', 'window']) {
    const box = await fixture(t);
    const result = await box.run(['build', ...target ? [target] : []]);

    assert.equal(result.code, 0, `${target}: ${result.stderr}`);
    assert.deepEqual(await box.calls(), expectedBuildCalls(box, target));

    if (target === 'web') {
      assert.match(result.stdout, /Окно покажет новый веб после grigdesk-ctl build window/);
      assert.doesNotMatch(result.stdout, /Закройте окно/);
    } else {
      assert.match(result.stdout, /Закройте окно и откройте снова — запустится новый код/);
    }
  }
});

test('build: неизвестная цель и лишний аргумент дают код 2 до эффектов', async (t) => {
  for (const tail of [['unknown'], ['--unknown'], [''], ['server', 'web'], ['all', 'extra']]) {
    const box = await fixture(t);
    const result = await box.run(['build', ...tail]);

    assert.equal(result.code, 2, `${JSON.stringify(tail)}: ${result.stderr}`);
    assert.match(result.stderr, /build \[all\|server\|web\|window\]/);
    assert.deepEqual(await box.calls(), []);
  }
});

test('build: первая ошибка обрывает all и сохраняет код отказавшей стадии', async (t) => {
  const failures = [
    ['npm', 'build:binary', 21, 1, 'server'],
    ['npm', 'install:binary', 22, 2, 'server'],
    ['npm', 'build', 23, 4, 'web'],
    ['npm', 'dist', 24, 5, 'window'],
    ['desktop', 'install', 25, 6, 'window'],
  ];

  for (const [command, argument, code, count, step] of failures) {
    const box = await fixture(t);

    await box.fail(command, argument, code);

    const result = await box.run(['build']);

    assert.equal(result.code, code, result.stderr);
    assert.match(result.stderr, new RegExp(`не удалось: ${step}`));
    assert.deepEqual(await box.calls(), expectedBuildCalls(box).slice(0, count));
    assert.doesNotMatch(result.stdout, /Закройте окно/);
  }
});

test('build server: D и кэш по умолчанию вычисляются из временного HOME', async (t) => {
  const box = await fixture(t);
  const result = await box.run(['build', 'server'], {
    GRIGDESK_HOME: undefined,
    XDG_CACHE_HOME: undefined,
  });
  const expected = expectedBuildCalls({
    ...box,
    env: {
      ...box.env,
      GRIGDESK_HOME: path.join(box.env.HOME, '.grigdesk'),
      XDG_CACHE_HOME: path.join(box.env.HOME, '.cache'),
    },
  }, 'server');

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(await box.calls(), expected);
});

test('build server: отказ подготовки Node останавливает all до npm и установщиков', async (t) => {
  const box = await fixture(t);

  await fs.writeFile(path.join(box.root, 'server/build/node-runtime.json'), '{}');

  const result = await box.run(['build']);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Некорректный.*node-runtime/);
  assert.match(result.stderr, /не удалось: server/);
  assert.deepEqual(await box.calls(), []);
});

test('build server: подсказка выбора только для другого descriptor, файл не меняется', async (t) => {
  for (const kind of ['missing', 'v3', 'foreign', 'v4']) {
    const box = await fixture(t);
    const binary = path.join(box.root, 'bin/grigdesk-server');
    const descriptor = kind === 'v3' ? {
      version: 3,
      kind: 'sea',
      root: '/legacy',
      home: box.env.GRIGDESK_HOME,
    } : {
      version: 4,
      kind: 'binary',
      binary: kind === 'foreign' ? '/other/bin/grigdesk-server' : binary,
      home: box.env.GRIGDESK_HOME,
      cliPaths: [],
    };
    const file = path.join(box.env.XDG_DATA_HOME, 'grigdesk/desktop/runtime.json');
    const text = JSON.stringify(descriptor);

    if (kind !== 'missing') {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, text);
    }

    const result = await box.run(['build', 'server']);

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(await box.calls(), expectedBuildCalls(box, 'server'));

    if (kind === 'v4') {
      assert.doesNotMatch(result.stdout, /grigdesk-ctl desktop use-server/);
    } else {
      assert.match(result.stdout, /grigdesk-ctl desktop use-server /);
    }

    if (kind !== 'missing') {
      assert.equal(await fs.readFile(file, 'utf8'), text);
      assert.deepEqual(await fs.readdir(path.dirname(file)), ['runtime.json']);
    } else {
      await assert.rejects(fs.stat(file), { code: 'ENOENT' });
    }
  }
});
