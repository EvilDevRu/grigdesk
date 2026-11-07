import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { createGlmAdapter } from '../../server/src/lib/executors/glm.ts';
import { getExecutors } from '../../server/src/lib/executors/index.ts';
import { getModelsRegistry } from '../../server/src/lib/modelsRegistry.ts';
import { buildGlmRoute, glmCompatibilityIdentity } from '../../server/src/lib/glm/contract.ts';
import { parseGlmCatalog } from '../../server/src/lib/glm/catalog.ts';
import { describeGlmGeneration } from '../../server/src/lib/glm/generation.ts';
import { GLM_FIXTURE_PLUGIN, writeGlmArtifactFixture } from '../helpers/glmArtifactFixture.mts';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const FAKE_ACP = path.join(REPO_ROOT, 'tests/fixtures/deepseek-harness/fakeAcp.mts');
const pair = (model) => JSON.stringify(['zai', model]);

function modelOption(current = 'glm-5.3') {
  return {
    id: 'model',
    category: 'model',
    currentValue: pair(current),
    options: [{
      group: 'zai',
      name: 'zai',
      options: ['glm-4.7', 'glm-5.2', 'glm-5.3'].map((model) => ({ value: pair(model), name: model })),
    }],
  };
}

function effortOption(values) {
  return {
    id: 'reasoning_effort',
    category: 'thought_level',
    currentValue: '',
    options: values.map((value) => ({ value, name: value || 'Provider default' })),
  };
}

const PER_MODEL = {
  [pair('glm-4.7')]: [modelOption('glm-4.7'), effortOption(['', 'high'])],
  [pair('glm-5.2')]: [modelOption('glm-5.2'), effortOption(['', 'off', 'high', 'max'])],
  [pair('glm-5.3')]: [modelOption('glm-5.3'), effortOption(['', 'low', 'high', 'max'])],
};

/**
 * Стенд каталога: generation-фикстура, чей entry запускает фейковый ACP со сценарием.
 * Счётчик запусков показывает, что недопущенный каталог процесса не трогает.
 */
async function fixture(t, env = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'glm-catalog-'));
  const scenarioFile = path.join(root, 'scenario.json');
  const logFile = path.join(root, 'fake.ndjson');
  const artifact = path.join(root, 'generation');
  const spawned = [];

  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(logFile, '');
  await fs.writeFile(scenarioFile, JSON.stringify({
    configOptions: [modelOption(), effortOption(['', 'low', 'high', 'max'])],
    configByModel: PER_MODEL,
  }));
  await writeGlmArtifactFixture(artifact, {
    llmPiAi: GLM_FIXTURE_PLUGIN,
    entry: [
      'if (process.argv[2] === "-V") { console.log("0.1.5-rc.2"); process.exit(0); }',
      `process.argv.push("--scenario", ${JSON.stringify(scenarioFile)},`
        + ` "--log", ${JSON.stringify(logFile)});`,
      `await import(${JSON.stringify(pathToFileURL(FAKE_ACP).href)});`,
      '',
    ].join('\n'),
  });

  const config = {
    rootDir: root,
    deepseekBin: path.join(artifact, 'deepseek'),
    deepseekRuntimeMode: 'binary',
    glmRuntimeHome: path.join(root, 'glm-home'),
  };
  const identity = glmCompatibilityIdentity(describeGlmGeneration(config).runtime, 'api');
  const adapter = (overrides = {}) => createGlmAdapter({
    env: {
      PATH: process.env.PATH,
      GRIGDESK_GLM_API_MODE: 'api',
      ZAI_API_KEY: 'synthetic-zai-key',
      ...env,
    },
    admission: [{ mode: 'api', compatibility: identity }],
    spawn: (...args) => {
      spawned.push(args);

      return spawn(...args);
    },
    ...overrides,
  });

  return {
    root,
    config,
    identity,
    spawned,
    adapter,
    log: async () => (await fs.readFile(logFile, 'utf8')).split('\n').filter(Boolean).map(JSON.parse),
  };
}

