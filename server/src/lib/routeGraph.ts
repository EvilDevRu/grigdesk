// Форма графа route-задачи из ЗАКРЕПЛЁННОГО каталога попытки. Построитель общий с холстом
// редактора и живёт в shared/routeGraphView.ts; сервер добавляет подписи из своего каталога
// стадий, чтобы узел без label назывался так же, как в остальном кокпите.
import { resolveNode } from './stages.ts';
import { buildRouteGraph } from '../../../shared/routeGraphView.ts';
import type { RouteGraphDef, RouteMachine } from '../../../shared/routeGraphView.ts';

export type {
  RouteGraphDef,
  RouteGraphEdge,
  RouteGraphNodeOrigin,
  RouteGraphTransition,
  RouteMachine,
  RouteMachineNode,
  RouteTransition,
} from '../../../shared/routeGraphView.ts';

/**
 * Строит форму графа по машине маршрута и, если передана, разведке его каталога.
 * `opts.workspaceMode === 'shared'` убирает ромб песочницы: стенд там чужой и постоянный.
 */
export function buildRouteDef(
  machine: RouteMachine,
  route: string,
  opts: { workspaceMode?: string; bootstrap?: RouteMachine } = {},
): RouteGraphDef {
  return buildRouteGraph(machine, route, {
    ...opts,
    labelOf: (id) => resolveNode(id, null)[1],
    sandboxNode: resolveNode('sandbox', null),
  });
}

/**
 * Карта статусов этапов route-задачи ИЗ РЕЕСТРА: после инициализации со скелетом
 * бандла реестр содержит ровно узлы маршрута, порядок ключей = порядок файла =
 * последовательность машины. Никаких захардкоженных списков этапов.
 */
export function routeStageKeys(registry: Record<string, string>): string[] {
  const STATUSES = new Set(['pending', 'running', 'done', 'waiting', 'skipped', 'failed']);
  const META = new Set(['WF_STATUS', 'NEEDS_RUN', 'STALLED_HUMAN']);
  return Object.entries(registry)
    .filter(([key, value]) => STATUSES.has(value)
      && /^[A-Z][A-Z0-9_]{1,63}$/.test(key)
      && !META.has(key)
      && !key.endsWith('_DECISION')
      && !key.endsWith('_AT'))
    .map(([key]) => key);
}
