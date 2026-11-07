import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

import deepseek from '../../server/src/lib/executors/deepseek.ts';
import { createGlmAdapter } from '../../server/src/lib/executors/glm.ts';
import providersModule from '../../server/src/modules/providers/index.ts';
import { PrefsStore } from '../../server/src/lib/prefsStore.ts';
import { writeDeepSeekBinaryStub } from '../helpers/deepseekBinaryStub.mts';
import { runtimeInfoFixture } from '../helpers/deepseekMetadataFixture.mts';
import { glmCompatibilityIdentity } from '../../server/src/lib/glm/contract.ts';
import { GLM_FIXTURE_PLUGIN, writeGlmArtifactFixture } from '../helpers/glmArtifactFixture.mts';

const require = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = require('fastify');

test('distribution без probe — синхронный delivery object без filesystem IO', () => {
  const methods = ['readFileSync', 'statSync', 'lstatSync', 'realpathSync', 'existsSync', 'accessSync'];
  const previous = new Map(methods.map((name) => [name, fs[name]]));
  const glm = createGlmAdapter({ env: {}, admission: [] });
  const config = {
    deepseekRuntimeMode: 'embedded',
    deepseekArtifactDir: '/not-a-real-generation',
    deepseekBin: '/not-a-real-binary',
  };
  const values = [];
  let reads = 0;

  try {
    for (const name of methods) {
      fs[name] = () => {
        reads += 1;

        throw new Error('distribution не должна читать файловую систему');
      };
    }

    for (const provider of [deepseek, glm]) {
      values.push(provider.distribution(config));
      provider.bin(config);
    }
  } finally {
    for (const [name, value] of previous) {
      fs[name] = value;
    }
  }

  assert.equal(reads, 0);

  for (const value of values) {
    assert.equal(value.managed, true);
    assert.equal(value.kind, 'binary');
    assert.equal(typeof value.then, 'undefined');
    assert.equal('buildId' in value, false, 'Без probe нет проверенного buildId');
    assert.equal('problem' in value, false, 'Без probe нет результата проверки');
  }
});

/**
 * Настоящий providers HTTP handler получает metadata-only executable и offline adapters.
 * Подменены только внешние источники моделей/usage/latest, сеть и модель не вызываются.
 */
async function fixture(t) {
  const info = runtimeInfoFixture();
  const { root, binary } = await writeDeepSeekBinaryStub(t,
    'if (process.argv[2] !== "--runtime-info") {\n'
    + '  require("node:fs").writeFileSync(__filename + ".unexpected-spawn", process.argv.join(" "));\n'
    + '  process.exit(97);\n'
    + '}\n'
    + `process.stdout.write(${JSON.stringify(JSON.stringify(info))});`);
  const latestCalls = [];
  const offline = (provider) => ({
    ...provider,
    auth: () => ({
      mode: 'env',
      label: 'fixture',
      available: true,
    }),
    usage: undefined,
    statusPage: null,
    credentials: [],
    catalog: async () => null,
    updateCmd: ['--update-fixture'],
    latestVersion: async () => {
      latestCalls.push(provider.id);

      return '99.0.0';
    },
  });
  const managed = [deepseek, createGlmAdapter({ env: {}, admission: [] })].map(offline);
  const other = ['claude', 'kimi', 'codex'].map((id) => offline({
    id,
    name: id,
    bin: () => binary,
    probe: async () => ({ ok: true, version: '1.0.0' }),
  }));
  const config = {
    rootDir: root,
    modelsPath: path.join(root, 'models.json'),
    providerUsageSeenPath: path.join(root, 'usage-seen.json'),
    deepseekRuntimeMode: 'binary',
    deepseekBin: binary,
    deepseekCacheDir: path.join(root, 'cache'),
    deepseekGenerationRoot: path.join(root, 'legacy'),
  };
  const app = Fastify({ logger: false });

  t.after(() => app.close());
  await app.register(providersModule, {
    config,
    env: {},
    prefs: new PrefsStore({ prefsPath: path.join(root, 'prefs.json') }),
    getProviderAdapters: async () => new Map(
      [...managed, ...other].map((provider) => [provider.id, provider]),
    ),
    getModelsRegistry: async () => ({}),
  });

  return {
    app,
    root,
    binary,
    info,
    config,
    latestCalls,
  };
}

