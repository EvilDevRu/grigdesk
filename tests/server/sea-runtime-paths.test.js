import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  createRuntimePaths,
  helperCommand,
  helperCommandFor,
  helperModule,
  helperModuleFor,
  helperRootFromUrl,
  moduleUrl,
  moduleUrlFor,
  nodeExecutable,
  nodeExecutableFor,
  packagedRootFromExecPath,
  readHelperCatalog,
  runtimeKind,
  runtimeRoot,
} from '../../server/src/lib/runtimePaths.ts';
import { createRuntimeContextPlugin } from '../../server/scripts/sea/context.mts';
import { createModuleUrlsPlugin } from '../../server/scripts/sea/moduleUrls.mts';

const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const require = createRequire(new URL('../../server/package.json', import.meta.url));
const { build } = require('esbuild');

/**
 * Временная папка одного сценария; уборка привязана к тесту.
 * Путь с пробелом используется там, где проверяется перенос комплекта.
 */
async function scratch(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-runtime-paths-'));

  t.after(() => rm(root, {
    recursive: true,
    force: true
  }));

  return root;
}

/**
 * Создаёт минимальный layout комплекта: бинарник сервера и вложенный Node.
 * Содержимое файлов неважно, важны пути и права на запуск.
 */
async function packagedLayout(t) {
  const R = path.join(await scratch(t), 'R with space');

  await mkdir(path.join(R, 'server'), {
    recursive: true
  });
  await mkdir(path.join(R, 'runtime/node/bin'), {
    recursive: true
  });
  await mkdir(path.join(R, 'server/runtime/helpers'), {
    recursive: true
  });
  await writeFile(path.join(R, 'server/grigdesk-server'), 'бинарник');
  await writeFile(path.join(R, 'runtime/node/bin/node'), 'node');
  await chmod(path.join(R, 'runtime/node/bin/node'), 0o755);

  return R;
}

/**
 * Каталог helper-ов для чистых проверок команды.
 * Один вход достаточен: выбор режима проверяется отдельно.
 */
function catalog() {
  return {
    schema: 1,
    helpers: [{
      id: 'data-home-check',
      entry: 'server/scripts/dataHomeCheck.mts',
      description: 'проверка data-home',
    }],
  };
}

test('SEA-RP-01: source-режим считает пути от корня дерева, а не от cwd', async (t) => {
  const root = path.join(await scratch(t), 'дерево с пробелом');
  const foreign = await scratch(t);
  const paths = createRuntimePaths({
    mode: 'source',
    root,
    execPath: '/usr/bin/node',
  });

  assert.equal(paths.kind, 'source');
  assert.equal(paths.mode, 'source');
  assert.equal(paths.root, root);
  assert.equal(paths.node, '/usr/bin/node');
  assert.equal(
    moduleUrlFor(paths, 'server/src/app.ts').href,
    pathToFileURL(path.join(root, 'server/src/app.ts')).href,
  );

  assert.deepEqual(helperCommandFor(paths, catalog(), 'data-home-check', ['--code-root', root]), {
    command: '/usr/bin/node',
    args: [path.join(root, 'server/scripts/dataHomeCheck.mts'), '--code-root', root],
  });
  assert.throws(() => helperCommandFor(paths, catalog(), 'nope', []), /Неизвестный helper: nope/);

  const script = [
    `import { createRuntimePaths } from ${JSON.stringify(
      pathToFileURL(path.join(ROOT, 'server/src/lib/runtimePaths.ts')).href,
    )};`,
    `const paths = createRuntimePaths({ mode: 'source', root: ${JSON.stringify(root)},`,
    "  execPath: '/usr/bin/node' });",
    "process.stdout.write(JSON.stringify({ root: paths.root, node: paths.node }));",
  ].join('\n');
  const child = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: foreign,
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin' },
  });

  assert.deepEqual(JSON.parse(child), { root, node: '/usr/bin/node' });
});

