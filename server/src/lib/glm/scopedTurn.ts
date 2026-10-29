import { pathToFileURL } from 'node:url';

import { runScopedDsh } from '../executors/scopedDsh.ts';
import type { WorkToolsPort } from '../executors/workIpc.ts';
import { preparedGlmRuntime } from './preparedRuntime.ts';
import { assertGlmGenerationAdmission, describeGlmGenerationAsync } from './generation.ts';
import { buildGlmChildEnv, glmAccessError, resolveGlmAccess } from './env.ts';
import { buildGlmRoute, GLM_DEFAULT_EFFORT } from './contract.ts';
import type { GlmRuntimeDeps, GlmTurnOptions } from './runtime.ts';
import { startDeepSeekServer } from '../deepseek/serverRuntime.ts';

/**
 * Триаж сохраняет режим доступа, ключ и допуск GLM; меняется только набор доступных инструментов.
 * Изолированный MCP-профиль не наследует чат, проектные настройки или штатные native tools.
 */
export async function runScopedGlmTurn(options: GlmTurnOptions, deps: GlmRuntimeDeps) {
  const access = resolveGlmAccess({ env: deps.env, admission: deps.admission });

  if (access.reason || !access.mode) {
    throw glmAccessError(access.reason ?? 'glm_access_mode_missing', 'Доступ GLM для триажа не настроен.');
  }
  if (!options.cwd || !options.model) {
    throw new Error('Триаж GLM требует модель и каталог результата.');
  }

  let pair: unknown;

  try {
    pair = JSON.parse(options.model);
  } catch {
    throw glmAccessError('glm_model_mismatch', 'Модель триажа отсутствует в каталоге GLM.');
  }

  const entry = deps.catalog?.find((candidate) => candidate.id === options.model);

  if (!Array.isArray(pair) || pair.length !== 2 || pair[0] !== 'zai'
    || typeof pair[1] !== 'string' || deps.catalog && !entry) {
    throw glmAccessError('glm_model_mismatch', 'Модель триажа отсутствует в каталоге GLM.');
  }
  if (options.effort && entry?.efforts?.length && !entry.efforts.includes(options.effort)) {
    throw glmAccessError('glm_effort_mismatch', 'Усилие триажа не поддерживается моделью GLM.');
  }

  const runtime = await preparedGlmRuntime(options.config, options.preparedRuntime);
  const generation = await describeGlmGenerationAsync(options.config, runtime);

  assertGlmGenerationAdmission(generation, access.mode, deps.admission);

  const mode = access.mode;
  const route = {
    ...buildGlmRoute(mode),
    ...(deps.modelEndpoint ? { baseURL: deps.modelEndpoint } : {}),
  };

  return runScopedDsh({
    ...options,
    effort: options.effort || GLM_DEFAULT_EFFORT,
    cwd: options.cwd,
    message: String(options.message ?? ''),
    workspaceAccess: options.workspaceAccess,
    workTools: options.workTools as WorkToolsPort | undefined,
  }, {
    runtime,
    childEnv: (home) => buildGlmChildEnv({
      source: deps.env,
      dshHome: home,
      mode,
    }),
    rows: [{ id: 'llm-deepseek', disabled: true }],
    insert: [{
      id: 'llm-pi-ai',
      name: '@deepseek-ai/dsh-llm-pi-ai',
      config: { providers: { zai: route } },
    }, ...(deps.egressGuard ? [{
      id: 'grigdesk-glm-egress-guard',
      name: pathToFileURL(deps.egressGuard).href,
    }] : [])],
    startServer: (input) => startDeepSeekServer({
      ...input,
      ...(deps.spawn ? { spawnProcess: deps.spawn } : {}),
    }),
  });
}

