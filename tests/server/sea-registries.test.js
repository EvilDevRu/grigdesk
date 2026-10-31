import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createEngineRegistry } from '../../server/src/lib/db/engineRegistry.ts';
import {
  engineEntries,
  executorEntries,
  writeRegistryTables,
} from '../../server/scripts/sea/registries.mts';

const require = createRequire(new URL('../../server/package.json', import.meta.url));
const { build } = require('esbuild');
const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

/**
 * Временная фикстура с каталогами исполнителей и движков БД.
 * Уборка удаляет только собственный каталог теста.
 */
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-sea-registries-'));
  const executorsDir = path.join(root, 'server/src/lib/executors');
  const enginesDir = path.join(root, 'server/src/lib/db/engines');

  await mkdir(executorsDir, {
    recursive: true
  });
  await mkdir(enginesDir, {
    recursive: true
  });
  t.after(() => rm(root, {
    recursive: true,
    force: true
  }));

  return {
    root,
    executorsDir,
    enginesDir
  };
}

/**
 * Пишет файл фикстуры с созданием каталогов.
 */
async function put(root, file, text) {
  const target = path.join(root, file);

  await mkdir(path.dirname(target), {
    recursive: true
  });
  await writeFile(target, text);
}

/**
 * Заполняет каталоги тремя исполнителями и двумя валидными движками БД.
 * Один исполнитель setup-only, один вспомогательный файл на `_` — оба важны для правил.
 */
async function fill(fixtureTree) {
  const { root, executorsDir, enginesDir } = fixtureTree;

  await put(executorsDir, 'alpha.ts', [
    'export default {',
    "  id: 'alpha', name: 'Alpha', order: 20, type: 'universal',",
    '  capabilities: { stream: true },',
    '  probe() {}, auth() {},',
    '  async run() { return { ok: true }; },',
    '};',
    '',
  ].join('\n'));
  await put(executorsDir, 'beta.ts', [
    'export default {',
    "  id: 'beta', name: 'Beta', order: 10, type: 'setup',",
    '  capabilities: { stream: false },',
    '  probe() {}, auth() {},',
    '};',
    '',
  ].join('\n'));
  await put(executorsDir, '_helper.ts', 'export const helper = true;\n');
  await put(executorsDir, 'index.ts', 'export const registry = true;\n');
  await put(enginesDir, 'mysql.ts', engineSource('mysql', 'MySQL'));
  await put(enginesDir, 'redis.ts', engineSource('redis', 'Redis'));
  await put(root, 'marker.txt', 'фикстура');
}

/**
 * Исходный текст валидного self-describing движка БД.
 */
function engineSource(id, label) {
  return [
    'export default {',
    `  id: '${id}', label: '${label}',`,
    '  capabilities: { schema: true },',
    '  open() {}, close() {}, schema() {}, analyze() {}, inspectRights() {},',
    '  estimate() {}, execute() {}, cancel() {},',
    '};',
    '',
  ].join('\n');
}

/**
 * Собирает фикстуру esbuild и возвращает экспорт `load`.
 * Литеральные импорты сгенерированной таблицы реально попадают в бандл.
 */
async function bundleCheck(root, entry, outfile) {
  const output = path.join(root, outfile);

  await build({
    entryPoints: [path.join(root, entry)],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    logLevel: 'silent',
  });

  const module = await import(`${pathToFileURL(output).href}?t=${Date.now()}`);

  return module;
}

test('SEA-REG-01: генератор повторяет правила сканирования и не берёт лишнее', async (t) => {
  const tree = await fixture(t);

  await fill(tree);

  assert.deepEqual(executorEntries(tree.executorsDir).map((entry) => entry.name),
    ['alpha', 'beta']);
  assert.deepEqual(engineEntries(tree.enginesDir).map((entry) => entry.name),
    ['mysql.ts', 'redis.ts']);

  const tables = await writeRegistryTables({
    executorsDir: tree.executorsDir,
    enginesDir: tree.enginesDir,
  });
  const executorTable = await readFile(tables.executorTable, 'utf8');
  const engineTable = await readFile(tables.engineTable, 'utf8');

  assert.match(executorTable, /import\("\.\/alpha\.ts"\)/);
  assert.match(executorTable, /import\("\.\/beta\.ts"\)/);
  assert.doesNotMatch(executorTable, /_helper|index\.ts/);
  assert.match(engineTable, /import\("\.\/engines\/mysql\.ts"\)/);
  assert.match(engineTable, /import\("\.\/engines\/redis\.ts"\)/);
});

