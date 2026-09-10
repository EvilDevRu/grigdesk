// Контракт раздела «Маршруты»: опубликованный каталог схем конвейера.
//
// Каталог неизменяем: попытка закрепляет его хеш и идёт по нему до конца. Поэтому
// здесь нет ни правки, ни удаления — только список ревизий, проверка, публикация и
// перевод указателя. Схему рисует тот же код, что и у живой задачи.

import { contractDecoders } from './contractDecoders.ts';

export class RoutesContractError extends Error {
  constructor(path: string) {
    super(`Некорректный ответ раздела маршрутов: поле ${path}`);
    this.name = 'RoutesContractError';
  }
}

const {
  boolean,
  listOf,
  mapOf,
  nullable,
  objectOf,
  oneOf,
  record,
  text,
} = contractDecoders((path) => {
  throw new RoutesContractError(path);
});

// Ревизия каталога. `routes` равен null у повреждённой ревизии: её показывают в
// списке вместе с причиной, а не прячут — откатиться на неё всё ещё можно.
const revision = objectOf({
  catalogHash: text,
  createdAt: text,
  isCurrent: boolean,
  routes: nullable(mapOf(text)),
  integrity: text,
});

const revisionList = objectOf({
  profile: text,
  publishSupported: boolean,
  currentCatalogHash: nullable(text),
  revisions: listOf(revision),
});

const profileList = objectOf({ profiles: listOf(text) });

// Схема маршрута строится сервером и разбирается компонентом схемы: своей формы у
// неё здесь нет, иначе она была бы объявлена в двух местах и разъехалась.
const graphResponse = objectOf({ graph: record });

// Итог публикации. `result` — вывод скрипта самого профиля: его формат принадлежит
// профилю, и объявлять его контрактом кокпита нельзя. Раздел читает из него ровно
// два необязательных поля и показывает остальное как есть.
const publishResponse = objectOf({
  profile: text,
  mode: oneOf('validate', 'publish'),
  result: record,
  currentCatalogHash: nullable(text),
});

export type RouteRevision = ReturnType<typeof revision>;
export type RouteRevisionList = ReturnType<typeof revisionList>;
export type RoutePublishResponse = ReturnType<typeof publishResponse>;

// Что раздел читает из ответа публикатора. Оба поля необязательны: скрипт профиля
// сам решает, что вернуть, и отсутствие поля — не отказ.
export interface PublishSummary {
  catalogCreated: boolean | null;
  catalogHash: string | null;
}

export function parseRouteRevisions(value: unknown): RouteRevisionList {
  return revisionList(value, 'routeRevisions');
}

export function parseRouteProfiles(value: unknown): string[] {
  return profileList(value, 'profiles').profiles;
}

export function parseRouteGraph(value: unknown): Record<string, unknown> {
  return graphResponse(value, 'routeGraph').graph;
}

export function parseRoutePublish(value: unknown): RoutePublishResponse {
  return publishResponse(value, 'routePublish');
}

/**
 * Достаёт из вывода публикатора то, о чём раздел говорит человеку. Значения читаются
 * по одному: «ревизия не изменилась» и «неизвестно» — разные ответы, и подменять
 * второе первым значило бы сообщать о результате, которого не было.
 */
export function publishSummary(result: Record<string, unknown>): PublishSummary {
  return {
    catalogCreated: typeof result.catalogCreated === 'boolean' ? result.catalogCreated : null,
    catalogHash: typeof result.catalogHash === 'string' ? result.catalogHash : null,
  };
}
