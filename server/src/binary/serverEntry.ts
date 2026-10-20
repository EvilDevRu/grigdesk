import { realpathSync } from 'node:fs';

import { configurePayloadContext } from '../lib/runtimeBuildContext.ts';

/**
 * Физический bundle определяет R, внешний ELF задаёт только I.
 * Повторная конфигурация допустима с теми же путями, смена контекста закрыта.
 */
function configure(binary: string): void {
  configurePayloadContext({
    mode: 'payload',
    bundleFile: __filename,
    binary: realpathSync(binary),
  });
}

/**
 * Контекст установлен до app/config и раннего data-home guard.
 * Нижний штатный вызов startServer в app.ts сохраняет единственный запуск через module cache.
 */
export async function startPayloadServer(binary: string): Promise<void> {
  configure(binary);
  await import('../app.ts');
}

/**
 * Приёмка читает реальные compiled adapters/wrappers из той же поставки.
 * Это библиотечный export, он не создаёт HTTP route, CLI interpreter или test env override.
 */
export async function loadPackagedVerification(binary: string) {
  configure(binary);

  const [glm, glmTurn, deepseekWeb, deepseekTurn, deepseekRunner, glmRunner,
    deepseekServer, glmContract] = await Promise.all([
    import('../lib/executors/glm.ts'),
    import('../lib/glm/runtime.ts'),
    import('../lib/deepseek/webRuntime.ts'),
    import('../lib/deepseek/runtime.ts'),
    import('../../scripts/deepseekRunner.mts'),
    import('../../scripts/glmRunner.mts'),
    import('../lib/deepseek/serverRuntime.ts'),
    import('../lib/glm/contract.ts'),
  ]);

  return {
    createGlmAdapter: glm.createGlmAdapter,
    runGlmTurn: glmTurn.runGlmTurn,
    runDeepSeekWebTurn: deepseekWeb.runDeepSeekWebTurn,
    runDeepSeekTurn: deepseekTurn.runDeepSeekTurn,
    prepareDeepSeekLaunch: deepseekTurn.prepareDeepSeekLaunch,
    startDeepSeekServer: deepseekServer.startDeepSeekServer,
    glmCompatibilityIdentity: glmContract.glmCompatibilityIdentity,
    runDeepSeekFactory: deepseekRunner.runDeepSeekFactory,
    runGlmFactory: glmRunner.runGlmFactory,
  };
}
