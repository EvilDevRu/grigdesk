import { ROUTES_EDITOR_LIMITS } from '../../../../shared/pipeline/routesEditorContracts.ts';
import type { RouteDraft } from '../../../../shared/pipeline/routesEditorContracts.ts';
import type { DraftNode, RouteTransitionDoc } from '../../../../shared/pipeline/routeDefinition.ts';

export interface CatalogCommandIssue {
  code: string;
  message: string;
  path?: string;
}
export interface CatalogCommandResult {
  draft: RouteDraft;
  issues: CatalogCommandIssue[];
}

const ROUTE_ID = /^[a-z0-9][a-z0-9_-]{0,40}$/;

function rejected(draft: RouteDraft, code: string, message: string): CatalogCommandResult {
  return { draft, issues: [{ code, message }] };
}

function newIdAllowed(draft: RouteDraft, routeId: string, adding = true): boolean {
  return ROUTE_ID.test(routeId) && !Object.hasOwn(draft.routes, routeId)
    && (!adding || Object.keys(draft.routes).length < ROUTES_EDITOR_LIMITS.routes);
}

interface RouteReference {
  target: string;
  path: string;
  set: (value: string) => void;
}

/**
 * Обходит ссылки на маршруты во всех графах каталога.
 * Команда возвращает новый документ или объяснимую ошибку без мутации исходного.
 */
function eachRouteReference(draft: RouteDraft, visit: (reference: RouteReference) => void): void {
  const machines = [{ path: '/bootstrap', machine: draft.bootstrap },
    ...Object.entries(draft.routes).map(([routeId, bundle]) => ({
      path: `/routes/${routeId}/route`, machine: bundle.route,
    }))];

  for (const { path, machine } of machines) {
    for (const [index, escalation] of machine.escalation.entries()) {
      escalation.allowedRoutes.forEach((target, targetIndex) => visit({
        target,
        path: `${path}/escalation/${index}/allowedRoutes/${targetIndex}`,
        set: (value) => {
           escalation.allowedRoutes[targetIndex] = value;
        }
      }));
    }
    for (const [nodeIndex, node] of machine.nodes.entries()) {
      for (const groupName of ['on', 'onFailure'] as const) {
        for (const [outcome, transition] of Object.entries(node[groupName] ?? {})) {
          transition?.escalate?.routes.forEach((target, targetIndex) => visit({
            target,
            path: `${path}/nodes/${nodeIndex}/${groupName}/${outcome}/escalate/routes/${targetIndex}`,
            set: (value) => {
               transition.escalate!.routes[targetIndex] = value;
            }
          }));
        }
      }
    }
  }
}

/**
 * Собирает места использования удаляемого маршрута.
 * Команда возвращает новый документ или объяснимую ошибку без мутации исходного.
 */
export function inspectRouteReferences(draft: RouteDraft, routeId: string): CatalogCommandIssue[] {
  const references: CatalogCommandIssue[] = [];

  eachRouteReference(draft, ({ target, path }) => {
    if (target === routeId) {
      references.push({
        code: 'route_reference',
        path,
      message: `Ссылка на маршрут «${routeId}» требует решения.`
      });
    }
  });

  return references;
}

/**
 * Добавляет маршрут с проверкой идентификатора и ограничений.
 * Команда возвращает новый документ или объяснимую ошибку без мутации исходного.
 */
export function createRoute(draft: RouteDraft, routeId: string,
  title = ''): CatalogCommandResult {
  if (!newIdAllowed(draft, routeId)) {
    return rejected(draft, 'route_id_invalid', 'ID маршрута занят, недопустим или превышен лимит.');
  }

  const copy = structuredClone(draft);

  copy.routes[routeId] = { route: {
    schema: 2,
    kind: 'route',
    profile: draft.profile,
    id: routeId,
    title,
    entry: null,
    sequence: { main: [], tail: [] },
    nodes: [],
    escalation: [],
  }, prompts: {} };

  return { draft: copy, issues: [] };
}

/**
 * Создаёт независимую копию маршрута и его промптов.
 * Команда возвращает новый документ или объяснимую ошибку без мутации исходного.
 */
export function cloneRoute(draft: RouteDraft, sourceId: string,
  newId: string): CatalogCommandResult {
  const source = draft.routes[sourceId];

  if (!source) {
    return rejected(draft, 'route_missing', 'Маршрут для копирования не найден.');
  }
  if (!newIdAllowed(draft, newId)) {
    return rejected(draft, 'route_id_invalid', 'ID маршрута занят, недопустим или превышен лимит.');
  }

  const copy = structuredClone(draft);

  copy.routes[newId] = structuredClone(source);
  copy.routes[newId].route.id = newId;

  return { draft: copy, issues: [] };
}

