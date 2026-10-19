import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

import {
  assertGlmGenerationAdmission,
  describeGlmGenerationAsync,
} from '../../server/src/lib/glm/generation.ts';
import { glmCompatibilityIdentity } from '../../server/src/lib/glm/contract.ts';
import { runtimeInfoFixture } from '../helpers/deepseekMetadataFixture.mts';
import { decodeDeepSeekRuntimeInfo } from '../../shared/chat/deepSeekBinary.ts';
import { createGlmAdapter } from '../../server/src/lib/executors/glm.ts';
import { ensureTestDeepSeekBinary } from '../helpers/deepseekBinary.mts';
import { startGlmLoopback } from '../helpers/glmLoopback.mts';
import { GLM_SERVICE_KEY, writeGlmEgressGuard } from '../helpers/glmProductionFixture.mts';

const exec = promisify(execFile);

test('GLM описывает binary из переданного descriptor metadata без чтения generation', async () => {
  const info = runtimeInfoFixture();
  const original = fs.readFile;
  let reads = 0;
  let generation;

  try {
    fs.readFile = async () => {
      reads += 1;

      throw new Error('У бинарной поставки сервер не читает файлы generation');
    };
    generation = await describeGlmGenerationAsync({}, {
      kind: 'binary',
      metadata: info,
      buildId: info.buildId,
      runtimeVersion: info.runtimeVersion,
      generationDir: null,
    });
  } finally {
    fs.readFile = original;
  }

  assert.equal(reads, 0);
  assert.equal(generation.buildId, info.buildId);
  assert.deepEqual(generation.runtime, info.glm.inputs);
  assert.equal(glmCompatibilityIdentity(generation.runtime, 'api'),
    glmCompatibilityIdentity(info.glm.inputs, 'api'));
});

test('допуск выпуска требует точные входы, ревизии и api; Coding Plan не включается metadata', async () => {
  const describe = (info) => describeGlmGenerationAsync({}, {
    kind: 'binary',
    metadata: info,
    generationDir: null,
  });
  const info = runtimeInfoFixture();
  const identity = glmCompatibilityIdentity(info.glm.inputs, 'api');

  info.glm.admission = [{ mode: 'api', compatibility: identity }];

  const generation = await describe(info);

  assert.equal(assertGlmGenerationAdmission(generation, 'api'), identity);

  for (const mutate of [
    (value) => {
      value.glm.admission = [];
    },
    (value) => {
      value.glm.admission[0].compatibility = 'f'.repeat(64);
    },
    (value) => {
      value.glm.profileRevision += '-changed';
    },
    (value) => {
      value.glm.policyRevision += '-changed';
    },
  ]) {
    const changed = structuredClone(info);

    mutate(changed);

    const invalid = await describe(changed);

    assert.throws(() => assertGlmGenerationAdmission(invalid, 'api'),
      (error) => ['glm_runtime_not_admitted', 'glm_runtime_incompatible'].includes(error.code));
  }

  const coding = structuredClone(info);
  const codingIdentity = glmCompatibilityIdentity(coding.glm.inputs, 'coding-plan');

  coding.glm.admission = [{ mode: 'coding-plan', compatibility: codingIdentity }];

  const closed = await describe(coding);

  assert.throws(() => assertGlmGenerationAdmission(closed, 'coding-plan'), { code: 'glm_mode_not_admitted' });
  assert.throws(() => assertGlmGenerationAdmission(closed, 'coding-plan', coding.glm.admission), {
    code: 'glm_mode_not_admitted',
  });
});

test('metadata допускает явное отсутствие GLM plugin, а GLM отказывает до запуска', async () => {
  const info = runtimeInfoFixture();

  info.glm.inputs.llmPiAi = null;
  assert.doesNotThrow(() => decodeDeepSeekRuntimeInfo(info));
  await assert.rejects(describeGlmGenerationAsync({}, {
    kind: 'binary',
    metadata: info,
    generationDir: null,
  }), { code: 'glm_plugin_missing' });

  info.glm.inputs.llmPiAi = {};
  assert.throws(() => decodeDeepSeekRuntimeInfo(info), { code: 'deepseek_metadata_invalid' });
});