test('SEA-REG-02: собранная таблица даёт те же id, порядок и capabilities', async (t) => {
  const tree = await fixture(t);

  await fill(tree);
  await writeRegistryTables({
    executorsDir: tree.executorsDir,
    enginesDir: tree.enginesDir,
  });

  const source = [];

  for (const entry of executorEntries(tree.executorsDir)) {
    const module = await import(pathToFileURL(entry.file).href);
    const adapter = module.default;

    source.push({
      id: adapter.id,
      order: adapter.order,
      name: adapter.name,
      capabilities: adapter.capabilities,
    });
  }

  await put(tree.root, 'server/src/lib/executors/check.ts', [
    "import { executorLoaders } from './registryTable.ts';",
    '',
    'export async function load() {',
    '  return Promise.all(executorLoaders().map(async (loader) => ({',
    '    name: loader.name,',
    '    adapter: (await loader.load()).default,',
    '  })));',
    '}',
    '',
  ].join('\n'));

  const built = await bundleCheck(tree.root, 'server/src/lib/executors/check.ts', 'executors.mjs');
  const adapters = await built.load();

  assert.deepEqual(adapters.map(({ adapter }) => ({
    id: adapter.id,
    order: adapter.order,
    name: adapter.name,
    capabilities: adapter.capabilities,
  })).sort((left, right) => left.order - right.order),
  source.sort((left, right) => left.order - right.order));

  await put(tree.root, 'server/src/lib/db/check.ts', [
    "import { dbEngineLoaders } from './engineTable.ts';",
    '',
    'export async function load() {',
    '  return dbEngineLoaders();',
    '}',
    '',
  ].join('\n'));

  const engines = await bundleCheck(tree.root, 'server/src/lib/db/check.ts', 'engines.mjs');
  const loaders = await engines.load();
  const registry = await createEngineRegistry({
    loaders
  });

  assert.deepEqual((await registry.list()).map((engine) => engine.id), ['mysql', 'redis']);
});

test('SEA-REG-03: новый адаптер включается следующей генерацией без правки ядра', async (t) => {
  const tree = await fixture(t);

  await fill(tree);
  await writeRegistryTables({
    executorsDir: tree.executorsDir,
    enginesDir: tree.enginesDir,
  });

  await put(tree.executorsDir, 'gamma.ts', [
    'export default {',
    "  id: 'gamma', name: 'Gamma', order: 5, type: 'universal',",
    '  probe() {}, auth() {}, async run() {}',
    '};',
    '',
  ].join('\n'));
  await put(tree.enginesDir, 'clickhouse.ts', engineSource('clickhouse', 'ClickHouse'));

  const tables = await writeRegistryTables({
    executorsDir: tree.executorsDir,
    enginesDir: tree.enginesDir,
  });
  const executorTable = await readFile(tables.executorTable, 'utf8');

  assert.match(executorTable, /import\("\.\/gamma\.ts"\)/);
  assert.match(await readFile(tables.engineTable, 'utf8'), /import\("\.\/engines\/clickhouse\.ts"\)/);
  assert.deepEqual(executorEntries(tree.executorsDir).map((entry) => entry.name),
    ['alpha', 'beta', 'gamma']);
});

test('SEA-REG-04: пара .js/.ts и неверный DB SPI дают прежние ошибки', async (t) => {
  const tree = await fixture(t);

  await fill(tree);
  await put(tree.executorsDir, 'alpha.js', 'export default {};\n');

  assert.throws(() => executorEntries(tree.executorsDir), /объявлен дважды/);
  await assert.rejects(writeRegistryTables({
    executorsDir: tree.executorsDir,
    enginesDir: tree.enginesDir,
  }), /объявлен дважды/);

  await rm(path.join(tree.executorsDir, 'alpha.js'));

  await put(tree.enginesDir, 'bad.ts', [
    'export default {',
    "  id: 'bad', label: 'Bad', capabilities: {},",
    '  open() {},',
    '};',
    '',
  ].join('\n'));
  await writeRegistryTables({
    executorsDir: tree.executorsDir,
    enginesDir: tree.enginesDir,
  });
  await put(tree.root, 'server/src/lib/db/check.ts', [
    "import { dbEngineLoaders } from './engineTable.ts';",
    'export async function load() { return dbEngineLoaders(); }',
    '',
  ].join('\n'));

  const built = await bundleCheck(tree.root, 'server/src/lib/db/check.ts', 'bad-engines.mjs');
  const loaders = await built.load();

  await assert.rejects(createEngineRegistry({
    loaders
  }), /DB SPI/);
});

test('SEA-REG-05: настоящие каталоги дают тот же состав, что реестры', async () => {
  const executorsDir = path.join(ROOT, 'server/src/lib/executors');
  const enginesDir = path.join(ROOT, 'server/src/lib/db/engines');
  const executors = executorEntries(executorsDir);

  assert.ok(executors.length >= 4);
  assert.equal(new Set(executors.map((entry) => entry.name)).size, executors.length);

  const ids = [];

  for (const entry of executors) {
    const module = await import(pathToFileURL(entry.file).href);
    const adapter = module.default;

    if (adapter?.id && typeof adapter.probe === 'function' && typeof adapter.auth === 'function') {
      ids.push(adapter.id);
    }
  }

  const { getProviderAdapters } = await import('../../server/src/lib/executors/index.ts');
  const actual = [...(await getProviderAdapters()).keys()].sort();

  assert.deepEqual([...ids].sort(), actual);

  const engines = engineEntries(enginesDir);

  assert.deepEqual(engines.map((entry) => entry.name).sort(),
    ['clickhouse.ts', 'mysql.ts', 'redis.ts']);

  const registry = await createEngineRegistry();

  assert.deepEqual((await registry.list()).map((engine) => engine.id).sort(),
    ['clickhouse', 'mysql', 'redis']);
});

