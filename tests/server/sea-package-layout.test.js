import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { sha256 } from '../../shared/node/hash.ts';
import {
  assertRuntimeDependencies,
  collectLicenses,
  installDependencies,
  runtimeSpecifiers,
} from '../../server/scripts/sea/dependencies.mts';
import { copyResources } from '../../server/scripts/sea/resources.mts';
import * as dependencies from '../../server/scripts/sea/dependencies.mts';
import * as stage from '../../server/scripts/sea/stage.mts';
import * as build from '../../server/scripts/buildSea.mts';

const { auditStage } = stage;

const SOURCE = path.resolve(import.meta.dirname, '../..');

test('RET-ASSETS: снятый набор отсутствует в allowlist и исходниках', async (t) => {
  const retiredSource = ['server', 'seed', 'agents'].join('/');

  for (const name of ['resources.json', 'binary-resources.json']) {
    await t.test(name, async () => {
      const file = path.join(SOURCE, 'server/build', name);
      const manifest = JSON.parse(await readFile(file, 'utf8'));

      assert.equal(manifest.entries.some((entry) =>
        entry.source === retiredSource || entry.target === retiredSource), false);
    });
  }

  await t.test('опись ресурсов', async () => {
    const file = path.join(SOURCE, 'server/build/sea-inventory.json');
    const inventory = JSON.parse(await readFile(file, 'utf8'));
    const retiredResource = ['server', 'seed', ''].join('/');

    assert.equal(inventory.resources.some((resource) => resource.path === retiredResource), false);
  });

  await t.test('исходный каталог', async () => {
    await assert.rejects(stat(path.join(SOURCE, retiredSource)), { code: 'ENOENT' });
  });
});

/**
 * Создаёт только временные входы и staging одного теста.
 * Fixture не читает пользовательское состояние и удаляет собственный каталог.
 */
async function scratch(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-sea-layout-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  return root;
}

/**
 * Пишет файл вместе с родительскими каталогами внутри фикстуры.
 * Права задаются явно только там, где проверяется executable.
 */
async function put(root, relative, text = 'fixture') {
  const file = path.join(root, relative);

  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);

  return file;
}

test('SEA-LAYOUT-01: ресурсы копируются только по allowlist, пропажа — отказ', async (t) => {
  const root = await scratch(t);
  const source = path.join(root, 'source');
  const stage = path.join(root, 'stage');

  await put(source, 'allowed/asset.py');
  await put(source, '.env', 'fixture-secret');
  await copyResources(source, stage, { schema: 1, entries: [
    {
      source: 'allowed/asset.py',
      target: 'server/src/asset.py',
      kind: 'file',
    },
  ] });

  assert.equal(await readFile(path.join(stage, 'server/src/asset.py'), 'utf8'), 'fixture');
  await assert.rejects(readFile(path.join(stage, '.env')), { code: 'ENOENT' });
  await assert.rejects(copyResources(source, stage, { schema: 1, entries: [
    {
      source: 'missing.py',
      target: 'server/src/missing.py',
      kind: 'file',
    },
  ] }), /missing.py/);
});

test('SEA-LAYOUT-06: лицензии обязательны и копируются вместе с индексом пакетов', async (t) => {
  const root = await scratch(t);

  await put(root, 'runtime/node/LICENSE', 'Node fixture license');
  await put(root, 'server/node_modules/library/package.json', JSON.stringify({
    name: 'library',
    version: '1.0.0',
    license: 'MIT',
  }));
  await assert.rejects(collectLicenses(root), /лицензи/i);
  await put(root, 'server/node_modules/library/LICENSE', 'Library fixture license');

  const licenses = await collectLicenses(root);

  assert.equal(licenses.packages[0].name, 'library');
  assert.equal(await readFile(path.join(root, licenses.packages[0].files[0]), 'utf8'),
    'Library fixture license');
  assert.equal(await readFile(path.join(root, 'licenses/NODE.txt'), 'utf8'), 'Node fixture license');
});