test('SEA-RP-02: SEA-режим вычисляет R от физического execPath', async (t) => {
  const R = await packagedLayout(t);
  const binary = path.join(R, 'server/grigdesk-server');
  const paths = createRuntimePaths({
    mode: 'sea',
    execPath: binary,
  });

  assert.equal(paths.kind, 'packaged');
  assert.equal(paths.root, R);
  assert.equal(paths.node, path.join(R, 'runtime/node/bin/node'));
  assert.equal(nodeExecutableFor(paths), path.join(R, 'runtime/node/bin/node'));
  assert.equal(
    moduleUrlFor(paths, 'server/src/app.ts').href,
    pathToFileURL(path.join(R, 'server/src/app.ts')).href,
  );
  assert.deepEqual(helperCommandFor(paths, catalog(), 'data-home-check', ['x']), {
    command: path.join(R, 'runtime/node/bin/node'),
    args: [path.join(R, 'server/runtime/helpers/data-home-check.mjs'), 'x'],
  });

  const linkDirectory = await scratch(t);
  const link = path.join(linkDirectory, 'запуск');

  await symlink(binary, link);

  assert.equal(packagedRootFromExecPath(link), R);
  assert.equal(createRuntimePaths({
    mode: 'sea',
    execPath: link
  }).root, R);
  assert.throws(() => packagedRootFromExecPath('server/grigdesk-server'), /абсолютный execPath/);
});

test('SEA-RP-03: packaged-helper вычисляет R от своего .mjs URL', async (t) => {
  const R = await packagedLayout(t);
  const helper = path.join(R, 'server/runtime/helpers/showcase-worker.mjs');

  await writeFile(helper, '// helper');

  const paths = createRuntimePaths({
    mode: 'helper',
    helperUrl: pathToFileURL(helper).href,
  });

  assert.equal(helperRootFromUrl(pathToFileURL(helper).href), R);
  assert.equal(paths.kind, 'packaged');
  assert.equal(paths.root, R);
  assert.equal(paths.node, path.join(R, 'runtime/node/bin/node'));
  assert.deepEqual(helperCommandFor(paths, catalog(), 'data-home-check', []), {
    command: path.join(R, 'runtime/node/bin/node'),
    args: [path.join(R, 'server/runtime/helpers/data-home-check.mjs')],
  });
});

test('SEA-RP-04: нет вложенного Node — отказ с путём, без PATH и исходников', async (t) => {
  const R = await packagedLayout(t);

  await rm(path.join(R, 'runtime'), {
    recursive: true,
    force: true
  });

  const paths = createRuntimePaths({
    mode: 'sea',
    execPath: path.join(R, 'server/grigdesk-server'),
  });

  assert.throws(() => nodeExecutableFor(paths), (error) => {
    assert.match(error.message, /Повреждён комплект/);
    assert.ok(error.message.includes(path.join(R, 'runtime/node/bin/node')));
    assert.doesNotMatch(error.message, /PATH/);

    return true;
  });

  // Корень и ресурсы продолжают вычисляться: отсутствие Node не подменяет режим.
  assert.equal(moduleUrlFor(paths, 'VERSION').href, pathToFileURL(path.join(R, 'VERSION')).href);
});

test('SEA-RP-05: moduleUrl не выпускает за корень', async (t) => {
  const paths = createRuntimePaths({
    mode: 'source',
    root: await scratch(t),
    execPath: '/usr/bin/node',
  });

  for (const value of ['', '../сосед.ts', '/etc/passwd']) {
    assert.throws(() => moduleUrlFor(paths, value), /moduleUrl/);
  }

  assert.equal(moduleUrlFor(paths, '.').href, pathToFileURL(paths.root).href);
});

