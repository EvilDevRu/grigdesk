// Metadata helper этапа GLM: descriptor выбранного DSH ELF, probe допуска и каталог моделей.
// Здесь нет модельного ключа, settings home, процесса DSH и обращения к модели.

import { config } from '../src/config.ts';
import { resolveDeepSeekRuntimeAsync } from '../src/lib/deepseek/runtimeProcess.ts';
import { glmAccessError } from '../src/lib/glm/env.ts';
import { GLM_FACTORY_MODELS, glmFactoryRunnerVersion } from '../src/lib/glm/factoryCatalog.ts';
import { assertGlmGenerationAdmission, describeGlmGenerationAsync } from '../src/lib/glm/generation.ts';

try {
  const args = process.argv.slice(2);
  let binary: string | undefined;
  let cacheDir: string | undefined;
  let operation = 'descriptor';

  while (args.length) {
    const arg = args.shift();

    if (arg === '--binary' && !binary) {
      binary = args.shift();

      if (!binary?.startsWith('/')) {
        throw new Error('--binary требует абсолютный путь');
      }
    } else if (arg === '--cache-dir' && !cacheDir) {
      cacheDir = args.shift();

      if (!cacheDir?.startsWith('/')) {
        throw new Error('--cache-dir требует абсолютный путь');
      }
    } else if ((arg === '--probe' || arg === '--catalog') && operation === 'descriptor') {
      operation = arg.slice(2);
    } else {
      throw new Error('Неизвестный или повторённый аргумент runtime info GLM');
    }
  }

  // GLM берёт DSH только из бинарной поставки: embedded generation и stock CLI не выбираются.
  const runtimeConfig = {
    ...config,
    deepseekRuntimeMode: 'binary' as const,
    ...(binary ? {
      deepseekBin: binary,
      deepseekBinOverride: undefined,
    } : {}),
    deepseekArtifactDir: undefined,
    deepseekCacheDir: cacheDir || process.env.GRIGDESK_DEEPSEEK_CACHE_DIR || config.deepseekCacheDir,
  };
  const runtime = await resolveDeepSeekRuntimeAsync(runtimeConfig);
  const generation = await describeGlmGenerationAsync(runtimeConfig, runtime);
  const runnerVersion = glmFactoryRunnerVersion(runtime.runtimeVersion, runtime.metadata!.packageId);

  if (operation === 'probe') {
    // Этап объявлен только для Обычного API; ключ здесь не читается, допуск — по metadata ELF.
    if (process.env.GRIGDESK_GLM_API_MODE !== 'api') {
      throw glmAccessError('glm_factory_mode_unsupported', 'Этап GLM поддерживает только Обычный API');
    }

    assertGlmGenerationAdmission(generation, 'api');
    console.log(runnerVersion);
  } else if (operation === 'catalog') {
    for (const [index, model] of GLM_FACTORY_MODELS.entries()) {
      console.log([model.id, 'glm', 'default', 1, 'default', 100 - index * 10, 1, 0, 1,
        runnerVersion, runnerVersion].join('\t'));
    }
  } else {
    // Каталог этапа в descriptor: раннер движка сверяет модель и уровень без второго процесса.
    console.log(JSON.stringify({
      ...runtime,
      runnerVersion,
      models: GLM_FACTORY_MODELS,
    }));
  }
} catch (error) {
  console.error(JSON.stringify({ code: (error as { code?: string }).code, error: (error as Error).message }));
  process.exitCode = 1;
}