test('каталог содержит только маршрут zai, id модели — пара ["zai", модель]', async (t) => {
  const f = await fixture(t);
  const models = await f.adapter().catalog(f.config);
  const methods = (await f.log()).map((entry) => entry.message?.method ?? entry.method).filter(Boolean);

  assert.deepEqual(models.map((model) => model.id), [pair('glm-4.7'), pair('glm-5.2'), pair('glm-5.3')]);
  assert.ok(models.every((model) => JSON.parse(model.id)[0] === 'zai'));
  assert.equal(methods.includes('session/prompt'), false);
  assert.equal(f.spawned.length, 1);

  const foreign = parseGlmCatalog([{
    id: 'model',
    options: [{ value: '["deepseek-official","deepseek-v4-flash"]' }, { value: pair('glm-5.3') }],
  }], {});

  assert.deepEqual(foreign.map((model) => model.id), [pair('glm-5.3')]);
});

test('efforts модели — прочитанный список; из одного значения — пустой', () => {
  const models = parseGlmCatalog([modelOption()], PER_MODEL);
  const byId = Object.fromEntries(models.map((model) => [model.id, model.efforts]));

  assert.deepEqual(byId, {
    [pair('glm-4.7')]: [],
    [pair('glm-5.2')]: ['off', 'high', 'max'],
    [pair('glm-5.3')]: ['low', 'high', 'max'],
  });
  // ACP не публикует семейств: общее семейство краткий список прочёл бы как версии одной модели.
  assert.equal(models.some((model) => 'family' in model), false);
});

test('glm-4.7 и glm-5-turbo без выбора уровня', () => {
  for (const mode of ['api', 'coding-plan']) {
    const overrides = buildGlmRoute(mode).modelOverrides;

    for (const model of ['glm-4.7', 'glm-5-turbo']) {
      assert.deepEqual(overrides?.[model], { reasoningEfforts: { high: 'high' } }, `${mode} ${model}`);
    }

    assert.deepEqual(Object.keys(overrides).sort(), ['glm-4.7', 'glm-5-turbo']);
  }
});

test('недопущенный режим или нет ключа — catalog() null без процесса', async (t) => {
  const f = await fixture(t);

  assert.equal(await f.adapter({ admission: [] }).catalog(f.config), null);
  assert.equal(await f.adapter({ env: { PATH: process.env.PATH, GRIGDESK_GLM_API_MODE: 'api' } })
    .catalog(f.config), null);
  assert.equal(await f.adapter({ admission: [{ mode: 'api', compatibility: 'other' }] }).catalog(f.config),
    null);
  assert.equal(f.spawned.length, 0);
});

test('catalogCacheKey меняется от identity, режима и ключа', async (t) => {
  const f = await fixture(t);
  const base = await f.adapter().catalogCacheKey(f.config);
  const keys = [
    await f.adapter({
      env: {
        PATH: process.env.PATH,
        GRIGDESK_GLM_API_MODE: 'api',
        ZAI_API_KEY: 'other-key',
      },
    }).catalogCacheKey(f.config),
    await f.adapter({
      env: {
        PATH: process.env.PATH,
        GRIGDESK_GLM_API_MODE: 'coding-plan',
        ZAI_CODING_API_KEY: 'synthetic-zai-key',
      },
    }).catalogCacheKey(f.config),
  ];
  const otherArtifact = path.join(f.root, 'generation-2');

  await writeGlmArtifactFixture(otherArtifact, {
    llmPiAi: { ...GLM_FIXTURE_PLUGIN, sourceHash: 'b'.repeat(64) },
  });
  keys.push(await f.adapter().catalogCacheKey({
    ...f.config, deepseekBin: path.join(otherArtifact, 'deepseek'),
  }));

  assert.equal(new Set([base, ...keys]).size, 4);
  assert.equal([base, ...keys].some((key) => key.includes('synthetic-zai-key')), false);
});

test('реестр моделей берёт efforts модели из каталога GLM', async (t) => {
  const f = await fixture(t);
  const executors = await getExecutors();
  const original = new Map(executors);

  t.after(() => {
    executors.clear();

    for (const [id, executor] of original) {
      executors.set(id, executor);
    }
  });
  executors.clear();
  executors.set('glm', f.adapter());

  const registry = await getModelsRegistry({
    ...f.config,
    modelsPath: path.join(f.root, 'models.json'),
  }, { refresh: true });
  const byId = Object.fromEntries(registry.glm.map((model) => [model.id, model.efforts]));

  assert.deepEqual(byId[pair('glm-5.3')], ['low', 'high', 'max']);
  assert.deepEqual(byId[pair('glm-5.2')], ['off', 'high', 'max']);
  assert.deepEqual(byId[pair('glm-4.7')], []);
});
