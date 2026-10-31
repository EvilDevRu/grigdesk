import assert from 'node:assert/strict';
import { lstat, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function registryModule() {
  try {
    return await import('../../server/src/lib/db/engineRegistry.ts');
  } catch (error) {
    assert.fail(`сканируемый реестр движков БД ещё не реализован: ${error.message}`);
  }
}

test('реестр подхватывает новый движок из одного файла без правки ядра', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-db-engine-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const enginePath = path.join(root, 'fourth-engine.mjs');
  const source = `
    export default {
      id: 'fourth',
      label: 'Четвёртая СУБД',
      capabilities: { schema: true, readOnly: true },
      open() {}, close() {}, schema() {}, analyze() {}, inspectRights() {},
      estimate() {}, execute() {}, cancel() {},
    };
  `;
  await import('node:fs/promises').then(({ writeFile }) => writeFile(enginePath, source));
  const module = await registryModule();
  const create = module.createEngineRegistry || module.default;
  const registry = await create({ dir: root });
  const engines = await registry.list();

  assert.deepEqual(engines.map((engine) => ({
    id: engine.id,
    label: engine.label,
    capabilities: engine.capabilities,
  })), [{
    id: 'fourth',
    label: 'Четвёртая СУБД',
    capabilities: { schema: true, readOnly: true },
  }]);
});

test('поставка содержит self-describing движки MySQL ClickHouse и Redis', async () => {
  const module = await registryModule();
  const create = module.createEngineRegistry || module.default;
  const registry = await create();
  const engines = await registry.list();

  assert.deepEqual(
    engines.map((engine) => engine.id).sort(),
    ['clickhouse', 'mysql', 'redis'],
  );
});


/**
 * Builtin loader остаётся строгим даже после появления мягкой внешней загрузки.
 * Здесь используются существующие loaders, поэтому барьер зелёный на исходнике.
 */
function builtinAdapter(id = 'builtin') {
  return {
    id,
    label: 'Встроенный',
    capabilities: { schema: true },
    open() { },
    close() { },
    schema() { },
    analyze() { },
    inspectRights() { },
    estimate() { },
    execute() { },
    cancel() { },
  };
}

test('DB-BASE-STRICT: invalid и duplicate builtin сохраняют строгий отказ', async () => {
  const { createEngineRegistry } = await registryModule();

  const adapter = builtinAdapter();

  const loader = { name: 'builtin', load: async () => ({ default: adapter }) };

  await assert.rejects(createEngineRegistry({ loaders: [loader, loader] }), /дважды/u);

  await assert.rejects(createEngineRegistry({
    loaders: [{
      name: 'invalid',
      load: async () => ({ default: { ...adapter, execute: null } }),
    }]
  }), /DB SPI/u);
});

test('DER-01: общий list объединяет builtin и manifest внешнего драйвера', async (t) => {
  const { engineTree, writeEngine } = await import('./helpers/dbEngineFixture.js');

  const externalDir = await engineTree(t);

  await writeEngine(externalDir);

  const { createEngineRegistry } = await registryModule();

  const registry = await createEngineRegistry({ externalDir, grigDeskVersion: '1.0.0' });

  const ids = (await registry.list()).map((engine) => engine.id).sort();

  assert.deepEqual(ids, ['clickhouse', 'fixture-db', 'mysql', 'redis']);

  assert.equal(registry.get('fixture-db').id, 'fixture-db');
});

test('DER-02: коллизия builtin отклоняется с warning до импорта entry', async (t) => {
  const { engineTree, writeEngine, adapterSource } = await import('./helpers/dbEngineFixture.js');

  const externalDir = await engineTree(t);

  const marker = path.join(externalDir, 'imported');

  const prefix = `import { writeFileSync } from 'node:fs';
    writeFileSync(${JSON.stringify(marker)}, 'bad');`;

  await writeEngine(externalDir, 'builtin', {}, adapterSource('builtin', prefix));

  const warnings = [];

  const adapter = builtinAdapter();

  const { createEngineRegistry } = await registryModule();

  const registry = await createEngineRegistry({
    loaders: [{ name: 'builtin', load: async () => ({ default: adapter }) }],
    externalDir,
    grigDeskVersion: '1.0.0',
    log: { warn: (...args) => warnings.push(args), error: (...args) => warnings.push(args) },
  });

  assert.equal(registry.get('builtin'), adapter);

  assert.equal(await lstat(marker).catch(() => null), null);

  assert.ok(warnings.length > 0, 'коллизия должна оставлять запись в журнале');

  assert.deepEqual((await registry.list()).map((engine) => engine.capabilities), [{ schema: true }]);
});

for (const defect of [
  'missing-manifest', 'broken-manifest', 'kind', 'api', 'minimum', 'id', 'entry',
  'missing-method', 'throw-import', 'cycle', 'bigint', 'function', 'symlink',
]) {
  test(`DER-03: ${defect} изолируется, хороший сосед остаётся доступен`, async (t) => {
    const { engineTree, writeEngine, adapterSource } = await import('./helpers/dbEngineFixture.js');

    const externalDir = await engineTree(t);

    const patches = {
      kind: { kind: 'plugin' },
      api: { api: 2 },
      minimum: { minimum: '99.0.0' },
      id: { id: 'wrong-id' },
      entry: { entry: 'missing.mjs' },
    };

    let source = adapterSource('broken');

    if (defect === 'missing-method') {
      source = source.replace('async cancel()', 'async notCancel()');
    }

    if (defect === 'throw-import') {
      source = `throw new Error('PRIVATE_PASSWORD /private/path');`;
    }

    if (defect === 'cycle') {
      source = source.replace('{ schema: true, readOnly: true }',
        '(() => { const value = {}; value.self = value; return value; })()');
    }

    if (defect === 'bigint') {
      source = source.replace('{ schema: true, readOnly: true }', '{ value: 1n }');
    }

    if (defect === 'function') {
      source = source.replace('{ schema: true, readOnly: true }', '{ value() {} }');
    }

    const dir = await writeEngine(externalDir, 'broken', patches[defect] ?? {}, source);

    if (defect === 'missing-manifest') {
      await rm(path.join(dir, 'engine.json'));
    }

    if (defect === 'broken-manifest') {
      await writeFile(path.join(dir, 'engine.json'), '{broken');
    }

    if (defect === 'symlink') {
      await rm(path.join(dir, 'entry.mjs'));

      await symlink('../fixture-db/entry.mjs', path.join(dir, 'entry.mjs'));
    }

    await writeEngine(externalDir);

    const { createEngineRegistry } = await registryModule();

    const registry = await createEngineRegistry({ externalDir, grigDeskVersion: '1.0.0' });

    const ids = (await registry.list()).map((engine) => engine.id);

    assert.ok(ids.includes('fixture-db'), 'исправный внешний сосед должен загружаться');

    assert.ok(ids.includes('mysql'));

    assert.equal(registry.get('broken'), null);

    const errors = typeof registry.errors === 'function' ? await registry.errors() : registry.errors;

    assert.ok(Array.isArray(errors) && errors.some((error) => error.id === 'broken'));

    assert.doesNotMatch(JSON.stringify(errors), /PRIVATE_PASSWORD|private\/path|stack|file:\/\//u);

    assert.equal(JSON.stringify(errors).includes(externalDir), false);
  });
}
