import path from 'node:path';

import type { DeepSeekRuntimeConfig } from '../../server/src/lib/deepseek/runtimeProcess.ts';
import { describeGlmGenerationAsync } from '../../server/src/lib/glm/generation.ts';
import { glmCompatibilityIdentity } from '../../server/src/lib/glm/contract.ts';
import { ensureTestDeepSeekArtifact } from './deepseekRuntimeArtifact.mts';
import { ensureTestDeepSeekBinary } from './deepseekBinary.mts';

interface GlmTestRuntime {
  config: DeepSeekRuntimeConfig;
  artifact: string;
  identity: string;
}

const selections = new Map<string, Promise<GlmTestRuntime>>();

/**
 * Общие GLM-сценарии выбирают реальную legacy generation или тот же production ELF.
 * Один процесс тестов проверяет candidate один раз; подмены Harness здесь нет.
 */
export function ensureGlmTestRuntime(): Promise<GlmTestRuntime> {
  const mode = process.env.GRIGDESK_TEST_GLM_DELIVERY ?? 'binary';

  if (mode !== 'binary' && mode !== 'embedded') {
    throw new Error('Некорректный выбор GLM test fixture');
  }

  let selection = selections.get(mode);

  if (!selection) {
    selection = prepareGlmTestRuntime(mode);
    selections.set(mode, selection);
  }

  return selection;
}

/**
 * Metadata выбранной поставки определяют тестовый допуск без изменения admission выпуска.
 * Binary-ветка намеренно не имеет доступного legacy artifact для скрытого fallback.
 */
async function prepareGlmTestRuntime(mode: 'binary' | 'embedded'): Promise<GlmTestRuntime> {
  let config: DeepSeekRuntimeConfig;
  let artifact: string;

  if (mode === 'binary') {
    const candidate = await ensureTestDeepSeekBinary();

    artifact = path.join(path.dirname(candidate.binary), 'legacy-unused');
    config = {
      deepseekRuntimeMode: 'binary',
      deepseekBin: candidate.binary,
      deepseekCacheDir: candidate.cacheDir,
    };
  } else {
    artifact = await ensureTestDeepSeekArtifact();
    config = { deepseekArtifactDir: artifact, deepseekRuntimeMode: 'embedded' };
  }

  const generation = await describeGlmGenerationAsync(config);

  return {
    config: Object.freeze(config),
    artifact,
    identity: glmCompatibilityIdentity(generation.runtime, 'api'),
  };
}