test('сервер не пинит конкретную identity допуска в contract.ts', async () => {
  const source = await fs.readFile(new URL('../../server/src/lib/glm/contract.ts', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /['"][a-f0-9]{64}['"]/u);
});

test('без admission в deps способность run определяется серверным режимом, а не наличием бинарника', () => {
  const api = createGlmAdapter({
    env: { GRIGDESK_GLM_API_MODE: 'api', ZAI_API_KEY: 'synthetic-key' },
  });
  const coding = createGlmAdapter({
    env: { GRIGDESK_GLM_API_MODE: 'coding-plan', ZAI_CODING_API_KEY: 'synthetic-key' },
  });

  assert.equal(typeof api.run, 'function');
  assert.equal(coding.run, undefined);
});

test('GLM probe принимает настоящий ELF с точным test admission без legacy generation', {
  timeout: 900000,
}, async (t) => {
  const candidate = await ensureTestDeepSeekBinary();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'glm-binary-admission-'));

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const plugin = candidate.info.glm.inputs.llmPiAi;

  assert.ok(plugin);

  const identity = glmCompatibilityIdentity({ ...candidate.info.glm.inputs, llmPiAi: plugin }, 'api');
  const adapter = createGlmAdapter({
    env: { GRIGDESK_GLM_API_MODE: 'api', ZAI_API_KEY: 'synthetic-glm-key' },
    admission: [{ mode: 'api', compatibility: identity }],
  });
  const config = {
    deepseekRuntimeMode: 'binary',
    deepseekBin: candidate.binary,
    deepseekCacheDir: candidate.cacheDir,
    deepseekGenerationRoot: path.join(root, 'missing-legacy'),
    glmRuntimeHome: path.join(root, 'glm-home'),
  };
  const result = await adapter.probe(config);

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.packageId, candidate.info.packageId);
  assert.equal(adapter.distribution(config, result).managed, true);
  assert.ok((await adapter.catalogCacheKey(config)).includes(candidate.info.packageId));

  const override = await adapter.probe({
    ...config,
    deepseekRuntimeMode: 'embedded',
    deepseekBinOverride: candidate.binary,
  });

  assert.equal(override.ok, true, JSON.stringify(override));
  assert.equal(override.packageId, candidate.info.packageId);
  await assert.rejects(fs.access(config.deepseekGenerationRoot), { code: 'ENOENT' });
});

test('--verify настоящего ELF обнаруживает изменённый GLM plugin в собственном test cache', {
  timeout: 900000,
}, async (t) => {
  const candidate = await ensureTestDeepSeekBinary();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'glm-verify-plugin-'));
  const cache = path.join(root, 'cache');

  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.cp(candidate.cacheDir, cache, { recursive: true, verbatimSymlinks: true });

  const args = ['--cache-dir', cache, '--verify', '--json'];
  const options = {
    env: { PATH: '' },
    timeout: 120000,
    maxBuffer: 65536,
  };
  const verified = await exec(candidate.binary, args, options);

  assert.equal(JSON.parse(verified.stdout).verified, true);

  const plugin = path.join(cache, 'packages', candidate.info.packageId,
    'generation/packages/llm/llm-pi-ai/lib/index.js');
  const mode = (await fs.stat(plugin)).mode & 0o777;
  const original = await fs.readFile(plugin);

  await fs.chmod(plugin, 0o600);
  await fs.appendFile(plugin, '\n// изменённый тестовый plugin\n');
  await fs.chmod(plugin, mode);
  await assert.rejects(exec(candidate.binary, args, options), (error) => {
    assert.equal(error.stdout, '');
    assert.equal(error.code, 1);
    assert.deepEqual(JSON.parse(error.stderr), {
      code: 'deepseek_launcher_failed',
      message: 'Не удалось запустить DeepSeek',
    });

    return true;
  });

  await fs.chmod(plugin, 0o600);
  await fs.writeFile(plugin, original);
  await fs.chmod(plugin, mode);

  const restored = await exec(candidate.binary, args, options);

  assert.equal(JSON.parse(restored.stdout).verified, true);
});