test('настоящий /api/providers возвращает managed binary distribution без Promise и автообновления',
  async (t) => {
    const { app } = await fixture(t);
    const response = await app.inject('/api/providers');

    assert.equal(response.statusCode, 200, response.body);

    const providers = response.json().providers;

    for (const id of ['deepseek', 'glm']) {
      const card = providers.find((provider) => provider.id === id);

      assert.ok(card.distribution, `У ${id} должен быть объект distribution`);
      assert.equal(card.distribution.kind, 'binary');
      assert.equal(card.distribution.managed, true);
      assert.ok(card.distribution.label);
      assert.equal(card.install, null);
      assert.equal(card.setupCommand, null);
      assert.equal(card.canUpdate, false);
      assert.equal(card.latest, null);
      assert.equal(card.updateAvailable, false);
    }

    const deepseekCard = providers.find((provider) => provider.id === 'deepseek');

    assert.equal(deepseekCard.installed, true);
  });

test('managed update-route отказывает до spawn; остальные провайдеры проверяют latest', async (t) => {
  const { app, binary, latestCalls } = await fixture(t);

  for (const id of ['deepseek', 'glm']) {
    const response = await app.inject({ method: 'POST', url: `/api/providers/${id}/update` });

    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().error, 'no_update');
  }

  const updates = await app.inject({ method: 'POST', url: '/api/providers/check-updates' });

  assert.equal(updates.statusCode, 200, updates.body);
  assert.deepEqual(latestCalls, ['claude', 'kimi', 'codex']);
  assert.deepEqual(updates.json().updates.map((entry) => entry.id), ['claude', 'kimi', 'codex']);
  await assert.rejects(fsp.access(`${binary}.unexpected-spawn`), { code: 'ENOENT' });

  const cards = (await app.inject('/api/providers')).json().providers;

  for (const id of latestCalls) {
    const card = cards.find((provider) => provider.id === id);

    assert.equal(card.canUpdate, true);
    assert.equal(card.latest, '99.0.0');
    assert.equal(card.updateAvailable, true);
  }
});

test('карточка обнаруживает пропавший ELF и новую metadata по прежнему пути', async (t) => {
  const { app, binary, info } = await fixture(t);
  const read = async () => {
    const response = await app.inject('/api/providers?refresh=1');

    assert.equal(response.statusCode, 200, response.body);

    return response.json().providers.find((provider) => provider.id === 'deepseek');
  };
  const initial = await read();

  assert.equal(initial.distribution.packageId, info.packageId);
  await fsp.rename(binary, `${binary}.saved`);

  const missing = await read();

  assert.equal(missing.installed, false);
  assert.equal(missing.distribution.error, 'deepseek_binary_missing');
  assert.equal('packageId' in missing.distribution, false);
  assert.match(missing.distribution.problem.command, /install:binary/u);

  const next = {
    ...info,
    binaryVersion: '0.0.2',
    packageId: 'f'.repeat(64),
  };

  await fsp.writeFile(binary,
    `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(next))});\n`,
    { mode: 0o755 });

  const replaced = await read();

  assert.equal(replaced.installed, true);
  assert.equal(replaced.distribution.packageId, next.packageId);
  assert.equal(replaced.distribution.binaryVersion, next.binaryVersion);
  assert.equal('problem' in replaced.distribution, false);
});

test('публичные GLM callers проверяют generation без синхронного чтения файлов', async (t) => {
  const { root } = await writeDeepSeekBinaryStub(t, 'process.exit(97);');
  const generation = path.join(root, 'generation');

  const metadata = await writeGlmArtifactFixture(generation, { llmPiAi: GLM_FIXTURE_PLUGIN });

  const adapter = createGlmAdapter({
    env: { GRIGDESK_GLM_API_MODE: 'api' },
    admission: [{ mode: 'api', compatibility: glmCompatibilityIdentity(metadata, 'api') }],
  });
  const config = { deepseekBin: path.join(generation, 'deepseek'), deepseekRuntimeMode: 'binary' };
  const previous = new Map(['readFileSync', 'statSync', 'realpathSync'].map((name) => [name, fs[name]]));
  let reads = 0;

  try {
    for (const [name, original] of previous) {
      fs[name] = (...args) => {
        reads += 1;

        return original(...args);
      };
    }

    await adapter.sessionBinding.securityProfile(config);
    await adapter.catalogCacheKey(config);
    await adapter.probe(config);
  } finally {
    for (const [name, original] of previous) {
      fs[name] = original;
    }
  }

  assert.equal(reads, 0);
});
