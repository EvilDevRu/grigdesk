import assert from 'node:assert/strict';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { cliJson, settingsFixture, sourceRoot } from '../helpers/stageRunnerSettingsFixture.mjs';
import { codexModelFixture } from '../helpers/factoryStageModelMetadata.mjs';
import { runtimeInfoFixture } from '../helpers/deepseekMetadataFixture.mts';
import { writeDeepSeekBinaryStub } from '../helpers/deepseekBinaryStub.mts';
import { GLM_FACTORY_MODELS } from '../../server/src/lib/glm/factoryCatalog.ts';
import { describeGlmGeneration } from '../../server/src/lib/glm/generation.ts';
import { glmCompatibilityIdentity } from '../../server/src/lib/glm/contract.ts';

// К1/К6: native усилия пересекаются с каталогом раннера, registry чата не участвует.
test('metadata-only-per-model-options', async (t) => {
  const fx = await codexModelFixture(t);
  const ready = fx.shell([
    'runner_registry_load "$FACTORY_RUNNERS_DIR"',
    'runner_call codex probe && runner_call codex catalog',
  ].join('\n'));

  assert.equal(ready.status, 0, ready.stderr);

  const options = cliJson(fx.cli('options', ['--provider', 'codex']));
  const expected = fx.native.slice(0, 2).map((model) => ({
    id: model.id, efforts: model.supportedReasoningEfforts.map((item) => item.reasoningEffort),
  }));

  assert.deepEqual(options.models.map(({ id, efforts }) => ({ id, efforts })), expected);

  const registry = await readFile(path.join(fx.env.GRIGDESK_HOME, 'models.json'), 'utf8');

  assert.equal(registry, 'sentinel-owner-registry');
  assert.ok((await fx.methods()).includes('model/list'));
  assert.equal((await fx.methods()).some((method) => /^(thread|turn)\//.test(method)), false);
});

test('metadata-unavailable-does-not-reuse-chat-or-seed', async (t) => {
  const fx = await codexModelFixture(t);

  await writeFile(fx.metadataFile, JSON.stringify({ data: [], nextCursor: null }));

  const response = fx.cli('options', ['--provider', 'codex']);

  assert.notEqual(response.status, 0);
  assert.match(`${response.stdout} ${response.stderr}`, /unavailable|недоступ/i);

  const registry = await readFile(path.join(fx.env.GRIGDESK_HOME, 'models.json'), 'utf8');

  assert.equal(registry, 'sentinel-owner-registry');
});

test('metadata-revision-changes-with-model-capabilities', async (t) => {
  const fx = await codexModelFixture(t);
  const first = cliJson(fx.cli('options', ['--provider', 'codex']));
  const native = structuredClone(fx.native);

  native[0].supportedReasoningEfforts = [{ reasoningEffort: 'low' }];
  await writeFile(fx.metadataFile, JSON.stringify({ data: native, nextCursor: null }));

  const next = cliJson(fx.cli('options', ['--provider', 'codex']));

  assert.notEqual(next.catalogRevision, first.catalogRevision);
  assert.deepEqual(next.models.find((model) => model.id === native[0].id).efforts, ['low']);
});

test('kimi-options-use-only-runner-models-and-accepted-efforts', async (t) => {
  const fx = await settingsFixture(t);

  await copyFile(path.join(sourceRoot, 'engine/lib/runners/kimi.sh'),
    path.join(fx.env.FACTORY_RUNNERS_DIR, 'kimi.sh'));
  await writeFile(path.join(fx.root, 'kimi'), '#!/usr/bin/env bash\necho "kimi 1.0.0"\n', { mode: 0o700 });
  fx.env.PATH = `${fx.root}:${fx.env.PATH}`;
  fx.env.FACTORY_FORBID_LIVE = '0';

  const catalog = fx.shell('source "$FACTORY_HOME/lib/runners/kimi.sh"\nrunner_kimi_catalog');

  assert.equal(catalog.status, 0);

  const expected = catalog.stdout.trim().split('\n').map((line) => line.split('\t')[0]);
  const options = cliJson(fx.cli('options', ['--provider', 'kimi']));

  assert.deepEqual(options.models.map((model) => model.id), expected);
  assert.ok(options.models.every((model) => JSON.stringify(model.efforts) === '["low","high","max"]'));
});

// К1/К6: opaque GLM modelRef и уровни берутся из Factory-каталога допускаемого DSH.
test('glm-options-use-factory-catalog-and-runtime-admission', async (t) => {
  const fx = await settingsFixture(t);
  const metadataFile = path.join(fx.root, 'glm-runtime.json');
  const metadata = runtimeInfoFixture();
  const { binary } = await writeDeepSeekBinaryStub(t, [
    'if (!process.argv.includes("--runtime-info")) throw new Error("model call forbidden");',
    `process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(metadataFile)}, "utf8"));`,
  ].join('\n'));

  await writeFile(metadataFile, JSON.stringify(metadata));

  const config = {
    deepseekRuntimeMode: 'binary',
    deepseekBin: binary,
    deepseekCacheDir: path.join(fx.root, 'dsh-cache'),
  };
  const generation = describeGlmGeneration(config);

  metadata.glm.admission = [{
    mode: 'api',
    compatibility: glmCompatibilityIdentity(generation.runtime, 'api'),
  }];
  await writeFile(metadataFile, JSON.stringify(metadata));
  await copyFile(path.join(sourceRoot, 'engine/lib/runners/glm.sh'),
    path.join(fx.env.FACTORY_RUNNERS_DIR, 'glm.sh'));
  await writeFile(fx.config, [
    'RUNNERS_SCHEMA=1', 'CONFIG_REVISION=1', 'PROJECT_RUNNER_PRIMARY=glm', 'PROJECT_RUNNER_FAILOVER=',
    'MODEL_DEFAULT_GLM_FAMILY=default', 'MODEL_DEFAULT_GLM_EFFORT=high', '',
  ].join('\n'));
  Object.assign(fx.env, {
    FACTORY_FORBID_LIVE: '0',
    GRIGDESK_DEEPSEEK_BIN: binary,
    GRIGDESK_DEEPSEEK_RUNTIME_MODE: 'binary',
    GRIGDESK_DEEPSEEK_NODE_BIN: process.execPath,
    GRIGDESK_DEEPSEEK_CACHE_DIR: config.deepseekCacheDir,
    GRIGDESK_GLM_API_MODE: 'api',
  });

  const ready = fx.shell('source "$FACTORY_HOME/lib/runners/glm.sh"\nrunner_glm_probe');

  assert.equal(ready.status, 0, ready.stderr);

  const options = cliJson(fx.cli('options', ['--provider', 'glm']));

  assert.deepEqual(options.models.map(({ id, efforts }) => ({ id, efforts })),
    GLM_FACTORY_MODELS.map(({ id, efforts }) => ({ id, efforts: [...efforts] })));

  fx.env.GRIGDESK_GLM_API_MODE = 'unconfirmed';

  const rejected = fx.cli('options', ['--provider', 'glm']);

  assert.notEqual(rejected.status, 0);
  assert.match(`${rejected.stdout} ${rejected.stderr}`, /mode|режим|admi|допуск/i);
});
