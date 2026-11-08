import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import glm, { createGlmAdapter } from '../../server/src/lib/executors/glm.ts';
import { getExecutor, getProviderAdapters } from '../../server/src/lib/executors/index.ts';
import { GLM_FIXTURE_PLUGIN, writeGlmArtifactFixture } from '../helpers/glmArtifactFixture.mts';

const KEY = 'synthetic-zai-secret-value';

/**
 * Каталог стенда карточки: поколение-фикстура и корень GrigDesk для MCP-статуса.
 * Процессов фикстура не запускает: entry отвергает всё, кроме -V.
 */
async function fixture(t, { plugin = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'glm-provider-'));
  const artifact = path.join(root, 'generation');
  const metadata = await writeGlmArtifactFixture(artifact, plugin ? { llmPiAi: GLM_FIXTURE_PLUGIN } : {});

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  return {
    root,
    metadata,
    config: {
      rootDir: root,
      stateDir: path.join(root, 'state'),
      glmRuntimeHome: path.join(root, 'state', 'grigdesk-glm'),
      deepseekBin: path.join(artifact, 'deepseek'),
      deepseekRuntimeMode: 'binary',
    },
  };
}

function adapter(env = {}) {
  return createGlmAdapter({
    env: {
      GRIGDESK_GLM_API_MODE: 'api',
      ZAI_API_KEY: KEY,
      ...env,
    },
    admission: [],
  });
}

const INDEX_URL = pathToFileURL(path.resolve(import.meta.dirname, '../../server/src/lib/executors/index.ts'))
  .href;

test("карточка glm есть в getProviderAdapters, а без режима getExecutor('glm') возвращает null", async () => {
  assert.equal((await getProviderAdapters()).get('glm'), glm);
  assert.equal(await getExecutor('glm'), glm.run ? glm : null);

  // Default export читает окружение при загрузке: «без режима» проверяется в чистом процессе.
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', [
    `const { getExecutor, getProviderAdapters } = await import(${JSON.stringify(INDEX_URL)});`,
    'const card = (await getProviderAdapters()).get("glm");',
    'console.log(JSON.stringify({',
    '  run: typeof card.run,',
    '  executor: await getExecutor("glm"),',
    '  inTurnInput: card.inTurnInput ?? null,',
    '}));',
  ].join('\n')], {
    env: {
      PATH: process.env.PATH,
      HOME: os.tmpdir(),
    },
    timeout: 60_000,
  });

  assert.deepEqual(JSON.parse(stdout.trim().split('\n').at(-1)), {
    run: 'undefined',
    executor: null,
    inTurnInput: null,
  });
  assert.deepEqual([glm.id, glm.name, glm.vendor, glm.color, glm.order], [
    'glm',
    'GLM (Z.ai)',
    'Z.ai',
    // Белый: тёмный фирменный цвет на тёмной теме читался как «недоступен».
    '#FFFFFF',
    5,
  ]);
  assert.equal(glm.catalogLive, false);
  assert.equal(glm.retryContract, 'never');
  assert.deepEqual(glm.compaction, { kind: 'summary' });
  assert.equal(glm.workToolsTransport, 'mcp');
  assert.deepEqual(glm.seedModels(), []);

  assert.equal(typeof glm.usage, 'function');
  assert.equal(typeof glm.commands, 'function');

  for (const field of ['install', 'login', 'statusPage', 'nativeSettings',
    'scopedWorkspace', 'untrustedInput', 'runUntrusted', 'session', 'efforts', 'modelEfforts']) {
    assert.equal(glm[field], undefined, field);
  }

  // Ввод в активный ход объявлен вместе с run: setup-only карточке принимать уточнения нечем.
  assert.deepEqual(glm.inTurnInput, glm.run ? {
    protocol: 1,
    text: true,
    confirmation: 'forwarded',
  } : undefined);

  assert.deepEqual((await glm.modes()).map((mode) => mode.id), ['default', 'auto']);
});

