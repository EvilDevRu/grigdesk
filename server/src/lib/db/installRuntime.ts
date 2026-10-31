import type { PluginInstallRuntime } from '../packageInstall/service.ts';
import type { createDbSessionManager } from './sessionManager.ts';

/**
 * Установщик заменяет файлы только под допуском менеджера сессий.
 * Refresh намеренно не сканирует пакеты: активацией владеет следующий старт сервера.
 */
export function createDbEngineInstallRuntime({ sessions, engines }: {
  sessions: Pick<ReturnType<typeof createDbSessionManager>, 'prepareEngineReplace'>;
  engines: { get(id: string): unknown };
}): PluginInstallRuntime {
  return {
    isLoaded: (id) => Boolean(engines.get(id)),
    prepareReplace: async (id) => sessions.prepareEngineReplace(id),
    refresh: async () => {},
  };
}

export default createDbEngineInstallRuntime;
