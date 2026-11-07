import { isDeepStrictEqual } from 'node:util';

import type {
  RouteDraftContent,
  RouteRebaseConflict,
  RouteRebaseResolution,
} from '../../../../shared/pipeline/routesEditorContracts.ts';

import { RoutesEditorStoreError } from './draftStore.ts';

type RouteUnit = RouteDraftContent['routes'][string] | null;
type BootstrapUnit = { bootstrap: RouteDraftContent['bootstrap'];
  prompts: RouteDraftContent['bootstrapPrompts'] } | null;

function bootstrapUnit(document: RouteDraftContent | null): BootstrapUnit {
  return document ? { bootstrap: document.bootstrap, prompts: document.bootstrapPrompts } : null;
}

function chooseUnit<T>(scope: RouteRebaseConflict['scope'], routeId: string | null,
  base: T, mine: T, current: T, resolutions: Map<string, RouteRebaseResolution['choice']>,
  conflicts: RouteRebaseConflict[]): T {
  const mineChanged = !isDeepStrictEqual(base, mine);
  const currentChanged = !isDeepStrictEqual(base, current);
  if (mineChanged && currentChanged && !isDeepStrictEqual(mine, current)) {
    const key = `${scope}:${routeId ?? ''}`;
    const choice = resolutions.get(key);
    if (!choice) {
      conflicts.push({ scope, routeId, base: structuredClone(base),
        mine: structuredClone(mine), current: structuredClone(current) });
      return mine;
    }
    resolutions.delete(key);
    return choice === 'mine' ? mine : current;
  }
  return mineChanged ? mine : current;
}

/** Трёхстороннее сравнение целых маршрутов и bootstrap вместе с их промптами. */
export function planDraftRebase(base: RouteDraftContent | null,
  mine: RouteDraftContent, current: RouteDraftContent,
  choices: RouteRebaseResolution[]): { document: RouteDraftContent;
    conflicts: RouteRebaseConflict[] } {
  const resolutions = new Map<string, RouteRebaseResolution['choice']>();
  if (!Array.isArray(choices) || choices.length > 128) {
    throw new RoutesEditorStoreError('routes_bad_request', 'Слишком много разрешений rebase');
  }
  for (const choice of choices) {
    if (!choice || (choice.scope !== 'route' && choice.scope !== 'bootstrap')
      || Object.keys(choice).sort().join(',') !== 'choice,routeId,scope'
      || (choice.scope === 'bootstrap' && choice.routeId !== null)
      || (choice.scope === 'route' && (typeof choice.routeId !== 'string'
        || !/^[a-z0-9][a-z0-9_-]{0,40}$/.test(choice.routeId)))
      || (choice.choice !== 'mine' && choice.choice !== 'current')) {
      throw new RoutesEditorStoreError('routes_bad_request', 'Недопустимое разрешение rebase');
    }
    const key = `${choice.scope}:${choice.routeId ?? ''}`;
    if (resolutions.has(key)) {
      throw new RoutesEditorStoreError('routes_bad_request', 'Повторное разрешение rebase');
    }
    resolutions.set(key, choice.choice);
  }
  const conflicts: RouteRebaseConflict[] = [];
  const routes: RouteDraftContent['routes'] = {};
  const ids = new Set([
    ...Object.keys(base?.routes ?? {}), ...Object.keys(mine.routes),
    ...Object.keys(current.routes),
  ]);
  for (const routeId of [...ids].sort()) {
    const selected = chooseUnit<RouteUnit>('route', routeId,
      base?.routes[routeId] ?? null, mine.routes[routeId] ?? null,
      current.routes[routeId] ?? null, resolutions, conflicts);
    if (selected) routes[routeId] = structuredClone(selected);
  }
  const selectedBootstrap = chooseUnit<BootstrapUnit>('bootstrap', null,
    bootstrapUnit(base), bootstrapUnit(mine), bootstrapUnit(current),
    resolutions, conflicts);
  if (resolutions.size) {
    throw new RoutesEditorStoreError('routes_bad_request', 'Разрешение не относится к конфликту');
  }
  if (!selectedBootstrap) {
    throw new RoutesEditorStoreError('routes_bad_request', 'Нет начальной разведки');
  }
  return {
    document: {
      routes,
      bootstrap: structuredClone(selectedBootstrap.bootstrap),
      bootstrapPrompts: structuredClone(selectedBootstrap.prompts),
      presentation: structuredClone(mine.presentation),
      provenance: structuredClone(mine.provenance),
    },
    conflicts,
  };
}
