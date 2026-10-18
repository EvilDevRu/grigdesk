// Машинный descriptor предназначен runner/install gates, без API key и приватного home.
// Аргументы и identity происходят из той же проверки, которую выполняет чатовый адаптер.

import { config } from '../src/config.ts';
import { probeDeepSeekRuntime, resolveDeepSeekRuntime } from '../src/lib/deepseek/runtimeProcess.ts';

try {
  const args = process.argv.slice(2);
  let candidate: string | undefined;
  let operation = 'descriptor';

  while (args.length) {
    const arg = args.shift();

    if (arg === '--artifact-dir' && !candidate) {
      candidate = args.shift();

      if (!candidate?.startsWith('/')) {
        throw new Error('--artifact-dir требует абсолютный путь');
      }
    } else if ((arg === '--probe' || arg === '--catalog') && operation === 'descriptor') {
      operation = arg.slice(2);
    } else {
      throw new Error('Неизвестный или повторённый аргумент runtime info');
    }
  }

  const mode = process.env.GRIGDESK_DEEPSEEK_RUNTIME_MODE;

  if (mode && mode !== 'installed' && mode !== 'embedded') {
    throw new Error('Неизвестный режим runtime DeepSeek');
  }

  const runtimeConfig = {
    ...config,
    ...(mode ? { deepseekRuntimeMode: mode as 'installed' | 'embedded' } : {}),
    ...(process.env.GRIGDESK_DEEPSEEK_GENERATION_ROOT
      ? { deepseekGenerationRoot: process.env.GRIGDESK_DEEPSEEK_GENERATION_ROOT } : {}),
    ...(process.env.GRIGDESK_DEEPSEEK_ARTIFACT_DIR
      ? { deepseekArtifactDir: process.env.GRIGDESK_DEEPSEEK_ARTIFACT_DIR } : {}),
    ...(candidate ? { deepseekArtifactDir: candidate } : {}),
  };
  const runtime = resolveDeepSeekRuntime(runtimeConfig);

  if (operation === 'probe') {
    const result = await probeDeepSeekRuntime({
      ...runtimeConfig,
      ...(runtime.generationDir ? { deepseekArtifactDir: runtime.generationDir } : {}),
    });

    if (!result.ok) {
      throw new Error(result.error);
    }

    console.log(runtime.runtimeVersion);
  } else if (operation === 'catalog') {
    const models = ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-flash',
      'deepseek-v4-flash-vision-exp'];

    for (const [index, model] of models.entries()) {
      console.log([JSON.stringify(['deepseek-official', model]), 'deepseek', 'default',
        1, 'default', 100 - index * 10, 1, 0, 1, runtime.runtimeVersion,
        runtime.runtimeVersion].join('\t'));
    }
  } else {
    console.log(JSON.stringify(runtime));
  }
} catch (error) {
  console.error(JSON.stringify({ code: (error as { code?: string }).code, error: (error as Error).message }));
  process.exitCode = 1;
}