test('distribution binary: buildId и версия runtime, без обновления из карточки', async (t) => {
  const f = await fixture(t);
  // Distribution получает уже готовые версии: малой fixture не нужны native closure и запуск.
  // Поведение настоящего probe отдельно проверяет отсутствие поколения/плагина ниже.
  const distribution = adapter().distribution(f.config, {
    ok: true,
    buildId: f.metadata.buildId,
    runtimeVersion: f.metadata.runtimeVersion,
  });

  assert.equal(distribution.kind, 'binary');
  assert.equal(distribution.label, 'Отдельная поставка DeepSeek');
  assert.equal(distribution.buildId, f.metadata.buildId);
  assert.equal(distribution.runtimeVersion, f.metadata.runtimeVersion);
  assert.equal(distribution.error, undefined);
  assert.match(distribution.authHint, /GRIGDESK_GLM_API_MODE/u);
  assert.equal(adapter().updateCmd, undefined);
  assert.equal(adapter().latestVersion, undefined);
});

test('stock override DeepSeek отвергается без fallback на встроенную generation', async (t) => {
  const f = await fixture(t);
  const stock = path.join(f.root, 'stock-dsh');

  await fs.writeFile(stock, `#!${process.execPath}\n`
    + 'if (process.argv[2] === "-V") console.log("0.1.5-rc.2"); else process.exit(64);\n',
  { mode: 0o755 });

  const config = { ...f.config, deepseekBinOverride: stock };
  const card = adapter();
  const probe = await card.probe(config);

  assert.equal(card.distribution(config, probe).error, 'deepseek_binary_unsupported');
  assert.equal(probe.ok, false);
  assert.equal(probe.version, null);
  assert.equal(probe.code, 'deepseek_binary_unsupported');
  assert.match(probe.error, /install:binary/u);
});

test('отсутствующий binary даёт deepseek_binary_missing без legacy fallback', async (t) => {
  const f = await fixture(t);
  const config = { ...f.config, deepseekBin: path.join(f.root, 'missing') };

  const distribution = adapter().distribution(config, await adapter().probe(config));

  assert.equal(distribution.error, 'deepseek_binary_missing');
});

test('generation без поля llm-pi-ai в runtime.json даёт glm_plugin_missing', async (t) => {
  const f = await fixture(t, { plugin: false });
  const distribution = adapter().distribution(f.config, await adapter().probe(f.config));

  assert.equal(distribution.error, 'glm_plugin_missing');
  assert.equal(distribution.buildId, f.metadata.buildId);
  assert.match(distribution.problem.message, /модельного плагина GLM/u);
});

test('mcpStatus карточки не выдаёт проектные серверы за подключённые и не раскрывает env, args и ключей',
  async (t) => {
    const f = await fixture(t);

    await fs.writeFile(path.join(f.root, '.mcp.json'), JSON.stringify({ mcpServers: {
      secretive: {
        command: '/usr/bin/env',
        args: ['--token', 'synthetic-arg-secret'],
        env: { SECRET_TOKEN: 'synthetic-env-secret' },
      },
    } }));

    const status = await adapter().mcpStatus(f.config);
    const text = JSON.stringify(status);

    assert.equal(status.state, 'ok');
    assert.deepEqual(status.servers, []);
    assert.match(status.note, /grigdesk-work/u);
    assert.match(status.emptyText, /проектные MCP/u);

    const secrets = ['synthetic-arg-secret', 'synthetic-env-secret', 'SECRET_TOKEN', '/usr/bin/env', KEY];

    for (const secret of secrets) {
      assert.equal(text.includes(secret), false, secret);
    }
  });

test('карточка, причины и ошибки не содержат ключа', async (t) => {
  const f = await fixture(t);
  const outputs = [];

  for (const env of [
    {},
    { GRIGDESK_GLM_API_MODE: '' },
    { GRIGDESK_GLM_API_MODE: 'wrong' },
    { ZAI_API_KEY: '' },
    { GRIGDESK_GLM_API_MODE: 'coding-plan', ZAI_CODING_API_KEY: KEY },
  ]) {
    const card = adapter(env);

    outputs.push(await card.auth(f.config));
    outputs.push(card.distribution(f.config));
    outputs.push(card.distribution({ ...f.config, deepseekBinOverride: '/x' }));
    outputs.push(await card.catalogCacheKey(f.config));
    outputs.push(await card.catalog(f.config));
  }

  const auth = await adapter().auth(f.config);

  assert.equal(auth.available, false);
  assert.equal(auth.reason, 'glm_mode_not_admitted');
  assert.equal(JSON.stringify(outputs).includes(KEY), false);
  assert.deepEqual(outputs.filter((item, index) => index % 5 === 4), [null, null, null, null, null]);
});
