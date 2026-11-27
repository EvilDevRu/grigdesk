import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { cliJson, settingsFixture, writeStageMetadataScope } from '../helpers/stageRunnerSettingsFixture.mjs';
import { codexModelFixture } from '../helpers/factoryStageModelMetadata.mjs';
import { runtimeInfoFixture } from '../helpers/deepseekMetadataFixture.mts';
import { writeDeepSeekBinaryStub } from '../helpers/deepseekBinaryStub.mts';
import { GLM_FACTORY_MODELS } from '../../server/src/lib/glm/factoryCatalog.ts';
import { describeGlmGeneration } from '../../server/src/lib/glm/generation.ts';
import { glmCompatibilityIdentity } from '../../server/src/lib/glm/contract.ts';

// К1/К6: native усилия пересекаются с каталогом раннера, registry чата не участвует.
test('metadata-only-per-model-options', async (t) => {
  const fx = await codexModelFixture(t);
  const options = cliJson(fx.cli('options', ['--provider', 'codex']));
  const expected = fx.native.map((model) => ({
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

test('helper отвергает лишнее поле descriptor до получения reader lease', async (t) => {
  const fx = await codexModelFixture(t);
  const helper = fileURLToPath(new URL('../../server/scripts/factoryRunnerModels.mts', import.meta.url));
  const descriptor = {
    executable: fx.binary,
    executableIdentity: 'a'.repeat(64),
    resourceKey: 'b'.repeat(64),
    providerId: 'codex',
    leaseDirectory: path.join(fx.root, 'lease'),
    unexpected: true,
  };
  const response = spawnSync(process.execPath, [helper, 'codex', '--native', fx.binary,
    JSON.stringify(descriptor)], {
    env: fx.env,
    encoding: 'utf8',
    timeout: 10_000,
  });

  assert.equal(response.status, 4, response.stderr);
  assert.match(response.stderr, /лишнее поле descriptor CLI/);
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

  await writeFile(path.join(fx.root, 'kimi'), '#!/usr/bin/env bash\necho "kimi 1.0.0"\n', { mode: 0o700 });
  await writeFile(fx.config, [
    'RUNNERS_SCHEMA=1', 'CONFIG_REVISION=1', 'RUNNERS_COVERAGE=required',
    'PROJECT_RUNNER_PRIMARY=kimi', 'PROJECT_RUNNER_FAILOVER=', '',
  ].join('\n'));
  fx.env.GRIGDESK_KIMI_BIN = path.join(fx.root, 'kimi');

  const expected = ['kimi-code/k3', 'kimi-code/k3-256k', 'kimi-code/kimi-for-coding',
    'kimi-code/kimi-for-coding-highspeed'];
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
  await writeFile(fx.config, [
    'RUNNERS_SCHEMA=1', 'CONFIG_REVISION=1', 'RUNNERS_COVERAGE=required',
    'PROJECT_RUNNER_PRIMARY=glm', 'PROJECT_RUNNER_FAILOVER=',
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

  const options = cliJson(fx.cli('options', ['--provider', 'glm']));

  assert.deepEqual(options.models.map(({ id, efforts }) => ({ id, efforts })),
    GLM_FACTORY_MODELS.map(({ id, efforts }) => ({ id, efforts: [...efforts] })));

  fx.env.GRIGDESK_GLM_API_MODE = 'unconfirmed';

  const rejected = fx.cli('options', ['--provider', 'glm']);

  assert.equal(rejected.status, 69);
  assert.match(rejected.stderr, /metadata_unavailable/);
});

test('скорость фабрики подтверждается отдельно для каждой модели Codex', async (t) => {
  const fx = await codexModelFixture(t);
  const [sol, terra] = structuredClone(fx.native);
  const env = Object.fromEntries(['PATH', 'HOME', 'CODEX_HOME', 'GRIGDESK_HOME', 'TMPDIR', 'LANG']
    .filter((key) => fx.env[key] !== undefined).map((key) => [key, fx.env[key]]));
  const scope = await writeStageMetadataScope(fx, { codex: { executable: fx.binary } }, env);

  sol.serviceTiers = [{ id: 'priority' }];
  terra.serviceTiers = [{ id: 'experimental-label', name: 'Fast' }, { id: 'ultrafast' }];
  await writeFile(fx.metadataFile, JSON.stringify({ data: [sol, terra], nextCursor: null }));

  const speed = ['--speed-v1', '1'];
  const legacy = cliJson(fx.cli('options', ['--provider', 'codex']));

  assert.equal(Object.hasOwn(legacy.models[0], 'speedModes'), false);

  const before = cliJson(fx.cli('options', ['--provider', 'codex', ...speed]));

  assert.deepEqual(before.models.find((item) => item.id === sol.id)?.speedModes, ['standard', 'fast']);
  assert.deepEqual(before.models.find((item) => item.id === terra.id)?.speedModes, ['standard', 'ultrafast']);

  sol.serviceTiers = [];
  await writeFile(fx.metadataFile, JSON.stringify({ data: [sol, terra], nextCursor: null }));

  const after = cliJson(fx.cli('options', ['--provider', 'codex', ...speed]));

  assert.deepEqual(after.models.find((item) => item.id === sol.id)?.speedModes, ['standard']);
  assert.notEqual(after.catalogRevision, before.catalogRevision);

  await unlink(scope);

  const unscoped = cliJson(fx.cli('options', ['--provider', 'codex', ...speed]));

  assert.deepEqual(unscoped.models.find((item) => item.id === terra.id)?.speedModes, ['standard']);
  assert.notEqual(unscoped.catalogRevision, after.catalogRevision);

  const methods = await fx.methods();

  assert.equal(methods.some((method) => /^(thread|turn)\//.test(method)), false);
});

test('настройка скорости сохраняется с CAS и явным сбросом в профиль', async (t) => {
  const fx = await codexModelFixture(t);
  const [first, ...rest] = structuredClone(fx.native);
  const env = Object.fromEntries(['PATH', 'HOME', 'CODEX_HOME', 'GRIGDESK_HOME', 'TMPDIR', 'LANG']
    .filter((key) => fx.env[key] !== undefined).map((key) => [key, fx.env[key]]));

  await writeStageMetadataScope(fx, { codex: { executable: fx.binary } }, env);
  first.serviceTiers = [{ id: 'priority' }];
  await writeFile(fx.metadataFile, JSON.stringify({ data: [first, ...rest], nextCursor: null }));

  const speed = ['--speed-v1', '1'];
  const options = () => cliJson(fx.cli('options', ['--provider', 'codex', ...speed]));
  const legacyView = cliJson(fx.cli('options', ['--provider', 'codex']));

  assert.equal(Object.hasOwn(legacyView.sources, 'speed'), false);
  assert.equal(Object.hasOwn(legacyView.inherited, 'speed'), false);
  assert.equal(Object.hasOwn(legacyView.models[0], 'speedModes'), false);
  assert.equal(Object.hasOwn(legacyView.selection, 'speed'), false);
  assert.equal(Object.hasOwn(legacyView.actual ?? {}, 'speed'), false);

  const base = options();

  assert.equal(base.sources.speed, 'profile');

  const payload = {
    identity: base.identity,
    expectedRevision: base.revision,
    expectedRun: null,
    catalogRevision: base.catalogRevision,
    requestId: 'speed-first',
    mode: 'next',
    selection: { ...base.selection, speed: 'fast' },
  };
  const apply = (input) => fx.cli('apply', ['--payload', JSON.stringify(input), ...speed]);
  const unflagged = fx.cli('apply', ['--payload', JSON.stringify(payload)]);

  assert.notEqual(unflagged.status, 0);
  assert.match(unflagged.stderr, /settings_input/u);

  const saved = cliJson(apply(payload));

  assert.equal(saved.revision, base.revision + 1);
  assert.equal(saved.selection.speed, 'fast');
  assert.equal(saved.effective.speed, 'fast');
  assert.equal(cliJson(fx.cli('show', speed)).selection.speed, 'fast');
  assert.equal(cliJson(apply(payload)).revision, saved.revision);
  assert.match(apply({ ...payload, selection: { ...payload.selection, speed: 'standard' } }).stderr,
    /request_conflict/u);

  const { speed: savedSpeed, ...legacy } = payload.selection;
  const byLegacy = cliJson(apply({
    ...payload,
    expectedRevision: saved.revision,
    requestId: 'speed-legacy',
    selection: legacy,
  }));

  assert.equal(byLegacy.selection.speed, savedSpeed);

  const rejected = apply({
    ...payload,
    expectedRevision: byLegacy.revision,
    requestId: 'speed-rejected',
    selection: { ...payload.selection, speed: 'ultrafast' },
  });

  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /speed_unavailable/u);
  assert.equal(cliJson(fx.cli('show', speed)).revision, byLegacy.revision);

  const reset = cliJson(apply({
    ...payload,
    expectedRevision: byLegacy.revision,
    requestId: 'speed-reset',
    selection: { ...payload.selection, speed: null },
  }));

  assert.equal(reset.selection.speed ?? null, null);
  assert.equal(reset.effective.speed ?? null, null);

  const raw = await readFile(path.join(fx.controlDir, 'protocol-v2', 'tasks', `t${fx.task}`,
    'attempts', fx.attempt, 'runner-settings', 'plan.json'), 'utf8');

  assert.equal(raw.includes('"speed"'), false);

  const kept = cliJson(apply({
    ...payload,
    expectedRevision: reset.revision,
    requestId: 'speed-kept',
  }));
  const oldServer = fx.cli('apply', ['--payload', JSON.stringify({
    ...payload,
    expectedRevision: kept.revision,
    requestId: 'speed-old-server',
    selection: {
      ...legacy,
      model: 'gpt-9.1-sol',
      effort: 'low',
    },
  })]);

  assert.equal(oldServer.status, 0, oldServer.stderr);
  assert.equal(Object.hasOwn(JSON.parse(oldServer.stdout).selection, 'speed'), false);
  assert.equal(cliJson(fx.cli('show', speed)).selection.speed, 'fast');

  await writeFile(fx.config, (await readFile(fx.config, 'utf8')) + 'MODEL_DEFAULT_CODEX_SPEED=standard\n');

  const fromProfile = cliJson(fx.cli('options', ['--provider', 'codex', ...speed]));

  assert.equal(fromProfile.inherited.speed, 'standard');
  assert.equal(fromProfile.sources.speed, 'node');
});