test('SEA-LAYOUT-07: настоящий allowlist содержит все Python-ресурсы inventory и только их исходники',
  async (t) => {
    const root = await scratch(t);
    const manifest = JSON.parse(await readFile(path.join(SOURCE, 'server/build/resources.json'), 'utf8'));
    const inventoryFile = path.join(SOURCE, 'server/build/sea-inventory.json');
    const inventory = JSON.parse(await readFile(inventoryFile, 'utf8'));

    for (const resource of inventory.resources.filter((item) => item.fate === 'asset'
      && item.path.endsWith('.py'))) {
      assert.ok(manifest.entries.some((entry) => entry.source === resource.path), resource.path);
    }

    await copyResources(SOURCE, root, manifest);

    const files = await auditStage(root, { required: manifest.entries
      .filter((entry) => entry.kind === 'file').map((entry) => entry.target) });

    assert.equal(files.some((file) => file.path === 'server/src/app.ts'), false);
    assert.equal(files.some((file) => file.path === 'server/src/modules/terminal/pty-helper.py'), true);
  });

test('SEA-LAYOUT-08: fallback лицензии требует точную версию, SPDX и закреплённые байты', async (t) => {
  const root = await scratch(t);
  const fallbackFile = path.join(root, 'fallback/index.json');
  const sourceText = 'Fixture license terms';

  await put(root, 'runtime/node/LICENSE', 'Node fixture');
  await put(root, 'server/node_modules/library/package.json', JSON.stringify({
    name: 'library',
    version: '1.0.0',
    license: 'ISC',
    author: 'Fixture owner',
  }));
  await put(root, 'fallback/ISC.txt', sourceText);
  await put(root, 'fallback/index.json', JSON.stringify({ schema: 1, packages: [{
    name: 'library',
    version: '1.0.0',
    license: 'ISC',
    file: 'ISC.txt',
    sha256: sha256(sourceText),
    source: 'https://example.invalid/fixture-license',
  }] }));

  const licenses = await collectLicenses(root, { fallbackFile });
  const files = licenses.packages[0].files;

  assert.equal(await readFile(path.join(root, files[0]), 'utf8'), sourceText);
  assert.equal(JSON.parse(await readFile(path.join(root, files[1]), 'utf8')).author, 'Fixture owner');
  await put(root, 'fallback/ISC.txt', 'tampered');
  await assert.rejects(collectLicenses(root, { fallbackFile }), /SHA256/);
});

test('SEA-LAYOUT-02: ресурсы не допускают traversal, секрет и ссылку наружу', async (t) => {
  const root = await scratch(t);
  const source = path.join(root, 'source');

  await put(source, 'asset.py');
  await put(source, '.env');
  await symlink('/etc/passwd', path.join(source, 'escape.py'));

  for (const entry of [
    {
      source: '.env',
      target: '.env',
      kind: 'file',
    },
    {
      source: '../outside',
      target: 'server/resource',
      kind: 'file',
    },
    {
      source: 'asset.py',
      target: '../outside',
      kind: 'file',
    },
    {
      source: 'escape.py',
      target: 'server/resource.py',
      kind: 'file',
    },
  ]) {
    await assert.rejects(copyResources(source, path.join(root, 'stage'), {
      schema: 1,
      entries: [entry],
    }));
  }
});

test('SEA-LAYOUT-03: непосредственные runtime-импорты объявлены production dependencies', async () => {
  const specifiers = await runtimeSpecifiers(SOURCE, ['server/src', 'shared', 'cli']);
  const manifest = JSON.parse(await readFile(path.join(SOURCE, 'server/package.json'), 'utf8'));

  assert.ok(specifiers.includes('ws'));
  assertRuntimeDependencies(manifest, specifiers);
  assert.throws(() => assertRuntimeDependencies({ dependencies: {} }, ['fastify']), /fastify/);
});

