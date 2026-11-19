import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { configurePayloadContext } from '../lib/runtimeBuildContext.ts';
import { configureDarwinProcessHelper } from '../../../shared/node/processIdentity.ts';

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
 * Настраивает probe из того же распакованного поколения. Нативный запуск
 * и проверка границы permit используют одну сверку хеша помощника.
 */
async function configureNativePayload(binary: string): Promise<void> {
  configure(binary);

  if (process.platform === 'darwin') {
    const directory = path.join(path.dirname(__filename), 'runtime/darwin-tools');
    const digest = await readFile(path.join(directory, 'process-identity.sha256'), 'utf8');

    await configureDarwinProcessHelper(path.join(directory, 'process-identity'), digest);
  }
}

/**
 * Контекст установлен до app/config и раннего data-home guard.
 * Нижний штатный вызов startServer в app.ts сохраняет единственный запуск через module cache.
 */
export async function startPayloadServer(binary: string): Promise<void> {
  await configureNativePayload(binary);

  await import('../app.ts');
}

/**
 * Приёмка Darwin имитирует ошибку записи в своей инстанции bundled launcher.
 * Библиотечный вход не запускает сервер и не добавляет маршрутов или флагов.
 */
export async function loadDarwinLaunchVerification(binary: string) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('darwin_arm64_required');
  }

  await configureNativePayload(binary);

  const [launch, admission, arbiter, store] = await Promise.all([
    import('../lib/factoryDarwinLaunch.ts'),
    import('../lib/factoryLaunchAdmission.ts'),
    import('../lib/arbiterConversationService.ts'),
    import('../lib/arbiterConversationStore.ts'),
  ]);

  return {
    spawnDarwinRouteProcess: launch.spawnDarwinRouteProcess,
    readDarwinLaunchRecords: launch.readDarwinLaunchRecords,
    FactoryLaunchAdmission: admission.FactoryLaunchAdmission,
    ArbiterConversationService: arbiter.ArbiterConversationService,
    ArbiterConversationStore: store.ArbiterConversationStore,
  };
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
