import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const repository = path.resolve(import.meta.dirname, '../../..');
const sourceMarkers = ['server/src/app.ts', 'web/package.json', 'desktop/package.json'];
const archiveBytes = Buffer.from('тестовый закреплённый архив');

// Продуктовая версия ELF обязана совпадать с VERSION: runtime-env проверяет её при
// выборе сервера, и захардкоженное значение в фикстуре разъезжалось при бампе.
const productVersion = readFileSync(path.join(repository, 'VERSION'), 'utf8').trim();

const metadata = {
  format: 1,
  hostContract: 1,
  version: productVersion,
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
async function commandStub(file, command, calls, failure, effect = []) {
  await fs.writeFile(file, [
    `#!${process.execPath}`,
    'const fs = require("node:fs");',
    `const command = ${JSON.stringify(command)};`,
    'const args = process.argv.slice(2);',
    'const event = { command, args, cwd: process.cwd() };',
    `fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(event) + "\\n");`,
    `const failure = JSON.parse(fs.readFileSync(${JSON.stringify(failure)}, "utf8"));`,
    'const failed = failure.command === command && args.includes(failure.argument);',
    ...effect,
    'process.exit(failure.command === command && args.includes(failure.argument) ? failure.code : 0);',
  ].join('\n'), { mode: 0o755 });
}

/**
 * Весь checkout, ELF и HOME/XDG находятся в os.tmpdir, живой установки здесь нет.
 * Настоящий маленький ELF даёт metadata, но отказывает при попытке подготовки runtime.
 */
export async function fixture(t, { source = true, binary = true, release = false } = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-ctl-build-'));
  const root = path.join(temporary, 'source with spaces');
  const home = path.join(temporary, 'home');
  const stubs = path.join(temporary, 'commands');
  const callsFile = path.join(temporary, 'calls.jsonl');
  const failure = path.join(temporary, 'failure.json');

  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  await fs.cp(path.join(repository, 'deploy'), path.join(root, 'deploy'), { recursive: true });

  for (const directory of ['bin', 'cli', 'tools', 'server/src', 'server/node_modules',
    'web/node_modules', 'tracker/node_modules', 'desktop', 'shared/desktop', 'shared/runtime',
    'shared/node', 'server/scripts', 'server/build', 'server/src/lib']) {
    await fs.mkdir(path.join(root, directory), { recursive: true });
  }

  await fs.mkdir(home);
  await fs.mkdir(stubs);
  await fs.writeFile(callsFile, '');
  await fs.writeFile(failure, '{}');
  await fs.cp(path.join(repository, 'bin/grigdesk-ctl'), path.join(root, 'bin/grigdesk-ctl'));
  await fs.writeFile(path.join(root, 'cli/main.ts'), 'console.log("СПРАВКА");\n');

  await fs.cp(path.join(repository, 'shared'), path.join(root, 'shared'), { recursive: true });

  for (const name of ['server/scripts/ctlBuild.mts', 'server/src/lib/selectSeaServer.ts',
    'server/src/lib/builtServerSelection.ts', 'server/src/lib/dataHomeBoot.ts',
    'server/src/lib/helperEntry.ts', 'server/src/lib/nodeVersion.ts']) {
    await fs.copyFile(path.join(repository, name), path.join(root, name));
  }

  if (source) {
    for (const marker of sourceMarkers) {
      await fs.writeFile(path.join(root, marker), '{}\n');
    }
  }

  const template = path.join(temporary, 'server-fixture');

  {
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
    await execute('cc', [entry, '-o', template]);
  }

  if (binary) {
    await fs.copyFile(template, path.join(root, 'bin/grigdesk-server'));
  }

  if (release) {
    await fs.writeFile(path.join(root, 'release.json'), '{}');
    await fs.mkdir(path.join(root, 'runtime/node/bin'), { recursive: true });
    await fs.symlink(process.execPath, path.join(root, 'runtime/node/bin/node'));
    await fs.writeFile(path.join(root, 'server/grigdesk-server'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  }

  for (const command of ['npm', 'systemctl', 'kill', 'xdg-open']) {
    const effect = command === 'npm' ? [
      'if (!failed && args.includes("install:binary")) {',
      '  const target = args[args.indexOf("--target") + 1];',
      `  fs.copyFileSync(${JSON.stringify(template)}, target);`,
      '}',
    ] : [];

    await commandStub(path.join(stubs, command), command, callsFile, failure, effect);
  }

  for (const command of ['mobile', 'release']) {
    await commandStub(path.join(root, 'tools', command), command, callsFile, failure);
  }

  await commandStub(path.join(root, 'deploy/desktop.sh'), 'desktop', callsFile, failure, [
    'if (!failed && args.includes("install")) {',
    '  const path = require("node:path");',
    '  const file = path.join(process.env.XDG_DATA_HOME, "grigdesk/desktop/runtime.json");',
    '  if (!fs.existsSync(file)) {',
    '    fs.mkdirSync(path.dirname(file), { recursive: true });',
    `    fs.writeFileSync(file, JSON.stringify({ version: 1, root: ${JSON.stringify(root)},`,
    '      node: process.execPath }));',
    '  }',
    '}',
  ]);

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
 * Контракт all: общие зависимости, затем параллельные цепочки сервера, окна и tasks,
 * установка окна строго последней. Цепочки могут интерливиться в любом порядке.
 */
export function expectedAllPhases(box) {
  const cache = path.join(box.env.XDG_CACHE_HOME, 'grigdesk/server-binary');
  const trackerCache = path.join(box.env.XDG_CACHE_HOME, 'grigdesk/tracker-binary');

  return {
    deps: [{
      command: 'npm',
      cwd: path.join(box.root, 'server'),
      args: ['install', '--no-audit', '--no-fund'],
    }, {
      command: 'npm',
      cwd: path.join(box.root, 'server'),
      args: ['run', '--silent', 'deepseek:prepare'],
    }],
    tracks: [
      [
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
            '--releases-dir', path.join(box.env.GRIGDESK_HOME, 'runtimes/server/releases'),
            '--glm-mode', 'api'],
        },
      ],
      [
        {
          command: 'npm',
          cwd: path.join(box.root, 'web'),
          args: ['run', 'build'],
        },
        {
          command: 'npm',
          cwd: '/',
          args: ['--prefix', path.join(box.root, 'desktop'), 'run', 'dist'],
        },
      ],
      [
        {
          command: 'npm',
          cwd: '/',
          args: ['--prefix', path.join(box.root, 'tracker'), 'run', 'build', '--',
            '--out-dir', path.join(box.root, 'bin'),
            '--cache-dir', path.join(trackerCache, 'cache')],
        },
      ],
    ],
    install: [{
      command: 'desktop',
      cwd: '/',
      args: ['install', '--keep-runtime'],
    }],
  };
}

/**
 * Параллельные цепочки узнаются по содержимому вызова: фазы deps и install держат
 * свои места, а вызовы каждой цепочки сохраняют внутренний порядок без общей
 * последовательности между цепочками.
 */
export function assertInterleavedPhases(actual, phases) {
  const middle = actual.slice(phases.deps.length, actual.length - phases.install.length);

  assert.deepEqual(actual.slice(0, phases.deps.length), phases.deps);
  assert.deepEqual(actual.slice(actual.length - phases.install.length), phases.install);

  const remaining = [...middle];

  for (const track of phases.tracks) {
    const found = [];

    for (const call of track) {
      const index = remaining.findIndex((item) => item.command === call.command
        && item.cwd === call.cwd && JSON.stringify(item.args) === JSON.stringify(call.args));

      assert.ok(index >= 0, `Отсутствует вызов сборки: ${JSON.stringify(call)}`);
      found.push(index);
    }

    assert.deepEqual(found, [...found].sort((a, b) => a - b), 'Нарушен порядок внутри цепочки');

    for (const index of found.reverse()) {
      remaining.splice(index, 1);
    }
  }

  assert.deepEqual(remaining, [], 'Лишние вызовы вне ожидаемых цепочек');
}

/**
 * Контракт отдельных целей перечислен полностью: веб собирается до упаковки окна.
 */
export function expectedBuildCalls(box, target) {
  if (target === 'apk') {
    return [{
      command: 'mobile',
      cwd: '/',
      args: ['build'],
    }];
  }

  const cache = path.join(box.env.XDG_CACHE_HOME, 'grigdesk/server-binary');
  const server = [
    {
      command: 'npm',
      cwd: path.join(box.root, 'server'),
      args: ['install', '--no-audit', '--no-fund'],
    },
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
        '--releases-dir', path.join(box.env.GRIGDESK_HOME, 'runtimes/server/releases'),
        '--glm-mode', 'api'],
    },
  ];
  const web = [
    {
      command: 'npm',
      cwd: path.join(box.root, 'server'),
      args: ['install', '--no-audit', '--no-fund'],
    },
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

  if (target === 'deepseek') {
    const deepseekCache = path.join(box.env.XDG_CACHE_HOME, 'grigdesk/deepseek-binary');

    return [
      {
        command: 'npm',
        cwd: '/',
        args: ['--prefix', path.join(box.root, 'deepseek'), 'install', '--no-audit', '--no-fund'],
      },
      {
        command: 'npm',
        cwd: '/',
        args: ['--prefix', path.join(box.root, 'deepseek'), 'run', '--silent', 'prepare:runtime', '--',
          '--node-cache-dir', path.join(deepseekCache, 'cache')],
      },
      {
        command: 'npm',
        cwd: '/',
        args: ['--prefix', path.join(box.root, 'deepseek'), 'run', 'build', '--',
          '--out-dir', path.join(deepseekCache, 'out'),
          '--node-cache-dir', path.join(deepseekCache, 'cache')],
      },
      {
        command: 'npm',
        cwd: '/',
        args: ['--prefix', path.join(box.root, 'deepseek'), 'run', 'verify', '--',
          '--binary', path.join(deepseekCache, 'out/deepseek')],
      },
      {
        command: 'npm',
        cwd: '/',
        args: ['--prefix', path.join(box.root, 'deepseek'), 'run', '--silent', 'admission:check', '--',
          '--binary', path.join(deepseekCache, 'out/deepseek'), '--mode', 'api',
          '--host-contract', path.join(box.root, 'server/deepseek-host-contract.json')],
      },
      {
        command: 'npm',
        cwd: '/',
        args: ['--prefix', path.join(box.root, 'deepseek'), 'run', '--silent', 'install:binary', '--',
          '--binary', path.join(deepseekCache, 'out/deepseek'),
          '--target', path.join(box.root, 'bin/deepseek'),
          '--host-contract', path.join(box.root, 'server/deepseek-host-contract.json'),
          '--releases-dir', path.join(box.env.GRIGDESK_HOME, 'runtimes/deepseek/releases'),
          '--glm-mode', 'api'],
      },
      {
        command: 'npm',
        cwd: '/',
        args: ['--prefix', path.join(box.root, 'deepseek'), 'run', '--silent', 'prune:cache', '--',
          '--cache-dir', path.join(box.env.GRIGDESK_HOME, 'runtimes/deepseek')],
      },
    ];
  }

  if (target === 'server') {
    return server;
  }

  if (target === 'web') {
    return web;
  }

  return [...web, ...window];
}