/**
 * Переименовывает маршрут и обновляет входящие ссылки.
 * Команда возвращает новый документ или объяснимую ошибку без мутации исходного.
 */
export function renameRoute(draft: RouteDraft, from: string,
  to: string): CatalogCommandResult {
  if (!draft.routes[from]) {
    return rejected(draft, 'route_missing', 'Маршрут не найден.');
  }
  if (!newIdAllowed(draft, to, false)) {
    return rejected(draft, 'route_id_invalid', 'Новый ID занят или недопустим.');
  }

  const copy = structuredClone(draft);

  copy.routes[to] = copy.routes[from]!;
  delete copy.routes[from];
  copy.routes[to]!.route.id = to;
  eachRouteReference(copy, (reference) => {
    if (reference.target === from) {
      reference.set(to);
    }
  });

  for (const [key, value] of Object.entries(copy.presentation)) {
    if (key.startsWith(`r:${from}:`)) {
      copy.presentation[`r:${to}:${key.slice(from.length + 3)}`] = value;
      delete copy.presentation[key];
    }
  }

  return { draft: copy, issues: [] };
}

/**
 * Удаляет маршрут после проверки использующих его переходов.
 * Команда возвращает новый документ или объяснимую ошибку без мутации исходного.
 */
export function removeRoute(draft: RouteDraft, routeId: string): CatalogCommandResult {
  if (!draft.routes[routeId]) {
    return rejected(draft, 'route_missing', 'Маршрут не найден.');
  }

  const copy = structuredClone(draft);

  delete copy.routes[routeId];

  for (const key of Object.keys(copy.presentation)) {
    if (key.startsWith(`r:${routeId}:`)) {
      delete copy.presentation[key];
    }
  }

  return { draft: copy, issues: inspectRouteReferences(copy, routeId) };
}

/**
 * Копирует узлы между маршрутами и выделяет новые ключи запуска.
 * Команда возвращает новый документ или объяснимую ошибку без мутации исходного.
 */
