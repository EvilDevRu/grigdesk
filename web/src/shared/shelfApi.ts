import { api } from './apiClient.ts';
import { parseShelfEntrySnapshot, parseShelfState } from '../../../shared/shelfContracts.ts';
import type { ShelfPutInput, ShelfReason, ShelfState } from '../../../shared/shelfContracts.ts';

// Снимок собирает решатель полки из живых источников, поэтому до проверки контрактом он
// остаётся сырым: сервер такой же снимок проверяет у себя и отказывает по нему.
export interface ShelfPutRequest {
  title: string;
  reason: ShelfReason;
  snapshot: unknown;
  createIfMissing: boolean;
}

function shelfUrl(taskId: string): string {
  return `/api/b24/task-shelf/${encodeURIComponent(taskId)}`;
}

/**
 * Полка принадлежит серверу и привязана к портальной учётке: любое действие отвечает
 * полным подтверждённым снимком, и он же — единственный источник состояния раздела.
 * Поэтому контракт проверяется и на чтении, и на каждой мутации.
 */
export const shelfApi = {
  async list(): Promise<ShelfState> {
    const value: unknown = await api.get('/api/b24/task-shelf');

    return parseShelfState(value);
  },

  async put(taskId: string, request: ShelfPutRequest): Promise<ShelfState> {
    const body: ShelfPutInput = {
      title: request.title,
      reason: request.reason,
      snapshot: parseShelfEntrySnapshot(request.snapshot),
      createIfMissing: request.createIfMissing,
    };
    const value: unknown = await api.put(shelfUrl(taskId), body);

    return parseShelfState(value);
  },

  async remove(taskId: string): Promise<ShelfState> {
    const value: unknown = await api.del(shelfUrl(taskId));

    return parseShelfState(value);
  },
};