test('SEA-RP-06: каталог helper-ов проверяет схему и уникальность', async (t) => {
  const directory = await scratch(t);
  const file = path.join(directory, 'helpers.json');

  await writeFile(file, JSON.stringify(catalog()));
  assert.deepEqual(readHelperCatalog(file), catalog());

  for (const broken of [
    { schema: 2, helpers: catalog().helpers },
    { schema: 1, helpers: [] },
    { schema: 1, helpers: [catalog().helpers[0], catalog().helpers[0]] },
    {
      schema: 1,
      helpers: [{
        id: 'Плохой id',
        entry: 'server/x.mjs',
        description: 'x',
      }],
    },
    {
      schema: 1,
      helpers: [{
        id: 'ok',
        entry: '../x.mjs',
        description: 'x',
      }],
    },
  ]) {
    await writeFile(file, JSON.stringify(broken));
    assert.throws(() => readHelperCatalog(file), /helper/);
  }

  assert.throws(() => readHelperCatalog(path.join(directory, 'нет.json')), /Нет каталога helper-ов/);
});

test('SEA-RP-07: адаптер исходников находит каталог helper-ов и корень', () => {
  assert.equal(runtimeKind(), 'source');
  assert.equal(runtimeRoot(), ROOT);
  assert.equal(nodeExecutable(), process.execPath);
  assert.equal(moduleUrl('server/src/app.ts').href, pathToFileURL(path.join(ROOT, 'server/src/app.ts')).href);
  assert.deepEqual(helperCommand('data-home-check', ['--help']), {
    command: process.execPath,
    args: [path.join(ROOT, 'server/scripts/dataHomeCheck.mts'), '--help'],
  });
  assert.throws(() => helperCommand('nope', []), /Неизвестный helper: nope/);
});

test('SEA-RP-08: вычисления не создают файлов и не читают .env', async (t) => {
  const directory = await scratch(t);
  const paths = createRuntimePaths({
    mode: 'source',
    root: directory,
    execPath: '/usr/bin/node',
  });

  moduleUrlFor(paths, 'server/src/app.ts');
  nodeExecutableFor(paths);
  helperCommandFor(paths, catalog(), 'data-home-check', []);

  assert.deepEqual(await readdir(directory), []);
  assert.equal(existsSync(path.join(directory, '.env')), false);
});

/**
 * Настоящие плагины сборки сохраняют fallback внешнего ELF после переноса в R.
 * Factory получает обычный Node комплекта, не бинарник SEA и не embedded generation.
 */
test('SEA-RP-09: packaged DeepSeek выбирает внешний ELF и обычный Node без source-контракта', async (t) => {
  const R = await packagedLayout(t);
  const dataHome = await scratch(t);
  const outfile = path.join(R, 'server/runtime/helpers/deepseek-paths.mjs');
  const urls = createModuleUrlsPlugin({
    root: ROOT,
    runtimeModule: path.join(ROOT, 'server/src/lib/runtimePaths.ts'),
  });
  const result = await build({
    stdin: {
      contents: [
        'import { config } from "./server/src/config.ts";',
        'import { routeLaunchEnv } from "./server/src/lib/factoryRouteCli.ts";',
        'import { selectedDeepSeekBinary } from "./server/src/lib/deepseek/distribution.ts";',
        'const env = routeLaunchEnv(config);',
        'process.stdout.write(JSON.stringify({',
        '  selected: selectedDeepSeekBinary({}), mode: config.deepseekRuntimeMode,',
        '  node: env.GRIGDESK_DEEPSEEK_NODE_BIN, binary: env.GRIGDESK_DEEPSEEK_BIN,',
        '}));',
      ].join('\n'),
      resolveDir: ROOT,
      loader: 'ts',
    },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    plugins: [createRuntimeContextPlugin(ROOT, 'helper'), urls.plugin],
    logLevel: 'silent',
  });

  assert.deepEqual(result.warnings, []);
  assert.equal(existsSync(path.join(R, 'server/deepseek-runtime-contract.json')), false);

  const output = execFileSync(process.execPath, [outfile], {
    env: {
      PATH: '',
      HOME: dataHome,
      GRIGDESK_HOME: dataHome,
    },
    encoding: 'utf8',
  });

  assert.deepEqual(JSON.parse(output), {
    selected: path.join(R, 'bin/deepseek'),
    mode: 'binary',
    node: path.join(R, 'runtime/node/bin/node'),
    binary: path.join(R, 'bin/deepseek'),
  });
});

