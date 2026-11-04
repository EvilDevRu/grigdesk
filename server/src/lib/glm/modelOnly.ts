import { pathToFileURL } from 'node:url';

import type { DeepSeekRuntimeConfig } from '../deepseek/runtimeProcess.ts';
import { startDeepSeekServer } from '../deepseek/serverRuntime.ts';
import { runModelOnlyDsh } from '../executors/scopedDsh.ts';
import type { ModelOnlyDshOptions } from '../executors/scopedDsh.ts';
import type { GlmRuntimeDeps } from './runtime.ts';
import { resolveDeepSeekRuntimeAsync } from '../deepseek/runtimeProcess.ts';
import { assertGlmGenerationAdmission, describeGlmGenerationAsync, glmRuntimeConfig } from './generation.ts';
import { buildGlmChildEnv, glmAccessError, resolveGlmAccess } from './env.ts';
import { buildGlmRoute, GLM_DEFAULT_EFFORT } from './contract.ts';

export interface GlmModelOnlyOptions extends ModelOnlyDshOptions {
  config: DeepSeekRuntimeConfig;
}

/**
 * Режим и ключ проверяются до metadata, допуск выпуска — до сессии и prompt.
 * Меняется только закрытый профиль; обычный чатовый preflight не используется и не ослабляется.
 */
export async function runGlmModelOnly(options: GlmModelOnlyOptions, deps: GlmRuntimeDeps) {
  const input = {
    ...options,
    effort: options.effort || GLM_DEFAULT_EFFORT
  };

  return runModelOnlyDsh(input, async (signal) => {
    const access = resolveGlmAccess({
      env: deps.env,
      admission: deps.admission
    });

    if (access.reason || !access.mode) {
      throw glmAccessError(access.reason ?? 'glm_access_mode_missing', 'Режим GLM недоступен.');
    }

    let pair: unknown;

    try {
      pair = JSON.parse(options.model);
    }
    catch {
      pair = null;
    }

    const entry = deps.catalog?.find((row) => row.id === options.model);

    if (!Array.isArray(pair) || pair.length !== 2 || pair[0] !== 'zai'
      || typeof pair[1] !== 'string' || !pair[1] || deps.catalog && !entry) {
      throw glmAccessError('glm_model_mismatch', 'Модель отсутствует в каталоге GLM.');
    }

    const effort = input.effort;

    if (entry?.efforts?.length && !entry.efforts.includes(effort)) {
      throw glmAccessError('glm_effort_mismatch', 'Усилие отсутствует в каталоге GLM.');
    }

    const runtime = await resolveDeepSeekRuntimeAsync(glmRuntimeConfig(options.config), {
      signal
    });

    signal.throwIfAborted();

    const generation = await describeGlmGenerationAsync(options.config, runtime);

    assertGlmGenerationAdmission(generation, access.mode, deps.admission);
    signal.throwIfAborted();

    const mode = access.mode;
    const route = {
      ...buildGlmRoute(mode),
      ...(deps.modelEndpoint ? {
        baseURL: deps.modelEndpoint
      } : {}),
      retryPolicy: {
        mode: 'normal',
        maxRetries: 0
      }
    };

    return {
      runtime,
      childEnv: (home) => buildGlmChildEnv({
        source: deps.env,
        dshHome: home,
        mode
      }),
      rows: [{
        id: 'llm-deepseek',
        disabled: true
      }],
      insert: [{
        id: 'llm-pi-ai',
        name: '@deepseek-ai/dsh-llm-pi-ai',
        config: {
          providers: {
            zai: route
          }
        }
      },
      ...(deps.egressGuard ? [{
        id: 'loopback-only',
        name: pathToFileURL(deps.egressGuard).href
      }] : [])],
      startServer: (input) => startDeepSeekServer({
        ...input,
        ...(deps.spawn ? {
          spawnProcess: deps.spawn
        } : {})
      }),
    };
  });
}
