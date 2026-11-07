import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { build } from '../../server/node_modules/esbuild/lib/main.js';
import { deepSeekChatPort, deepSeekFactoryPort, glmDeps, loadCompiledApi }
  from './binary/drivers/providerPorts.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');

test('SB25-GRAPH: driver загружает production только из runtime CJS', async () => {
  const result = await build({
    absWorkingDir: ROOT,
    entryPoints: [path.join(ROOT, 'tests/server/binary/drivers/chat.mts')],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    packages: 'external',
    metafile: true,
    logLevel: 'silent',
  });
  const forbidden = Object.keys(result.metafile.inputs).filter((file) =>
    /(?:^|\/)(?:server\/(?:src|scripts)|deepseek\/src)\//u.test(file.replaceAll('\\', '/')));

  assert.deepEqual(forbidden, [], 'Driver не должен включать production source');
  assert.equal(Object.values(result.metafile.outputs).some((output) => output.imports.some((item) =>
    item.external && (item.path.startsWith('.') || path.isAbsolute(item.path)))), false);
});

test('SB25-PORTS: tiny CJS spies подтверждают startServer, prepareLaunch и GLM identity', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'server-driver-ports-'));
  const bundle = path.join(root, 'payload.cjs');
  const overlayPath = path.join(root, 'original.yml');
  const runtime = { kind: 'binary', metadata: { packageId: 'a'.repeat(64) } };
  const config = { deepseekCacheDir: path.join(root, 'cache') };
  const apiNames = ['runDeepSeekWebTurn', 'startDeepSeekServer', 'runDeepSeekTurn',
    'prepareDeepSeekLaunch', 'createGlmAdapter', 'runGlmTurn', 'glmCompatibilityIdentity',
    'runDeepSeekFactory', 'runGlmFactory'];

  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(overlayPath, '# original production overlay\n');
  await writeFile(bundle, [
    'exports.loadPackagedVerification = async (binary) => {',
    '  const calls = [];',
    `  const api = Object.fromEntries(${JSON.stringify(apiNames)}.map((name) =>`,
    '    [name, (...args) => { calls.push({ name, args }); return args[0]; }]));',
    '  api.calls = calls;',
    `  api.prepareDeepSeekLaunch = async (input) => { calls.push({ name: 'prepareDeepSeekLaunch' });`,
    `    return { overlayPath: ${JSON.stringify(overlayPath)}, opaque: 'same-handle' }; };`,
    '  api.runDeepSeekTurn = async (input) => input.deps.prepareLaunch(input);',
    '  return api;',
    '};',
  ].join('\n'));

  const api = await loadCompiledApi(bundle, '/I/bin/grigdesk-server');
  const web = await deepSeekChatPort(api, config, 'http://127.0.0.1:1')({ runtime, overlayPath });
  const factory = await deepSeekFactoryPort(api, 'http://127.0.0.1:1')({ config, runtime });
  const inputs = { llmPiAi: 'synthetic-plugin-identity' };
  const deps = glmDeps(api, { glm: { inputs } }, 'http://127.0.0.1:1', '/guard', {}, 'fixture-model');

  assert.equal(api.calls[0].name, 'startDeepSeekServer');
  assert.equal(web.overlayPath, path.join(root, 'combined.yml'));
  assert.equal(api.calls[1].name, 'prepareDeepSeekLaunch');
  assert.equal(factory.opaque, 'same-handle');
  assert.equal(api.calls[2].name, 'glmCompatibilityIdentity');
  assert.deepEqual(api.calls[2].args, [inputs, 'api']);
  assert.equal(deps.modelEndpoint, 'http://127.0.0.1:1');
});

test('SB25-EXPORTS: отсутствующие и неверные compiled exports отказывают до модели', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'server-driver-missing-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  for (const [index, source] of [
    'exports.loadPackagedVerification = async () => ({});',
    'exports.loadPackagedVerification = 17;',
  ].entries()) {
    const bundle = path.join(root, `missing-${index}.cjs`);

    await mkdir(root, { recursive: true });
    await writeFile(bundle, source);
    await assert.rejects(loadCompiledApi(bundle, '/I/bin/grigdesk-server'), { code: 'ERR_ASSERTION' });
  }
});
