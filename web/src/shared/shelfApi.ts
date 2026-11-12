import type { TaskSourceId } from '../../../shared/tasks/taskReference.ts';
import { resolveTrackerTarget } from './trackerTarget.ts';
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

/**
 * Личный scope выбирается сервером по конкретному драйверу.
 * Отсутствие полной ссылки сохраняет прежнюю ручку дефолтной доски.
 */
function shelfUrl(taskId: string, source: TaskPersonalSource, taskSource?: string): string {
  const prefix = taskSource ? `tracker/${encodeURIComponent(taskSource.split('@')[0]!)}` : 'tracker';

  return `/api/${prefix}/task-shelf/${encodeURIComponent(taskId)}`;
}

/**
 * Полка принадлежит серверу и привязана к портальной учётке: любое действие отвечает
 * полным подтверждённым снимком, и он же — единственный источник состояния раздела.
 * Поэтому контракт проверяется и на чтении, и на каждой мутации.
 */
export const shelfApi = {
  /**
   * Проверяет владельца адресной ветки до чтения её меток.
   * Прежний числовой вход использует подключение по умолчанию.
   */
  async list(source: TaskPersonalSource = 'tracker', taskSource?: string): Promise<ShelfState> {
    const prefix = taskSource ? `tracker/${encodeURIComponent(taskSource.split('@')[0]!)}` : 'tracker';
    const target = taskSource ? await resolveTrackerTarget(taskSource as TaskSourceId, api) : null;
    const value: unknown = await api.get(`/api/${prefix}/task-shelf`, target?.options);

    return parseShelfState(value);
  },

  /**
   * Перед записью подтверждает источник и поколение этой ветки.
   * Серверный снимок остаётся единственным результатом успешного эффекта.
   */
  async put(
    taskId: string,
    request: ShelfPutRequest,
    source: TaskPersonalSource = 'tracker', taskSource?: string,
  ): Promise<ShelfState> {
    const body: ShelfPutInput = {
      title: request.title,
      reason: request.reason,
      snapshot: parseShelfEntrySnapshot(request.snapshot),
      createIfMissing: request.createIfMissing,
    };
    const target = taskSource ? await resolveTrackerTarget(taskSource as TaskSourceId, api) : null;
    const value: unknown = await api.put(shelfUrl(taskId, source, taskSource), body,
      target?.options ?? trackerMutationOptions());

    return parseShelfState(value);
  },

  /**
   * Удаляет запись только в подтверждённой учётной записи.
   * Ошибка адресного подключения не допускает перехода к дефолту.
   */
  async remove(
    taskId: string, source: TaskPersonalSource = 'tracker', taskSource?: string,
  ): Promise<ShelfState> {
    const target = taskSource ? await resolveTrackerTarget(taskSource as TaskSourceId, api) : null;
    const value: unknown = await api.del(shelfUrl(taskId, source, taskSource), undefined,
      target?.options ?? trackerMutationOptions());

    return parseShelfState(value);
  },
};