test('SEA-LAYOUT-04: npm ci выполняется вложенным Node в отдельном staging с внешним cache', async (t) => {
  const root = await scratch(t);
  const stage = path.join(root, 'stage');
  const calls = [];
  const node = await put(stage, 'runtime/node/bin/node');

  await put(stage, 'runtime/node/lib/node_modules/npm/bin/npm-cli.js');
  await installDependencies({
    sourceRoot: SOURCE,
    stageRoot: stage,
    cacheDir: path.join(root, 'cache'),
    run: async (file, args, options) => {
      calls.push({
        file,
        args,
        options,
      });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, node);
  assert.ok(calls[0].args.includes('ci'));
  assert.ok(calls[0].args.includes('--omit=dev'));
  assert.ok(calls[0].args.includes('--prefer-offline'));

  const stagedManifest = JSON.parse(await readFile(path.join(stage, 'server/package.json'), 'utf8'));

  assert.deepEqual(stagedManifest.allowScripts, {
    'cpu-features@0.0.10': true,
    'ssh2@1.17.0': true,
  });
  assert.equal(calls[0].options.cwd, path.join(stage, 'server'));
  assert.equal(calls[0].options.env.npm_config_cache, path.join(root, 'cache'));
  assert.equal(calls[0].options.env.npm_config_nodedir, path.join(stage, 'runtime/node'));
  assert.equal(calls[0].options.env.npm_config_userconfig, '/dev/null');
  assert.equal(calls[0].options.env.PYTHONDONTWRITEBYTECODE, '1');
  assert.ok(calls[0].options.env.CXXFLAGS.includes(`-ffile-prefix-map=${stage}=/grigdesk-release`));
  assert.ok(calls[0].options.env.CFLAGS.includes('-g0'));
  await assert.rejects(installDependencies({
    sourceRoot: SOURCE,
    stageRoot: SOURCE,
    cacheDir: root,
  }), /staging/);
  await assert.rejects(installDependencies({
    sourceRoot: SOURCE,
    stageRoot: stage,
    cacheDir: path.join(stage, 'cache'),
  }), /cache.*staging/i);
});

test('REVIEW-P2: нормализация до manifest задаёт файлам 0644/0755, каталогам 0755', async (t) => {
  const root = await scratch(t);
  const executable = await put(root, 'bin/tool');
  const regular = await put(root, 'resources/plain.txt');

  await chmod(root, 0o770);
  await chmod(path.dirname(regular), 0o770);
  await chmod(executable, 0o775);
  await chmod(regular, 0o660);
  await symlink('../resources/plain.txt', path.join(root, 'bin/link'));
  await stage.normalizeStageModes(root);
  assert.equal((await stat(root)).mode & 0o777, 0o755);
  assert.equal((await stat(path.dirname(regular))).mode & 0o777, 0o755);
  assert.equal((await stat(regular)).mode & 0o777, 0o644);
  assert.equal((await stat(executable)).mode & 0o777, 0o755);
});

test('REVIEW-P3: из native build остаются загружаемые .node, обычный JS build сохранён', async (t) => {
  const root = await scratch(t);
  const build = 'server/node_modules/native/build';

  for (const file of ['config.gypi', 'Makefile', 'native.target.mk',
    'Release/obj.target/native.o', 'Release/.deps/native.o.d', 'Release/native.node']) {
    await put(root, `${build}/${file}`);
  }

  await put(root, 'server/node_modules/library/build/index.js');
  await dependencies.cleanNativeBuilds(root);
  assert.deepEqual(await readdir(path.join(root, build)), ['Release']);
  assert.deepEqual(await readdir(path.join(root, build, 'Release')), ['native.node']);
  assert.equal(await readFile(path.join(root, 'server/node_modules/library/build/index.js'), 'utf8'),
    'fixture');
});

test('REVIEW-P3: аудит видит пути сборки в npm-тексте и нативном binding', async (t) => {
  const root = await scratch(t);
  const options = {
    required: [],
    sourceRoot: '/fixture/checkout',
    forbiddenRoots: ['/fixture/cache'],
  };

  for (const [file, bytes] of [
    ['server/node_modules/library/build.txt', 'origin=/fixture/checkout/server'],
    ['server/node_modules/native/Release/binding.node', Buffer.from('\x7fELF\0/fixture/cache/build-home')],
  ]) {
    const written = await put(root, file, bytes);

    await assert.rejects(auditStage(root, options), /Абсолютный путь.*сборк|Абсолютный путь.*checkout/);
    await rm(written);
  }
});

test('REVIEW-P8: повреждённый cache заменяется проверенной локальной копией без .part', async (t) => {
  const root = await scratch(t);
  const cache = path.join(root, 'cache');
  const archive = 'node-v24.21.0-linux-x64.tar.xz';
  const bytes = 'fixture verified archive';

  await put(root, 'server/build/node-runtime.json', JSON.stringify({
    version: '24.21.0',
    platform: 'linux-x64',
    sha256: sha256(bytes),
  }));
  await put(root, `cache/${archive}`, 'broken');
  await put(root, `b24/.cache/${archive}`, 'broken');
  await put(root, `relay/.cache/${archive}`, bytes);

  const result = await build.cachedRuntime(cache, root);

  assert.equal(await readFile(result, 'utf8'), bytes);
  assert.deepEqual(await readdir(cache), [archive]);
  await put(root, `relay/.cache/${archive}`, 'broken');
  assert.equal(await build.cachedRuntime(cache, root), result);
  await put(root, `cache/${archive}`, 'previous bytes');
  await assert.rejects(build.cachedRuntime(cache, root), /проверенного архива/);
  assert.equal(await readFile(result, 'utf8'), 'previous bytes');
  assert.deepEqual(await readdir(cache), [archive]);
});

test('SEA-LAYOUT-05: аудит считает файлы и mode, проверяет helper/dependency, различает npm и свой код',
  async (t) => {
    const root = await scratch(t);
    const executable = await put(root, 'server/grigdesk-server');

    await chmod(executable, 0o755);
    await put(root, 'runtime/node/bin/node');
    await put(root, 'server/runtime/helpers/probe.mjs', 'export const result = true;');
    await put(root, 'server/node_modules/library/package.json', '{"name":"library","version":"1"}');
    await put(root, 'server/node_modules/library/src/main.ts', 'export const value = 1;');
    await put(root, 'server/node_modules/library/lib/profiles/fixture/entry.js', 'export const value = 1;');
    await symlink('library/src/main.ts', path.join(root, 'server/node_modules/internal-link'));

    const options = { required: [
      'server/grigdesk-server', 'runtime/node/bin/node', 'server/runtime/helpers/probe.mjs',
      'server/node_modules/library/package.json',
    ] };
    const files = await auditStage(root, options);

    assert.equal(files.find((file) => file.path === 'server/grigdesk-server').mode, 0o755);
    assert.match(files[0].sha256, /^[a-f0-9]{64}$/);
    assert.equal(files.find((file) => file.path.endsWith('internal-link')).type, 'symlink');
    assert.ok(files.some((file) =>
      file.path === 'server/node_modules/library/lib/profiles/fixture/entry.js'));
    await assert.rejects(auditStage(root, { required: ['server/runtime/helpers/missing.mjs'] }), /missing/);

    const forbidden = [
      '.env', 'server/src/leak.ts', 'server/runtime/helpers/probe.mjs.map', 'profiles/fixture',
    ];

    for (const relative of forbidden) {
      await put(root, relative);
      await assert.rejects(auditStage(root, options), /Запрещ|исходник|sourcemap|состав/);
      await rm(path.join(root, relative));
    }

    await symlink('/etc/passwd', path.join(root, 'outside'));
    await assert.rejects(auditStage(root, options), /ссылк/);
  });


test('HELP-LICENSE: дополнительные пакеты сайта требуют полного текста лицензии', async (t) => {
  const root = await scratch(t);
  const extra = path.join(root, 'help-fixture');

  await put(root, 'runtime/node/LICENSE', 'Node fixture license');
  await mkdir(path.join(root, 'server/node_modules'), { recursive: true });
  await put(extra, 'package.json', JSON.stringify({
    name: 'help-fixture',
    version: '1.0.0',
    license: 'MIT',
  }));
  await put(extra, 'LICENSE', 'Полный текст лицензии fixture');

  const index = await collectLicenses(root, { extraPackages: [extra, extra] });

  assert.equal(index.packages.length, 1);
  assert.equal(index.packages[0].name, 'help-fixture');
  assert.equal(await readFile(path.join(root, index.packages[0].files[0]), 'utf8'),
    'Полный текст лицензии fixture');
  await rm(path.join(extra, 'LICENSE'));
  await assert.rejects(collectLicenses(root, { extraPackages: [extra] }), /Нет текста лицензии/);
});
