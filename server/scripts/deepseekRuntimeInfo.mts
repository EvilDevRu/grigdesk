// Машинный descriptor предназначен runner/install gates, без API key и приватного home.
// Аргументы и identity происходят из той же проверки, которую выполняет чатовый адаптер.

import { config } from '../src/config.ts';
import { probeDeepSeekRuntime, resolveDeepSeekRuntimeAsync } from '../src/lib/deepseek/runtimeProcess.ts';
import type { DeepSeekRuntimeConfig } from '../src/lib/deepseek/runtimeProcess.ts';

try {
  const args = process.argv.slice(2);
  let candidate: string | undefined;
  let binary: string | undefined;
  let cacheDir: string | undefined;
  let operation = 'descriptor';

  while (args.length) {
    const arg = args.shift();

    if (arg === '--artifact-dir' && !candidate) {
      candidate = args.shift();

      if (!candidate?.startsWith('/')) {
        throw new Error('--artifact-dir требует абсолютный путь');
      }
    } else if (arg === '--binary' && !binary) {
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
      throw new Error('Неизвестный или повторённый аргумент runtime info');
    }
  }

  const mode = process.env.GRIGDESK_DEEPSEEK_RUNTIME_MODE;

  if (mode && mode !== 'installed' && mode !== 'embedded' && mode !== 'binary') {
    throw new Error('Неизвестный режим runtime DeepSeek');
  }
  if (binary && candidate) {
    throw new Error('--binary и --artifact-dir нельзя сочетать');
  }

  const runtimeConfig = {
    ...config,
    ...(mode ? { deepseekRuntimeMode: mode as DeepSeekRuntimeConfig['deepseekRuntimeMode'] } : {}),
    ...(process.env.GRIGDESK_DEEPSEEK_GENERATION_ROOT
      ? { deepseekGenerationRoot: process.env.GRIGDESK_DEEPSEEK_GENERATION_ROOT } : {}),
    ...(process.env.GRIGDESK_DEEPSEEK_ARTIFACT_DIR
      ? { deepseekArtifactDir: process.env.GRIGDESK_DEEPSEEK_ARTIFACT_DIR } : {}),
    ...(candidate ? { deepseekArtifactDir: candidate } : {}),
    ...(binary ? {
      deepseekRuntimeMode: 'binary' as const,
      deepseekBin: binary,
      deepseekBinOverride: undefined,
      deepseekArtifactDir: undefined,
    } : {}),
    deepseekCacheDir: cacheDir || process.env.GRIGDESK_DEEPSEEK_CACHE_DIR || config.deepseekCacheDir,
  };
  const runtime = await resolveDeepSeekRuntimeAsync(runtimeConfig);
  // Одинаковая generation бывает у разных ELF: coverage должен различать packageId.
  // Дефис перед grigdesk сохраняет suffix в semver-parser и у stable upstream.
  // Диагностический runtimeVersion metadata и legacy observed version не изменяются.
  const runnerVersion = runtime.kind === 'binary'
    ? `${runtime.runtimeVersion.replace('.grigdesk.', '-grigdesk.')}.p${runtime.metadata!.packageId}`
    : runtime.runtimeVersion;

  if (operation === 'probe') {
    const result = await probeDeepSeekRuntime(runtimeConfig, runtime);

    if (!result.ok) {
      throw new Error(result.error);
    }

    console.log(runnerVersion);
  } else if (operation === 'catalog') {
    const models = ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-flash',
      'deepseek-v4-flash-vision-exp'];

    for (const [index, model] of models.entries()) {
      console.log([JSON.stringify(['deepseek-official', model]), 'deepseek', 'default',
        1, 'default', 100 - index * 10, 1, 0, 1, runnerVersion,
        runnerVersion].join('\t'));
    }
  } else {
    console.log(JSON.stringify({ ...runtime, runnerVersion }));
  }
} catch (error) {
  console.error(JSON.stringify({ code: (error as { code?: string }).code, error: (error as Error).message }));
  process.exitCode = 1;
}
