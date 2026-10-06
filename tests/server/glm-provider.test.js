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
 * Каталог стенда карточки: поколение-фикстура и корень Кокпита для MCP-статуса.
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
      glmRuntimeHome: path.join(root, 'state', 'cockpit-glm'),
      deepseekArtifactDir: artifact,
      deepseekRuntimeMode: 'embedded',
      deepseekBin: '/no-global-dsh',
    },
  };
}

function adapter(env = {}) {
  return createGlmAdapter({
    env: {
      COCKPIT_GLM_API_MODE: 'api',
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
    'console.log(JSON.stringify({ run: typeof card.run, executor: await getExecutor("glm") }));',
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
  });
  assert.deepEqual([glm.id, glm.name, glm.vendor, glm.color, glm.order], [
    'glm',
    'GLM (Z.ai)',
    'Z.ai',
    '#3F3F46',
    5,
  ]);
  assert.equal(glm.catalogLive, false);
  assert.equal(glm.retryContract, 'never');
  assert.deepEqual(glm.compaction, { kind: 'summary' });
  assert.equal(glm.workToolsTransport, 'mcp');
  assert.deepEqual(glm.seedModels(), []);

  for (const field of ['install', 'login', 'usage', 'statusPage', 'nativeSettings', 'inTurnInput',
    'scopedWorkspace', 'untrustedInput', 'runUntrusted', 'session', 'efforts', 'modelEfforts', 'commands']) {
    assert.equal(glm[field], undefined, field);
  }

  assert.deepEqual((await glm.modes()).map((mode) => mode.id), ['default', 'auto']);
});

test('distribution встроенный: buildId и версия runtime, без установки и обновления', async (t) => {
  const f = await fixture(t);
  const distribution = adapter().distribution(f.config);

  assert.equal(distribution.kind, 'embedded');
  assert.equal(distribution.label, 'Входит в Cockpit');
  assert.equal(distribution.buildId, f.metadata.buildId);
  assert.equal(distribution.runtimeVersion, f.metadata.runtimeVersion);
  assert.equal(distribution.error, undefined);
  assert.match(distribution.authHint, /COCKPIT_GLM_API_MODE/u);
  assert.equal(adapter().updateCmd, undefined);
  assert.equal(adapter().latestVersion, undefined);
});

test('внешний override DeepSeek даёт карточке GLM glm_runtime_external', async (t) => {
  const f = await fixture(t);
  const config = { ...f.config, deepseekBinOverride: '/opt/external/dsh' };
  const card = adapter();

  assert.equal(card.distribution(config).error, 'glm_runtime_external');
  assert.deepEqual(await card.probe(config), {
    ok: false,
    version: null,
    code: 'glm_runtime_external',
    error: 'GLM работает только на встроенной сборке Cockpit; внешний DeepSeek не используется.',
  });
});

test('отсутствующая generation даёт glm_runtime_missing', async (t) => {
  const f = await fixture(t);
  const config = { ...f.config, deepseekArtifactDir: path.join(f.root, 'missing') };

  assert.equal(adapter().distribution(config).error, 'glm_runtime_missing');
});

test('generation без поля llm-pi-ai в runtime.json даёт glm_plugin_missing', async (t) => {
  const f = await fixture(t, { plugin: false });
  const distribution = adapter().distribution(f.config);

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
    assert.match(status.note, /cockpit-work/u);
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
    { COCKPIT_GLM_API_MODE: '' },
    { COCKPIT_GLM_API_MODE: 'wrong' },
    { ZAI_API_KEY: '' },
    { COCKPIT_GLM_API_MODE: 'coding-plan', ZAI_CODING_API_KEY: KEY },
  ]) {
    const card = adapter(env);

    outputs.push(await card.auth(f.config));
    outputs.push(card.distribution(f.config));
    outputs.push(card.distribution({ ...f.config, deepseekBinOverride: '/x' }));
    outputs.push(card.catalogCacheKey(f.config));
    outputs.push(await card.catalog(f.config));
  }

  const auth = await adapter().auth(f.config);

  assert.equal(auth.available, false);
  assert.equal(auth.reason, 'glm_mode_not_admitted');
  assert.equal(JSON.stringify(outputs).includes(KEY), false);
  assert.deepEqual(outputs.filter((item, index) => index % 5 === 4), [null, null, null, null, null]);
});
