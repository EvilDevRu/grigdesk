import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { writeDeepSeekLoopbackOverlay } from '../../../helpers/deepseekLoopback.mts';

/**
 * Production загружается только по runtime filename уже проверенного CJS в R.
 * Отсутствующий export отказывает до старта модели, source fallback отсутствует.
 */
export async function loadCompiledApi(bundle, binary) {
  const entry = createRequire(import.meta.url)(bundle);

  assert.equal(typeof entry.loadPackagedVerification, 'function');

  const api = await entry.loadPackagedVerification(binary);

  for (const name of ['runDeepSeekWebTurn', 'startDeepSeekServer', 'runDeepSeekTurn',
    'prepareDeepSeekLaunch', 'createGlmAdapter', 'runGlmTurn', 'glmCompatibilityIdentity',
    'runDeepSeekFactory', 'runGlmFactory']) {
    assert.equal(typeof api[name], 'function', `Payload не объявляет ${name}`);
  }

  return api;
}

/**
 * Generation берётся из descriptor явно выбранного отдельного DeepSeek ELF.
 * Неявная подготовка второго кандидата и installed lookup запрещены.
 */
function generation(config, runtime) {
  assert.equal(runtime?.kind, 'binary');
  assert.match(runtime.metadata?.packageId ?? '', /^[a-f0-9]{64}$/u);

  return path.join(config.deepseekCacheDir, 'packages', runtime.metadata.packageId, 'generation');
}

/**
 * Модельный endpoint меняется через существующий DI, исходные hooks и sandbox сохраняются.
 * Test overlay запрещает внешний fetch и не использует production admission или ключи.
 */
async function patchOverlay(config, runtime, overlayPath, endpoint) {
  const root = path.dirname(overlayPath);
  const document = path.join(root, 'native-settings.yaml');
  const original = await fs.readFile(overlayPath, 'utf8');

  await fs.writeFile(document, '{}\n', { mode: 0o600, flag: 'wx' }).catch((error) => {
    if (error.code !== 'EEXIST') {
      throw error;
    }
  });

  const patch = await writeDeepSeekLoopbackOverlay({
    root,
    artifact: generation(config, runtime),
    endpoint,
    document,
  });
  const combined = path.join(root, 'combined.yml');

  await fs.writeFile(combined, original + await fs.readFile(patch, 'utf8'), { mode: 0o600 });

  return combined;
}

/**
 * Последний вызов web port всегда достигает compiled startDeepSeekServer из payload.
 * Подменён только overlay модели, production запуск и handle не заменяются.
 */
export function deepSeekChatPort(api, config, endpoint) {
  return async (options) => api.startDeepSeekServer({
    ...options,
    overlayPath: await patchOverlay(config, options.runtime, options.overlayPath, endpoint),
  });
}

/**
 * ACP wrapper сохраняет opaque handle production prepareLaunch и compiled runDeepSeekTurn.
 * Тот же port использует линия A для приёмки настоящего фабричного этапа S26.
 */
export function deepSeekFactoryPort(api, endpoint) {
  return (options) => api.runDeepSeekTurn({
    ...options,
    deps: {
      prepareLaunch: async (input) => {
        const launch = await api.prepareDeepSeekLaunch(input);
        const overlayPath = await patchOverlay(input.config, input.runtime, launch.overlayPath, endpoint);

        return { ...launch, overlayPath };
      },
    },
  });
}

/**
 * Synthetic admission вычисляется из metadata настоящего отдельного DeepSeek ELF.
 * Каталог, ключ и модельный адрес существуют только в явно переданном test DI.
 */
export function glmDeps(api, info, endpoint, egressGuard, env, model) {
  const inputs = info.glm?.inputs;

  assert.ok(inputs?.llmPiAi, 'Явный DeepSeek ELF не объявляет GLM plugin');

  return {
    env,
    admission: [{ mode: 'api', compatibility: api.glmCompatibilityIdentity(inputs, 'api') }],
    modelEndpoint: endpoint,
    egressGuard,
    catalog: [{ id: model, efforts: ['low', 'high', 'max'] }],
  };
}