test('SB05: payload root не выводится из execPath ordinary Node', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'server-payload-paths-'));
  const R = path.join(base, 'D/runtimes/server/packages', 'a'.repeat(64));
  const binary = path.join(base, 'installation with space/bin/grigdesk-server');

  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(path.join(R, 'server'), { recursive: true });
  await mkdir(path.dirname(binary), { recursive: true });
  await writeFile(path.join(R, 'server/payload.cjs'), 'module.exports = {};');
  await writeFile(binary, 'ELF');

  let value;

  assert.doesNotThrow(() => {
    value = createRuntimePaths({
      mode: 'payload',
      bundleFile: path.join(R, 'server/payload.cjs'),
      binary,
    });
  });

  assert.equal(value.kind, 'packaged');
  assert.equal(value.root, R);
  assert.equal(value.node, path.join(R, 'runtime/node/bin/node'));
  assert.equal(value.installationBin, path.dirname(binary));
});

test('SB05: helper сохраняет R и получает I только из явного physical binary', async (t) => {
  const R = await packagedLayout(t);
  const helper = path.join(R, 'server/runtime/helpers/paths.mjs');
  const installation = await scratch(t);
  const binary = path.join(installation, 'bin/grigdesk-server');

  await writeFile(helper, '// helper');
  await mkdir(path.dirname(binary));
  await writeFile(binary, 'ELF');

  const context = {
    mode: 'helper',
    helperUrl: pathToFileURL(helper).href,
  };
  const legacy = createRuntimePaths(context);
  const payload = createRuntimePaths({ ...context, binary });

  assert.equal(legacy.installationRoot, R);
  assert.equal(legacy.installationBin, path.join(R, 'bin'));
  assert.equal(payload.root, R);
  assert.equal(payload.installationRoot, installation);
  assert.equal(payload.installationBin, path.dirname(binary));
  assert.throws(() => createRuntimePaths({ ...context, binary: 'relative' }), /абсолютный/);
  assert.throws(() => createRuntimePaths({
    mode: 'payload',
    bundleFile: 'relative',
    binary,
  }), /абсолютные/);
});

test('SEA-RP-10: library-helper отдаёт файл модуля для импорта чужим процессом', async (t) => {
  const R = await packagedLayout(t);
  const libraries = {
    schema: 1,
    helpers: [{
      id: 'routes-publish-kit',
      entry: 'server/src/modules/routes/publishKit.ts',
      entryKind: 'library',
      description: 'набор публикации',
    }, {
      id: 'data-home-check',
      entry: 'server/scripts/dataHomeCheck.mts',
      entryKind: 'script',
      description: 'проверка data-home',
    }],
  };
  const source = createRuntimePaths({
    mode: 'source',
    root: ROOT,
    execPath: '/usr/bin/node',
  });
  const packaged = createRuntimePaths({
    mode: 'sea',
    execPath: path.join(R, 'server/grigdesk-server'),
  });

  assert.equal(helperModuleFor(source, libraries, 'routes-publish-kit'),
    path.join(ROOT, 'server/src/modules/routes/publishKit.ts'));
  assert.equal(helperModuleFor(packaged, libraries, 'routes-publish-kit'),
    path.join(R, 'server/runtime/helpers/routes-publish-kit.mjs'));
  assert.throws(() => helperModuleFor(source, libraries, 'nope'), /Неизвестный helper: nope/);
  assert.throws(() => helperModuleFor(source, libraries, 'data-home-check'),
    /Helper data-home-check не библиотека/);

  // Настоящий каталог дерева: модуль существует и отдаёт ровно пять имён для профилей.
  const file = helperModule('routes-publish-kit');
  const kit = await import(pathToFileURL(file).href);

  assert.equal(file, path.join(ROOT, 'server/src/modules/routes/publishKit.ts'));
  assert.deepEqual(Object.keys(kit).sort(), [
    'RoutesStore',
    'validateBootstrap',
    'validateCatalog',
    'validatePromptFiles',
    'validateRoute',
  ]);
});
