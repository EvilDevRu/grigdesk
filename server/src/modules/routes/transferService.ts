import {
  parseRouteTransferBundle, RoutesEditorContractError,
} from '../../../../shared/pipeline/routesEditorContracts.ts';
import type { RouteTransitionDoc } from '../../../../shared/pipeline/routeDefinition.ts';
import type {
  DraftOperation, RouteDraft, RouteDraftContent, RouteTransferBundle,
} from '../../../../shared/pipeline/routesEditorContracts.ts';

import { RoutesEditorStoreError } from './draftStore.ts';

/** Собирает routeId, на которые ссылаются переходы и декларации эскалации. */
function referencedRoutes(content: RouteDraftContent): string[] {
  const references = new Set<string>();
  const machines = [content.bootstrap,
    ...Object.values(content.routes).map((bundle) => bundle.route)];
  for (const machine of machines) {
    for (const record of machine.escalation) {
      for (const routeId of record.allowedRoutes) references.add(routeId);
    }
    for (const node of machine.nodes) {
      for (const action of [
        ...Object.values(node.on ?? {}), ...Object.values(node.onFailure ?? {}),
      ]) {
        for (const routeId of action?.escalate?.routes ?? []) references.add(routeId);
      }
    }
  }
  return [...references].filter((id) => !Object.hasOwn(content.routes, id)).sort();
}

/** Выгружает полный каталог или один маршрут без служебных полей публикации. */
export function exportRouteTransfer(draft: RouteDraft,
  routeId: string | null = null): RouteTransferBundle {
  let content: RouteDraftContent = {
    routes: structuredClone(draft.routes),
    bootstrap: structuredClone(draft.bootstrap),
    bootstrapPrompts: structuredClone(draft.bootstrapPrompts),
    presentation: structuredClone(draft.presentation),
    provenance: structuredClone(draft.provenance),
  };
  if (routeId !== null) {
    const route = draft.routes[routeId];
    if (!route) {
      throw new RoutesEditorStoreError('routes_bad_request', 'Маршрут отсутствует');
    }
    content = {
      routes: { [routeId]: structuredClone(route) },
      bootstrap: {
        schema: 2, kind: 'bootstrap', profile: draft.profile, id: 'scout',
        entry: null, sequence: { bootstrap: [] }, nodes: [], escalation: [],
      },
      bootstrapPrompts: {},
      presentation: {},
      provenance: {},
    };
  }
  return {
    format: 'cockpit-route-authoring', schema: 1,
    sourceProfile: draft.profile,
    content,
    dependencies: routeId === null ? [] : referencedRoutes(content),
  };
}

/** Проверяет закрытый формат и согласованность объявленного источника. */
export function decodeRouteTransfer(value: unknown): RouteTransferBundle {
  const bundle = parseRouteTransferBundle(value);
  const machines = [bundle.content.bootstrap,
    ...Object.values(bundle.content.routes).map((entry) => entry.route)];
  if (machines.some((machine) => machine.profile !== bundle.sourceProfile)) {
    throw new RoutesEditorContractError('routeTransfer.sourceProfile');
  }
  const actual = referencedRoutes(bundle.content);
  if (bundle.dependencies.length && (actual.length !== bundle.dependencies.length
    || actual.some((id, index) => id !== bundle.dependencies[index]))) {
    throw new RoutesEditorContractError('routeTransfer.dependencies');
  }
  return bundle;
}

/** Меняет только профиль машин; внешние команды остаются данными для новой проверки. */
export function rebindRouteTransfer(bundle: RouteTransferBundle,
  targetProfile: string): RouteDraftContent {
  const content = structuredClone(bundle.content);
  content.bootstrap.profile = targetProfile;
  for (const entry of Object.values(content.routes)) {
    entry.route.profile = targetProfile;
  }
  return content;
}

/** Показывает цели, которых не хватает для выбранного целевого черновика. */
export function unresolvedRouteDependencies(bundle: RouteTransferBundle,
  target: RouteDraftContent): string[] {
  return bundle.dependencies.filter((id) => !Object.hasOwn(target.routes, id));
}

/** Готовит ровно одну typed-операцию добавления или замены маршрута. */
export function planSingleRouteImport(
  bundle: RouteTransferBundle,
  target: RouteDraft,
  collision: 'require-choice' | 'cancel' | 'replace' | 'rename',
  newRouteId?: string,
): { operations: DraftOperation[]; unresolvedDependencies: string[]; cancelled: boolean } {
  const routes = Object.entries(bundle.content.routes);
  if (routes.length !== 1) {
    throw new RoutesEditorStoreError('routes_bad_request',
      'Для добавления в черновик нужен экспорт одного маршрута');
  }
  const [sourceId, source] = routes[0]!;
  const existing = Object.hasOwn(target.routes, sourceId);
  if (collision === 'require-choice' && existing) {
    throw new RoutesEditorStoreError('routes_draft_conflict',
      'Маршрут с таким ID уже существует', { routeId: sourceId });
  }
  if (collision === 'cancel') {
    return { operations: [], unresolvedDependencies: [], cancelled: true };
  }
  if (collision === 'replace' && !existing) {
    throw new RoutesEditorStoreError('routes_bad_request', 'Маршрут для замены отсутствует');
  }
  const destination = collision === 'rename' ? newRouteId : sourceId;
  if (!destination || !/^[a-z0-9][a-z0-9_-]{0,40}$/.test(destination)
    || destination === 'catalog' || (collision === 'rename'
      && (destination === sourceId || Object.hasOwn(target.routes, destination)))) {
    throw new RoutesEditorStoreError('routes_bad_request', 'Недопустимый новый routeId');
  }
  const copied = structuredClone(source);
  copied.route.profile = target.profile;
  copied.route.id = destination;
  if (destination !== sourceId) {
    for (const record of copied.route.escalation) {
      record.allowedRoutes = record.allowedRoutes.map(
        (id) => id === sourceId ? destination : id,
      );
    }
    for (const node of copied.route.nodes) {
      const actions = [
        ...Object.values(node.on ?? {}), ...Object.values(node.onFailure ?? {}),
      ] as Array<RouteTransitionDoc | null>;
      for (const action of actions) {
        if (action?.escalate) {
          action.escalate.routes = action.escalate.routes.map(
            (id) => id === sourceId ? destination : id,
          );
        }
      }
    }
  }
  const future = { ...target.routes, [destination]: copied };
  return {
    operations: [{ kind: 'putRoute', routeId: destination,
      route: copied.route, prompts: copied.prompts }],
    unresolvedDependencies: bundle.dependencies.filter((id) => !Object.hasOwn(future, id)),
    cancelled: false,
  };
}
