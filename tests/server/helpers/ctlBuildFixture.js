import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const repository = path.resolve(import.meta.dirname, '../../..');
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
export function expectedBuildCalls(box, target = 'all') {
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

