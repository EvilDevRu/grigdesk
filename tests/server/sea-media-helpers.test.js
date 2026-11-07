import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { resolveWorkerCommand } from '../../server/src/lib/showcase/render/runner.ts';

import {
  createRuntimePaths,
  helperCommand,
  helperCommandFor,
  moduleUrlFor,
  readHelperCatalog,
} from '../../server/src/lib/runtimePaths.ts';

const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

/**
 * Временный каталог сценария; уборка удаляет только его.
 */
async function scratch(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-sea-media-'));

  t.after(() => rm(root, {
    recursive: true,
    force: true
  }));

  return root;
}

/**
 * Минимальный упакованный R: вложенный Node, бинарник и каталог helper-ов.
 * Содержимое файлов условно: проверяются пути и разрешение из комплекта.
 */
async function packaged(t) {
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

  return {
    R,
    paths: createRuntimePaths({
      mode: 'sea',
      execPath: path.join(R, 'server/grigdesk-server'),
    }),
  };
}

test('SEA-MEDIA-01: source-команды worker-ов прежние', () => {
  const ingest = helperCommand('media-ingest-worker', ['status.json']);

  assert.equal(ingest.command, process.execPath);
  assert.deepEqual(ingest.args, [
    path.join(ROOT, 'server/src/lib/media/ingestWorker.ts'),
    'status.json',
  ]);
});

test('SEA-MEDIA-02: packaged-команды берут helper-ы своего R', async (t) => {
  const { R, paths } = await packaged(t);
  const catalog = readHelperCatalog(path.join(ROOT, 'server/build/helpers.json'));
  const ingest = helperCommandFor(paths, catalog, 'media-ingest-worker', ['status.json']);

  assert.equal(ingest.command, path.join(R, 'runtime/node/bin/node'));
  assert.deepEqual(ingest.args, [
    path.join(R, 'server/runtime/helpers/media-ingest-worker.mjs'),
    'status.json',
  ]);
});

test('SEA-MEDIA-03: Python-ресурсы и requirements находятся после переноса R', async (t) => {
  const { R, paths } = await packaged(t);
  const requirements = moduleUrlFor(paths, 'server/requirements-showcase-voice.txt');
  const transcribe = moduleUrlFor(paths, 'server/src/lib/media/transcribe.py');
  const pty = moduleUrlFor(paths, 'server/src/modules/terminal/pty-helper.py');

  assert.equal(requirements.href,
    pathToFileURL(path.join(R, 'server/requirements-showcase-voice.txt')).href);
  assert.ok(requirements.pathname.endsWith('/server/requirements-showcase-voice.txt'));
  assert.ok(transcribe.pathname.endsWith('/server/src/lib/media/transcribe.py'));
  assert.ok(pty.pathname.endsWith('/server/src/modules/terminal/pty-helper.py'));
});

test('SEA-MEDIA-04: playwright-core разрешается из node_modules комплекта', async (t) => {
  const { R, paths } = await packaged(t);
  const packageDirectory = path.join(R, 'server/node_modules/playwright-core');

  await mkdir(packageDirectory, {
    recursive: true
  });
  await writeFile(path.join(packageDirectory, 'package.json'), JSON.stringify({
    name: 'playwright-core',
    version: '0.0.0-fixture',
  }));

  const moduleFile = path.join(R, 'server/src/lib/showcase/browserInstall.ts');
  const requireFromR = createRequire(moduleFile);

  assert.equal(requireFromR.resolve('playwright-core/package.json'),
    path.join(packageDirectory, 'package.json'));
  assert.equal(fileURLToPath(moduleUrlFor(paths, 'server/src/lib/showcase/browserInstall.ts')),
    moduleFile);
});


test('SEA-MEDIA-05: showcase workers выбирают штатный helper или явный тестовый скрипт', () => {
  const taskFile = '/work/task.json';
  const rehearsal = resolveWorkerCommand({ helper: 'showcase-rehearsal' }, taskFile);

  assert.equal(rehearsal.command, process.execPath);
  assert.deepEqual(rehearsal.args, [
    path.join(ROOT, 'server/scripts/showcaseRehearsal.mts'),
    taskFile,
  ]);
  assert.equal(rehearsal.marker, 'showcaseRehearsal');
  assert.equal(rehearsal.args[0].includes(rehearsal.marker), true);

  assert.deepEqual(resolveWorkerCommand({
    script: { file: '/tmp/worker.mjs', marker: 'explicit' },
    nodeBin: '/tmp/node',
  }, taskFile), {
    command: '/tmp/node',
    args: ['/tmp/worker.mjs', taskFile],
    marker: 'explicit',
  });

  const fallback = resolveWorkerCommand({}, taskFile);

  assert.equal(fallback.marker, 'showcaseWorker');
  assert.deepEqual(fallback.args, [
    path.join(ROOT, 'server/scripts/showcaseWorker.mts'),
    taskFile,
  ]);
});

test('REVIEW-R5: override Node сохраняет скрипт каждого штатного установщика', () => {
  for (const [helper, file] of [
    ['showcase-voice-install', 'showcaseVoiceInstall.mts'],
    ['showcase-browser-install', 'showcaseBrowserInstall.mts'],
  ]) {
    const command = resolveWorkerCommand({ helper, nodeBin: '/fixture/node' }, '/fixture/task.json');

    assert.equal(command.command, '/fixture/node');
    assert.deepEqual(command.args, [path.join(ROOT, 'server/scripts', file), '/fixture/task.json']);
    assert.equal(command.marker, path.basename(file, '.mts'));
    assert.equal(command.args[0].includes(command.marker), true);
  }
});

test('SEA-MEDIA-06: packaged showcase-команды берут helper-ы своего R', async (t) => {
  const { R, paths } = await packaged(t);
  const catalog = readHelperCatalog(path.join(ROOT, 'server/build/helpers.json'));

  for (const [id, file] of [
    ['showcase-worker', 'showcaseWorker.mts'],
    ['showcase-rehearsal', 'showcaseRehearsal.mts'],
    ['showcase-voice-install', 'showcaseVoiceInstall.mts'],
    ['showcase-browser-install', 'showcaseBrowserInstall.mts'],
  ]) {
    const command = helperCommandFor(paths, catalog, id, ['task.json']);

    assert.equal(command.command, path.join(R, 'runtime/node/bin/node'));
    assert.deepEqual(command.args, [
      path.join(R, 'server/runtime/helpers', `${id}.mjs`),
      'task.json',
    ]);
    assert.match(file, /\.mts$/);
  }
});