/**
 * CJS использует штатные context/moduleUrls plugins и generated builtin table.
 * Внешний пакет остаётся в папке данных и импортируется настоящим ESM bridge.
 */
async function externalCjsFixture(t, bridge = true) {
  const { writeEngine, adapterSource } = await import('./helpers/dbEngineFixture.js');

  const { createRuntimeContextPlugin } = await import('../../server/scripts/sea/context.mts');

  const { createModuleUrlsPlugin } = await import('../../server/scripts/sea/moduleUrls.mts');

  const tree = await fixture(t);

  await fill(tree);

  const tables = await writeRegistryTables({ executorsDir: tree.executorsDir, enginesDir: tree.enginesDir });

  const R = path.join(tree.root, 'R with space');

  const externalDir = path.join(tree.root, 'data/db-engines');

  await mkdir(path.join(R, 'server/runtime'), { recursive: true });

  await writeFile(path.join(R, 'server/package.json'), '{"type":"module"}');

  if (bridge) {
    await writeFile(path.join(R, 'server/runtime/esmBridge.cjs'),
      await readFile(path.join(ROOT, 'server/build/esmBridge.cjs')));
  }

  const dir = await writeEngine(externalDir, 'fixture-db', {}, adapterSource('fixture-db', `
    import { value } from './relative.mjs';
    import dependency from 'fixture-local-dependency';
    const answer = await Promise.resolve(value + dependency);
  `).replace('return [{ answer: 42 }]', 'return [{ answer }]'));

  await writeFile(path.join(dir, 'relative.mjs'), 'export const value = 40;');

  await mkdir(path.join(dir, 'node_modules/fixture-local-dependency'), { recursive: true });

  await writeFile(path.join(dir, 'node_modules/fixture-local-dependency/package.json'),
    '{"name":"fixture-local-dependency","main":"index.mjs","type":"module"}');

  await writeFile(path.join(dir, 'node_modules/fixture-local-dependency/index.mjs'), 'export default 2;');

  const entry = path.join(tree.root, 'entry.mts');

  const registryUrl = path.join(ROOT, 'server/src/lib/db/engineRegistry.ts');

  await writeFile(entry, `
    import { createEngineRegistry } from ${JSON.stringify(registryUrl)};
    export const load = () => createEngineRegistry({
      externalDir: ${JSON.stringify(externalDir)}, grigDeskVersion: '1.0.0',
      runtime: { kind: 'packaged', root: ${JSON.stringify(R)} },
    });
  `);

  const urls = createModuleUrlsPlugin({
    root: ROOT,
    runtimeModule: path.join(ROOT, 'server/src/lib/runtimePaths.ts'),
    skip: [entry, ...engineEntries(tree.enginesDir).map((item) => item.file)],
  });

  const output = path.join(tree.root, 'registry.cjs');

  const table = await readFile(tables.engineTable, 'utf8');

  const result = await build({
    entryPoints: [entry],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    logLevel: 'silent',
    plugins: [{
      name: 'fixture-generated-builtins',
      setup(builder) {
        builder.onLoad({ filter: /engineTable\.ts$/ }, () => ({
          contents: table,
          loader: 'ts',
          resolveDir: path.dirname(tables.engineTable),
        }));
      },
    }, createRuntimeContextPlugin(ROOT, 'sea'), urls.plugin],
  });

  assert.deepEqual(result.warnings, []);

  return { registry: await require(output).load(), table };
}

test('SEA-DB-01: CJS+bridge объединяет builtin/external с relative/TLA/npm', async (t) => {
  const { registry, table } = await externalCjsFixture(t);

  assert.deepEqual((await registry.list()).map((engine) => engine.id).sort(),
    ['fixture-db', 'mysql', 'redis']);

  assert.doesNotMatch(table, /fixture-db|db-engines/u);

  const adapter = registry.get('fixture-db');

  assert.deepEqual(await adapter.execute({}, { text: 'SELECT 42' }), [{ answer: 42 }]);
});

test('SEA-DB-01: missing bridge оставляет builtin и безопасную diagnostic внешнего', async (t) => {
  const { registry } = await externalCjsFixture(t, false);

  assert.deepEqual((await registry.list()).map((engine) => engine.id).sort(), ['mysql', 'redis']);

  const errors = typeof registry.errors === 'function' ? await registry.errors() : registry.errors;

  assert.ok(Array.isArray(errors) && errors.some((error) => error.id === 'fixture-db'));

  assert.equal(registry.get('fixture-db'), null);
});
