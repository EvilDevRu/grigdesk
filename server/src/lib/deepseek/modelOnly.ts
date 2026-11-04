import type { DeepSeekRuntimeConfig } from './runtimeProcess.ts';
import { resolveDeepSeekRuntimeAsync } from './runtimeProcess.ts';
import { buildDeepSeekChildEnv } from './env.ts';
import { startDeepSeekServer } from './serverRuntime.ts';
import { runModelOnlyDsh } from '../executors/scopedDsh.ts';
import type { ModelOnlyDshOptions } from '../executors/scopedDsh.ts';

export interface DeepSeekModelOnlyOptions extends ModelOnlyDshOptions {
  config: DeepSeekRuntimeConfig;
  env?: NodeJS.ProcessEnv;
  startServer?: typeof startDeepSeekServer;
}

/**
 * Отдельный вызов не использует run обычного чата и не читает его home.
 * Ключ проверяется до metadata, descriptor закрепляется перед общим изолированным запуском.
 */
export async function runDeepSeekModelOnly(options: DeepSeekModelOnlyOptions) {
  return runModelOnlyDsh(options, async (signal) => {
    const source = options.env ?? process.env;

    buildDeepSeekChildEnv({
      source,
      dshHome: '/unused-model-only-preflight'
    });

    const runtime = await resolveDeepSeekRuntimeAsync(options.config, {
      signal
    });

    signal.throwIfAborted();

    return {
      runtime,
      childEnv: (home) => buildDeepSeekChildEnv({
        source,
        dshHome: home
      }),
      startServer: options.startServer,
    };
  });
}
