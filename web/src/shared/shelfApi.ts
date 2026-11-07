import type { TaskPersonalSource } from '../../../shared/tasks/taskReference.ts';
import { trackerMutationOptions } from './trackerMutation.ts';
import { api } from './apiClient.ts';
import { parseShelfEntrySnapshot, parseShelfState } from '../../../shared/trackers/shelfContracts.ts';
import type { ShelfPutInput, ShelfReason, ShelfState } from '../../../shared/trackers/shelfContracts.ts';

// Снимок собирает решатель полки из живых источников, поэтому до проверки контрактом он
// остаётся сырым: сервер такой же снимок проверяет у себя и отказывает по нему.
export interface ShelfPutRequest {
  title: string;
  reason: ShelfReason;
  snapshot: unknown;
  createIfMissing: boolean;
}

function shelfUrl(taskId: string, source: TaskPersonalSource): string {
  const prefix = source === 'grigdesk' ? 'grigdesk-tasks' : 'tracker';

  return `/api/${prefix}/task-shelf/${encodeURIComponent(taskId)}`;
}

/**
 * Полка принадлежит серверу и привязана к портальной учётке: любое действие отвечает
 * полным подтверждённым снимком, и он же — единственный источник состояния раздела.
 * Поэтому контракт проверяется и на чтении, и на каждой мутации.
 */
export const shelfApi = {
  async list(source: TaskPersonalSource = 'tracker'): Promise<ShelfState> {
    const prefix = source === 'grigdesk' ? 'grigdesk-tasks' : 'tracker';
    const value: unknown = await api.get(`/api/${prefix}/task-shelf`);

    return parseShelfState(value);
  },

  async put(
    taskId: string,
    request: ShelfPutRequest,
    source: TaskPersonalSource = 'tracker',
  ): Promise<ShelfState> {
    const body: ShelfPutInput = {
      title: request.title,
      reason: request.reason,
      snapshot: parseShelfEntrySnapshot(request.snapshot),
      createIfMissing: request.createIfMissing,
    };
    const value: unknown = await api.put(shelfUrl(taskId, source), body,
      source === 'tracker' ? trackerMutationOptions() : {});

    return parseShelfState(value);
  },

  async remove(taskId: string, source: TaskPersonalSource = 'tracker'): Promise<ShelfState> {
    const value: unknown = await api.del(shelfUrl(taskId, source), undefined,
      source === 'tracker' ? trackerMutationOptions() : {});

    return parseShelfState(value);
  },
};
