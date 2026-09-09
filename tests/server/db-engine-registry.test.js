import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-db-engine-'));
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
