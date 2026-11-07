import { api } from './apiClient.ts';
import {
  parseDockerHealth,
  parseDockerOkResponse,
  parseDockerOverview,
  parseDockerProjectActionResponse,
  parseDockerPruneResponse,
  parseDockerUsage,
} from '../../../shared/plugins/docker/dockerContracts';
import type {
  DockerContainerAction,
  DockerProjectAction,
  DockerPruneTarget,
} from '../../../shared/plugins/docker/dockerContracts';

export interface DockerPruneOptions {
  targets?: DockerPruneTarget[];
  allImages?: boolean;
}

/**
 * HTTP-клиент общий для приложения, но его JSON ещё не является данными Docker.
 * Каждый ответ проходит проверку контракта до попадания в реактивное состояние.
 */
export const dockerApi = {
  async health() {
    const value: unknown = await api.get('/api/docker/health');

    return parseDockerHealth(value);
  },

  async overview() {
    const value: unknown = await api.get('/api/docker/overview');

    return parseDockerOverview(value);
  },

  async usage(force = false) {
    const value: unknown = await api.get(`/api/docker/usage${force ? '?force=1' : ''}`);

    return parseDockerUsage(value);
  },

  async containerAction(id: string, action: DockerContainerAction) {
    const path = `/api/docker/containers/${encodeURIComponent(id)}/${action}`;
    const value: unknown = await api.post(path, undefined);

    return parseDockerOkResponse(value);
  },

  async projectAction(project: string, action: DockerProjectAction) {
    const path = `/api/docker/projects/${encodeURIComponent(project)}/${action}`;
    const value: unknown = await api.post(path, undefined);

    return parseDockerProjectActionResponse(value);
  },

  async remove(path: string) {
    const value: unknown = await api.del(path, undefined);

    return parseDockerOkResponse(value);
  },

  async prune({ targets = [], allImages = false }: DockerPruneOptions = {}) {
    const value: unknown = await api.post('/api/docker/prune', { targets, allImages });

    return parseDockerPruneResponse(value);
  },

  wsUrl(path: string): string {
    return api.wsUrl(path);
  },
};

/**
 * Общий API добавляет данные ответа к Error. Проверяем их форму, чтобы ошибка
 * сети или некорректный ответ сервера оставались обычным сообщением панели.
 */
export function dockerErrorMessage(error: unknown, fallback: string): string {
  if (typeof error !== 'object' || error === null) {
    return fallback;
  }

  if ('data' in error && typeof error.data === 'object' && error.data !== null) {
    if ('message' in error.data && typeof error.data.message === 'string' && error.data.message) {
      return error.data.message;
    }
  }

  if ('message' in error && typeof error.message === 'string' && error.message) {
    return error.message;
  }

  return fallback;
}