test('GLM catalog/run выбирают настоящий binary, а чужой admission отказывает до model call', {
  timeout: 900000,
}, async (t) => {
  const candidate = await ensureTestDeepSeekBinary();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'glm-binary-run-'));
  const mock = await startGlmLoopback({
    expectedKey: GLM_SERVICE_KEY,
    respond: async () => ({ kind: 'stream', deltas: [{ role: 'assistant', content: 'glm-binary-ok' }] }),
  });

  t.after(async () => {
    await mock.stop();
    await fs.rm(root, { recursive: true, force: true });
  });

  const plugin = candidate.info.glm.inputs.llmPiAi;

  assert.ok(plugin);

  const identity = glmCompatibilityIdentity({ ...candidate.info.glm.inputs, llmPiAi: plugin }, 'api');
  const config = {
    deepseekRuntimeMode: 'binary',
    deepseekBin: candidate.binary,
    deepseekCacheDir: candidate.cacheDir,
    deepseekGenerationRoot: path.join(root, 'missing-legacy'),
    glmRuntimeHome: path.join(root, 'glm-home'),
  };
  const deps = {
    env: {
      PATH: process.env.PATH,
      GRIGDESK_GLM_API_MODE: 'api',
      ZAI_API_KEY: GLM_SERVICE_KEY,
      DEEPSEEK_API_KEY: 'foreign-deepseek-key',
    },
    admission: [{ mode: 'api', compatibility: identity }],
    modelEndpoint: mock.endpoint,
    egressGuard: await writeGlmEgressGuard(root),
  };
  const environments = [];

  deps.spawn = (command, args, options) => {
    environments.push(options.env);

    return spawn(command, args, options);
  };

  const input = {
    config,
    cwd: root,
    chatKey: 'admission-chat',
    message: 'Ответь через loopback.',
    model: '["zai","glm-5.3"]',
    onSessionCreated: async () => {},
    signal: AbortSignal.timeout(60000),
  };
  const wrong = createGlmAdapter({ ...deps, admission: [{ mode: 'api', compatibility: 'f'.repeat(64) }] });

  await assert.rejects(wrong.run(input), { code: 'glm_runtime_not_admitted' });
  assert.equal(mock.requests.length, 0);

  const catalog = await createGlmAdapter(deps).catalog(config);

  assert.ok(catalog?.some((entry) => entry.id === input.model));
  assert.equal(mock.requests.length, 0, 'Catalog не вызывает модель');

  const result = await createGlmAdapter({
    ...deps,
    catalog: [{ id: input.model, efforts: ['high'] }],
  }).run(input);

  assert.equal(result.reply, 'glm-binary-ok');
  assert.equal(mock.requests.length, 1);
  assert.equal(mock.requests[0].authorizationMatches, true);

  for (const env of environments) {
    assert.equal(env.DEEPSEEK_API_KEY, undefined);
    assert.equal(env.ZAI_API_KEY, undefined);
    assert.equal(env.GRIGDESK_GLM_ROUTE_KEY, GLM_SERVICE_KEY);
  }

  await assert.rejects(fs.access(config.deepseekGenerationRoot), { code: 'ENOENT' });
});

test('registry, загруженный без ELF, обнаруживает первую установку без пересоздания адаптера', {
  timeout: 900000,
}, async (t) => {
  const candidate = await ensureTestDeepSeekBinary();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'glm-binary-registry-'));

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const config = {
    deepseekRuntimeMode: 'binary',
    deepseekBin: path.join(root, 'installed-binary'),
    deepseekCacheDir: candidate.cacheDir,
    glmRuntimeHome: path.join(root, 'glm-home'),
  };
  const index = new URL('../../server/src/lib/executors/index.ts', import.meta.url).href;
  const script = [
    'import fs from "node:fs/promises";',
    `const { getProviderAdapters, getExecutor } = await import(${JSON.stringify(index)});`,
    `const config = ${JSON.stringify(config)};`,
    'const provider = (await getProviderAdapters()).get("glm");',
    'const runnableBefore = Boolean(await getExecutor("glm"));',
    'const before = await provider.probe(config);',
    `await fs.symlink(${JSON.stringify(candidate.binary)}, config.deepseekBin);`,
    'const after = await provider.probe(config);',
    'console.log(JSON.stringify({ before, after, runnableBefore,',
    '  runnableAfter: Boolean(await getExecutor("glm")),',
    '  same: provider === (await getProviderAdapters()).get("glm") }));',
  ].join('\n');
  const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', script], {
    env: {
      PATH: process.env.PATH,
      HOME: root,
      GRIGDESK_HOME: path.join(root, 'data'),
      GRIGDESK_GLM_API_MODE: 'api',
      ZAI_API_KEY: GLM_SERVICE_KEY,
      NODE_V8_COVERAGE: '',
    },
    timeout: 60000,
  });
  const result = JSON.parse(stdout.trim().split('\n').at(-1));
  const plugin = candidate.info.glm.inputs.llmPiAi;

  assert.ok(plugin);

  const identity = glmCompatibilityIdentity({ ...candidate.info.glm.inputs, llmPiAi: plugin }, 'api');
  const admitted = candidate.info.glm.admission.some((entry) =>
    entry.mode === 'api' && entry.compatibility === identity);

  assert.equal(result.before.code, 'deepseek_binary_missing');
  assert.equal(result.runnableBefore, true);
  assert.equal(result.runnableAfter, true);
  assert.equal(result.same, true);
  assert.equal(result.after.packageId, candidate.info.packageId);
  assert.equal(result.after.ok, admitted);

  if (!admitted) {
    assert.equal(result.after.code, 'glm_runtime_not_admitted', 'Открытый baseline допуск не расширен');
  }
});