export function copyNodesFromRoute(draft: RouteDraft, sourceId: string,
  targetId: string, nodeIds: string[],
  allocateRunKey: (suggested: string, used: ReadonlySet<string>) => string): CatalogCommandResult {
  const source = draft.routes[sourceId];
  const destination = draft.routes[targetId];

  if (!source || !destination || sourceId === targetId) {
    return rejected(draft, 'route_missing', 'Выберите два разных существующих маршрута.');
  }

  const selected = new Set(nodeIds);

  if (!selected.size || selected.size !== nodeIds.length
    || nodeIds.some((id) => !source.route.nodes.some((node) => node.id === id))) {
    return rejected(draft, 'node_missing', 'Выбранные этапы не найдены или повторены.');
  }
  if (destination.route.nodes.length + nodeIds.length > ROUTES_EDITOR_LIMITS.nodes) {
    return rejected(draft, 'node_limit', 'Превышен лимит этапов маршрута.');
  }

  const usedKeys = new Set(destination.route.nodes.map((node) => node.runKey ?? node.key ?? ''));
  const usedIds = new Set(destination.route.nodes.map((node) => node.id));
  const mapping = new Map<string, { id: string; key: string }>();

  for (const id of nodeIds) {
    const node = source.route.nodes.find((item) => item.id === id)!;

    if (node.executor === 'status' && !selected.has(node.owner ?? '')) {
      return rejected(draft, 'owner_external', 'Для статуса выберите и его владельца.');
    }

    const key = allocateRunKey(node.runKey ?? node.key ?? id.toUpperCase(), usedKeys);
    const nextId = key.toLowerCase();

    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(key) || !ROUTE_ID.test(nextId)
      || usedKeys.has(key) || usedIds.has(nextId)) {
      return rejected(draft, 'node_id_conflict', 'Ключ копии уже занят или недопустим.');
    }

    usedKeys.add(key);
    usedIds.add(nextId);
    mapping.set(id, { id: nextId, key });
  }

  const copy = structuredClone(draft);
  const target = copy.routes[targetId]!;
  const issues: CatalogCommandIssue[] = [];
  const copiedFiles = new Map<string, string>();
  const usedFiles = new Set(Object.keys(target.prompts));
  const external = (path: string, value: string): void => {
    issues.push({
      code: 'external_reference',
      path,
      message: `Связь с этапом «${value}» вне копируемой группы оставлена незаполненной.`
    });
  };

  for (const sourceNode of source.route.nodes.filter((node) => selected.has(node.id))) {
    const mapped = mapping.get(sourceNode.id)!;
    const node = structuredClone(sourceNode) as DraftNode;

    node.id = mapped.id;

    if (node.executor === 'status') {
      node.key = mapped.key;
    }
    else {
      node.runKey = mapped.key;
    }
    if (node.owner) {
      node.owner = mapping.get(node.owner)!.id;
    }

    node.emits = node.emits?.flatMap((id) => {
      const linked = mapping.get(id);

      if (linked) {
        return [linked.id];
      }

      external(`nodes.${mapped.id}.emits`, id);

      return [];
    });

    for (const groupName of ['on', 'onFailure'] as const) {
      const group = node[groupName];

      if (!group) {
        continue;
      }

      for (const [outcome, transition] of Object.entries(group)) {
        if (!transition) {
          continue;
        }

        const path = `nodes.${mapped.id}.${groupName}.${outcome}`;
        let incomplete = false;

        for (const field of ['next', 'rewind'] as const) {
          const linkedId = transition[field];

          if (!linkedId) {
            continue;
          }

          const linked = mapping.get(linkedId);

          if (linked) {
            transition[field] = linked.id;
          }
          else { external(`${path}.${field}`, linkedId); incomplete = true; }
        }

        if (transition.reset) {
          const outside = transition.reset.filter((id) => !mapping.has(id));

          for (const id of outside) {
            external(`${path}.reset`, id);
          }

          if (outside.length) {
            incomplete = true;
          }
          else {
            transition.reset = transition.reset.map((id) => mapping.get(id)!.id);
          }
        }
        if (incomplete) {
          group[outcome] = null;
        }
      }
    }
    for (const [index, block] of (node.prompt?.blocks ?? []).entries()) {
      let file = copiedFiles.get(block.file);

      if (!file) {
        const base = `prompts/${mapped.id}.${index + 1}`;

        file = `${base}.md`;

        let suffix = 2;

        while (usedFiles.has(file)) {
          file = `${base}.${suffix++}.md`;
        }

        usedFiles.add(file);
        copiedFiles.set(block.file, file);
        target.prompts[file] = source.prompts[block.file] ?? '';
      }

      block.file = file;
    }

    target.route.nodes.push(node);

    if (node.executor !== 'status') {
      const phase = node.phase === 'tail' ? 'tail' : 'main';

      node.phase = phase;
      target.route.sequence[phase] ??= [];
      target.route.sequence[phase]!.push(node.id);

      if (target.route.entry === null) {
        target.route.entry = node.id;
      }
    }
  }
  for (const escalation of source.route.escalation.filter((item) => selected.has(item.from))) {
    const next = structuredClone(escalation);

    next.from = mapping.get(escalation.from)!.id;
    target.route.escalation.push(next);

    for (const routeId of next.allowedRoutes) {
      if (routeId !== targetId) {
        issues.push({
          code: 'external_route_reference',
          path: `escalation.${next.from}.allowedRoutes`,
          message: `Копия зависит от другого маршрута «${routeId}».`
        });
      }
    }
  }

  return { draft: copy, issues };
}

/**
 * Обновляет название, вход и политику bootstrap маршрута.
 * Команда возвращает новый документ или объяснимую ошибку без мутации исходного.
 */
export function setRouteProperties(draft: RouteDraft, routeId: string,
  options: {
    title: string;
    bootstrap: '' | 'required' | 'skip';
    entry: string
  }): CatalogCommandResult {
  const bundle = draft.routes[routeId];

  if (!bundle) {
    return rejected(draft, 'route_missing', 'Маршрут не найден.');
  }
  if (options.title.length > 500 || (options.entry && !bundle.route.nodes.some((node) =>
    node.id === options.entry && node.executor !== 'status'))) {
    return rejected(draft, 'route_properties_invalid', 'Название или начальный этап недопустимы.');
  }

  const copy = structuredClone(draft);
  const route = copy.routes[routeId]!.route;

  route.title = options.title;
  route.entry = options.entry || null;

  if (options.bootstrap) {
    route.bootstrap = options.bootstrap;
  }
  else {
    delete route.bootstrap;
  }

  return { draft: copy, issues: [] };
}
