import assert from 'node:assert/strict';
import {
  promises as fs
} from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import adapter from '../../server/src/lib/executors/gigacode.ts';
import {
  getExecutors
} from '../../server/src/lib/executors/index.ts';
import {
  getModelsRegistry
} from '../../server/src/lib/modelsRegistry.ts';
import {
  makeGigaCodeFixture,
  MODEL_A,
  MODEL_B
} from '../helpers/gigacode/fixture.mjs';

test('динамический каталог сохраняет opaque ids, переживает отказ и подтверждает удаление', async (
  t) => {
  const fixture = await makeGigaCodeFixture(t);
  const executors = await getExecutors();
  const original = new Map(executors);

  executors.clear();
  executors.set(adapter.id, adapter);
  t.after(() => {
    executors.clear();

    for (const [id, value] of original) {
      executors.set(id, value);
    }
  });

  const config = {
    ...fixture.config,
    modelsPath: path.join(fixture.root, 'models.json')
  };
  const refresh = () => getModelsRegistry(config, {
    refresh: true
  });
  const initial = await refresh();

  assert.deepEqual(initial.gigacode.map((model) => model.id), [MODEL_A, MODEL_B]);
  assert.deepEqual(initial.gigacode[0].efforts, []);

  const scenario = JSON.parse(await fs.readFile(fixture.scenarioFile, 'utf8'));
  const modelId = 'opaque/future model@company(gigacode)';

  scenario.session.models.availableModels.push({
    modelId,
    name: 'Неизвестное семейство'
  });
  await fs.writeFile(fixture.scenarioFile, JSON.stringify(scenario));

  const extended = await refresh();

  assert.ok(extended.gigacode.some((model) => model.id === modelId && model.name ===
    'Неизвестное семейство'));

  const keyBefore = await adapter.catalogCacheKey(config);

  await fs.rename(path.join(config.gigacodeHome, 'gigacode_token.json'),
    path.join(config.gigacodeHome, 'temporarily-unavailable'));

  const failed = await refresh();

  assert.deepEqual(failed.gigacode, extended.gigacode);
  assert.notEqual(await adapter.catalogCacheKey(config), keyBefore);
  scenario.session.models.availableModels = [];
  await fs.writeFile(fixture.scenarioFile, JSON.stringify(scenario));
  await fs.rename(path.join(config.gigacodeHome, 'temporarily-unavailable'),
    path.join(config.gigacodeHome, 'gigacode_token.json'));

  assert.deepEqual((await refresh()).gigacode, []);
});
