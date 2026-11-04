import { NO_TRACKER_CAPABILITIES } from '../../../../shared/trackers/contracts.ts';
import type { createGrigdeskTasksService } from '../grigdeskTasks/service.ts';
import type { TaskTracker } from './contract.ts';

export type OwnTasksService = ReturnType<typeof createGrigdeskTasksService>;

/**
 * Собственные задачи сохраняют ядровые номера, проекты и формат хранения.
 * Обёртка предоставляет контракт реестра без обращения к HTTP или внешнему трекеру.
 */
export function createOwnTracker(service: OwnTasksService): TaskTracker {
  return {
    id: 'own',
    capabilities: {
      ...NO_TRACKER_CAPABILITIES,
      create: true,
      projects: true,
    },
    isConfigured: () => true,
    accountIdentity: async () => null,
    testAuth: async () => ({ ok: true }),
    listTasks: async () => (await service.list()).tasks,
    taskDetail: (id) => service.get(id),
    getDashboard: async () => ({
      tasks: (await service.list()).tasks,
      toReview: [],
      created: [],
      widgets: [],
    }),
    sourceUrl: async (id) => (await service.get(id))?.sourceUrl ?? '',
    probeTaskNumber: async (id) => await service.get(id) ? 'exists' : 'absent',
    createTask: (input) => service.create(input),
    listGroups: () => service.listProjects(),
  };
}
