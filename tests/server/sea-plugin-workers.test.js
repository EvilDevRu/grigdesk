import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createNpmRunner } from '../../server/src/lib/packageInstall/npm.ts';
import { runCommand } from '../../server/src/lib/packageInstall/runCommand.ts';
import {
  createRuntimePaths,
  helperCommand,
  helperCommandFor,
  nodeExecutable,
  readHelperCatalog,
} from '../../server/src/lib/runtimePaths.ts';

const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

/**
 * Временный каталог сценария; уборка удаляет только его.
 */
async function scratch(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-sea-workers-'));

  t.after(() => rm(root, {
    recursive: true,
    force: true
  }));

  return root;
}

test('SEA-PW-01: source-команды installer-helper-ов прежние', () => {
  const supervisor = helperCommand('plugin-command-supervisor', []);
  const blob = helperCommand('plugin-git-blob-prefix', ['abc']);

  assert.equal(supervisor.command, process.execPath);
  assert.deepEqual(supervisor.args, [
    path.join(ROOT, 'server/src/lib/packageInstall/commandSupervisor.mjs'),
  ]);
  assert.deepEqual(blob.args, [
    path.join(ROOT, 'server/src/lib/packageInstall/gitBlobPrefix.mjs'),
    'abc',
  ]);
});

test('SEA-PW-02: packaged-команды берут вложенный Node и helper своего R', async (t) => {
  const R = path.join(await scratch(t), 'R with space');
  const node = path.join(R, 'runtime/node/bin/node');

  await mkdir(path.dirname(node), {
    recursive: true
  });
  await mkdir(path.join(R, 'server/runtime/helpers'), {
    recursive: true
  });
  await writeFile(node, 'node');
  await chmod(node, 0o755);
  await writeFile(path.join(R, 'server/grigdesk-server'), 'binary');

  const paths = createRuntimePaths({
    mode: 'sea',
    execPath: path.join(R, 'server/grigdesk-server'),
  });
  const catalog = readHelperCatalog(path.join(ROOT, 'server/build/helpers.json'));
  const supervisor = helperCommandFor(paths, catalog, 'plugin-command-supervisor', []);
  const blob = helperCommandFor(paths, catalog, 'plugin-git-blob-prefix', ['abc']);

  assert.equal(supervisor.command, path.join(R, 'runtime/node/bin/node'));
  assert.deepEqual(supervisor.args, [
    path.join(R, 'server/runtime/helpers/plugin-command-supervisor.mjs'),
  ]);
  assert.deepEqual(blob.args, [
    path.join(R, 'server/runtime/helpers/plugin-git-blob-prefix.mjs'),
    'abc',
  ]);
});

test('SEA-PW-03: runCommand запускает supervisor helper и возвращает результат', async () => {
  const result = await runCommand(process.execPath, [
    '-e', "process.stdout.write('ok'); process.exit(3)",
  ], {
    env: {},
    timeoutMs: 5000,
  });

  assert.equal(result.code, 3);
  assert.equal(result.stdout, 'ok');
  assert.equal(result.aborted, false);
});

test('SEA-PW-04: npm-процесс берётся из пары Node/npm, cache и prefix вне R', async (t) => {
  const workspace = path.join(await scratch(t), 'plugin');
  const cache = path.join(await scratch(t), 'npm cache');
  const calls = [];

  await mkdir(workspace, {
    recursive: true
  });
  await writeFile(path.join(workspace, 'package.json'), JSON.stringify({
    name: 'plugin-fixture',
    version: '1.0.0',
  }));
  await writeFile(path.join(workspace, 'package-lock.json'), JSON.stringify({
    name: 'plugin-fixture',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: {
      '': {
        name: 'plugin-fixture',
        version: '1.0.0',
      }
    },
  }));

  const npm = createNpmRunner(async (file, args, options) => {
    calls.push({
      file,
      args,
      options
    });

    return {
      code: 0,
      stdout: '',
      stderr: ''
    };
  }, {
    cacheRoot: cache
  });

  await npm(workspace);

  assert.equal(calls[0].file, path.join(path.dirname(nodeExecutable()), 'npm'));
  assert.ok(calls[0].args.includes(`--cache=${cache}`));
  assert.ok(calls[0].args.includes(`--prefix=${workspace}`));
  assert.ok(!calls[0].args.some((value) => value.includes('runtime/node')));
});
