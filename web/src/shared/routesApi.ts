// Транспорт раздела «Маршруты».
//
// Каталог неизменяем, поэтому у раздела всего четыре операции: прочитать ревизии,
// показать схему, проверить/опубликовать и перевести указатель. Обе мутации несут
// ожидаемый хеш: без него параллельная публикация была бы молча затёрта.

import { parseFactoryGraph } from '../../../shared/factoryGraphContracts.ts';
import type { FactoryGraphData } from '../../../shared/factoryGraphContracts.ts';
import {
  parseRouteGraph,
  parseRoutePublish,
  parseRouteProfiles,
  parseRouteRevisions,
} from '../../../shared/routesContracts.ts';
import type { RoutePublishResponse, RouteRevisionList } from '../../../shared/routesContracts.ts';
import { api } from './apiClient.ts';

function profilePath(profile: string): string {
  return `/api/routes/${encodeURIComponent(profile)}`;
}

export const routesApi = {
  async profiles(): Promise<string[]> {
    const value: unknown = await api.get('/api/profiles');

    return parseRouteProfiles(value);
  },

  async revisions(profile: string): Promise<RouteRevisionList> {
    const value: unknown = await api.get(`${profilePath(profile)}/revisions`);

    return parseRouteRevisions(value);
  },

  /**
   * Схема опубликованного маршрута. `?c=<хеш каталога>` обязателен: когда-то схема
   * отдавалась immutable, и браузер до сих пор может держать тот старый ответ по
   * голому пути — иной query промахивается мимо его кеша.
   */
  async graph(
    profile: string,
    routeId: string,
    routeHash: string,
    catalogHash: string | null,
  ): Promise<FactoryGraphData> {
    const path = `${profilePath(profile)}/routes/${encodeURIComponent(routeId)}`
      + `/${encodeURIComponent(routeHash)}/graph?c=${encodeURIComponent(catalogHash ?? '')}`;
    const value: unknown = await api.get(path);

    return parseFactoryGraph(parseRouteGraph(value), 'routeGraph.graph');
  },

  async publish(
    profile: string,
    mode: 'validate' | 'publish',
    expectedCatalogHash: string | null,
  ): Promise<RoutePublishResponse> {
    const body = mode === 'publish' ? { mode, expectedCatalogHash } : { mode };
    const value: unknown = await api.post(`${profilePath(profile)}/publish`, body);

    return parseRoutePublish(value);
  },

  async rollback(
    profile: string,
    desiredCatalogHash: string,
    expectedCatalogHash: string | null,
  ): Promise<void> {
    await api.put(`${profilePath(profile)}/current`, {
      desiredCatalogHash,
      expectedCatalogHash,
    });
  },
};
