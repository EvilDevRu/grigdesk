import {
  parseRouteDraft,
  ROUTES_EDITOR_LIMITS,
} from '../../../../shared/routesEditorContracts.ts';
import type {
  DraftOperation,
  RouteDraft,
  RouteEditorIssue,
} from '../../../../shared/routesEditorContracts.ts';
import type { DraftMachine, RouteTransitionDoc } from '../../../../shared/routeDefinition.ts';

import { assertProfileId, assertRouteId } from './schema.ts';
import type { StoredCatalog, StoredRoute } from './store.ts';

export interface RuntimeCatalogInput {
  profile: string;
  routes: Record<string, { route: DraftMachine; prompts: Record<string, string> }>;
  bootstrap: DraftMachine;
  bootstrapPrompts: Record<string, string>;
}

export interface CatalogBundleSet {
  catalog: StoredCatalog;
  routes: Record<string, StoredRoute>;
}

export interface DraftFromCatalogMeta {
  id: string;
  title: string;
  baseSourceRevision: number;
  createdAt: string;
}

export type RuntimeCatalogResult =
  | { ok: true; input: RuntimeCatalogInput }
  | { ok: false; issues: RouteEditorIssue[] };

// Символьные классы совпадают с действующей server/schema; семантика связей
// проверяется отдельно, поэтому незавершённый документ остаётся сохраняемым.
const ENTITY_ID_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const RUN_KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const PROMPT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,40}(?:\.[a-z0-9][a-z0-9_-]{0,40})*$/;

export class RoutesEditorModelError extends Error {
  readonly code: 'routes_bad_request' | 'routes_payload_too_large';

  readonly path: string;

  constructor(
    code: 'routes_bad_request' | 'routes_payload_too_large',
    path: string,
  ) {
    super(`${code}: ${path}`);
    this.name = 'RoutesEditorModelError';
    this.code = code;
    this.path = path;
  }
}

function idAt(value: string, pattern: RegExp, path: string): void {
  if (!pattern.test(value)) {
    throw new RoutesEditorModelError('routes_bad_request', path);
  }
}

function promptPathAt(value: string, prefix: string, path: string): void {
  if (!value.startsWith(prefix) || !value.endsWith('.md')) {
    throw new RoutesEditorModelError('routes_bad_request', path);
  }

  const name = value.slice(prefix.length, -3);
  if (!PROMPT_NAME_RE.test(name) || value !== `${prefix}${name}.md`) {
    throw new RoutesEditorModelError('routes_bad_request', path);
  }
}

function transitionIdsAt(transition: RouteTransitionDoc | null, path: string): void {
  if (transition === null) {
    return;
  }
  if (transition.next !== undefined) {
    idAt(transition.next, ENTITY_ID_RE, `${path}.next`);
  }
  if (transition.rewind !== undefined) {
    idAt(transition.rewind, ENTITY_ID_RE, `${path}.rewind`);
    transition.reset?.forEach((id, index) => {
      idAt(id, ENTITY_ID_RE, `${path}.reset[${index}]`);
    });
  }
  transition.escalate?.routes.forEach((id, index) => {
    assertRouteId(id, `${path}.escalate.routes[${index}]`);
  });
}

/**
 * Проверяет безопасные идентификаторы и логические имена файлов без требования
 * полной достижимости или существования каждой ссылки в черновике.
 */
function shapeMachine(
  machine: DraftMachine,
  prompts: Record<string, string>,
  prefix: string,
  path: string,
): void {
  idAt(machine.id, ENTITY_ID_RE, `${path}.id`);
  if (machine.nodes.length > ROUTES_EDITOR_LIMITS.nodes) {
    throw new RoutesEditorModelError('routes_payload_too_large', `${path}.nodes`);
  }
  if (machine.entry !== null) {
    idAt(machine.entry, ENTITY_ID_RE, `${path}.entry`);
  }
  for (const [phase, ids] of Object.entries(machine.sequence)) {
    ids?.forEach((id, index) => {
      idAt(id, ENTITY_ID_RE, `${path}.sequence.${phase}[${index}]`);
    });
  }
  machine.escalation.forEach((record, index) => {
    idAt(record.from, ENTITY_ID_RE, `${path}.escalation[${index}].from`);
    record.allowedRoutes.forEach((routeId, targetIndex) => {
      assertRouteId(routeId, `${path}.escalation[${index}].allowedRoutes[${targetIndex}]`);
    });
  });

  let promptBytes = 0;
  for (const [file, text] of Object.entries(prompts)) {
    promptPathAt(file, prefix, `${path}.prompts.${file}`);
    const bytes = Buffer.byteLength(text);
    if (bytes > ROUTES_EDITOR_LIMITS.promptFileBytes) {
      throw new RoutesEditorModelError('routes_payload_too_large', `${path}.prompts.${file}`);
    }
    promptBytes += bytes;
  }
  if (promptBytes > ROUTES_EDITOR_LIMITS.promptBundleBytes) {
    throw new RoutesEditorModelError('routes_payload_too_large', `${path}.prompts`);
  }
  machine.nodes.forEach((node, index) => {
    const nodePath = `${path}.nodes[${index}]`;
    idAt(node.id, ENTITY_ID_RE, `${nodePath}.id`);
    if (node.runKey !== undefined) {
      idAt(node.runKey, RUN_KEY_RE, `${nodePath}.runKey`);
    }
    if (node.key !== undefined) {
      idAt(node.key, RUN_KEY_RE, `${nodePath}.key`);
    }
    if (node.owner !== undefined) {
      idAt(node.owner, ENTITY_ID_RE, `${nodePath}.owner`);
    }
    node.emits?.forEach((id, emittedIndex) => {
      idAt(id, ENTITY_ID_RE, `${nodePath}.emits[${emittedIndex}]`);
    });
    if (node.commandId !== undefined && node.commandId !== '') {
      idAt(node.commandId, ENTITY_ID_RE, `${nodePath}.commandId`);
    }
    if ((node.prompt?.blocks.length ?? 0) > ROUTES_EDITOR_LIMITS.promptBlocks) {
      throw new RoutesEditorModelError('routes_payload_too_large', `${nodePath}.prompt.blocks`);
    }
    for (const [blockIndex, block] of (node.prompt?.blocks ?? []).entries()) {
      promptPathAt(block.file, prefix, `${nodePath}.prompt.blocks[${blockIndex}].file`);
    }
    for (const channel of ['on', 'onFailure'] as const) {
      for (const [outcome, transition] of Object.entries(node[channel] ?? {})) {
        transitionIdsAt(transition, `${nodePath}.${channel}.${outcome}`);
      }
    }
  });
}

function pointer(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

/**
 * Отмечает незаполненные поля, сохраняя точный путь до редактора.
 * Эти случаи допустимы при сохранении и блокируют только публикацию.
 */
function incompleteIssues(
  machine: DraftMachine,
  prompts: Record<string, string>,
  knownRoutes: Set<string>,
  scope: 'route' | 'bootstrap',
  routeId: string | null,
  basePath: string,
): RouteEditorIssue[] {
  const issues: RouteEditorIssue[] = [];

  const addIssue = (code: string, nodeId: string | null, path: string, message: string) => {
    issues.push({
      code,
      severity: 'error',
      scope,
      routeId,
      nodeId,
      path,
      message,
    });
  };

  if (machine.entry === null) {
    addIssue('entry_required', null, `${basePath}/entry`, 'Выберите начальный этап');
  }

  machine.escalation.forEach((record, index) => {
    record.allowedRoutes.forEach((target, targetIndex) => {
      if (!knownRoutes.has(target)) {
        addIssue(
          'route_reference_missing',
          record.from,
          `${basePath}/escalation/${index}/allowedRoutes/${targetIndex}`,
          `Маршрут «${target}» отсутствует в черновике каталога`,
        );
      }
    });
  });

  for (const [file, text] of Object.entries(prompts)) {
    if (text.trim().length === 0) {
      addIssue('prompt_required', null, `${basePath.replace(/\/route$/, '')}/prompts/${pointer(file)}`,
        'Заполните инструкцию');
    }
  }

  machine.nodes.forEach((node, index) => {
    for (const channel of ['on', 'onFailure'] as const) {
      for (const [outcome, transition] of Object.entries(node[channel] ?? {})) {
        if (transition === null) {
          addIssue(
            'transition_required',
            node.id,
            `${basePath}/nodes/${index}/${channel}/${pointer(outcome)}`,
            'Выберите переход',
          );
        }
        transition?.escalate?.routes.forEach((target, targetIndex) => {
          if (!knownRoutes.has(target)) {
            addIssue(
              'route_reference_missing',
              node.id,
              `${basePath}/nodes/${index}/${channel}/${pointer(outcome)}/escalate/routes/${targetIndex}`,
              `Маршрут «${target}» отсутствует в черновике каталога`,
            );
          }
        });
      }
    }
  });

  return issues;
}

export function validateDraftShape(value: unknown): RouteDraft {
  const serialized = JSON.stringify(value);
  if (serialized !== undefined
    && Buffer.byteLength(serialized) > ROUTES_EDITOR_LIMITS.draftBytes) {
    throw new RoutesEditorModelError('routes_payload_too_large', 'draft');
  }

  const draft = parseRouteDraft(value);
  assertProfileId(draft.profile);

  if (Object.keys(draft.routes).length > ROUTES_EDITOR_LIMITS.routes) {
    throw new RoutesEditorModelError('routes_payload_too_large', 'routes');
  }

  for (const [routeId, bundle] of Object.entries(draft.routes)) {
    assertRouteId(routeId);
    if (bundle.route.profile !== draft.profile || bundle.route.id !== routeId
      || bundle.route.kind !== 'route') {
      throw new RoutesEditorModelError('routes_bad_request', `routes.${routeId}.route`);
    }
    shapeMachine(bundle.route, bundle.prompts, 'prompts/', `routes.${routeId}.route`);
  }
  if (draft.bootstrap.profile !== draft.profile || draft.bootstrap.id !== 'scout'
    || draft.bootstrap.kind !== 'bootstrap') {
    throw new RoutesEditorModelError('routes_bad_request', 'bootstrap');
  }
  shapeMachine(draft.bootstrap, draft.bootstrapPrompts, 'bootstrap/prompts/', 'bootstrap');

  return draft;
}

/**
 * Применяет закрытый набор команд к копии документа. Ошибка любой команды
 * уничтожает только эту копию, исходный черновик остаётся прежним.
 */
export function applyDraftOperations(draft: RouteDraft, operations: DraftOperation[]): RouteDraft {
  if (!Array.isArray(operations)) {
    throw new Error('operations: ожидался массив');
  }
  if (operations.length > ROUTES_EDITOR_LIMITS.operations) {
    throw new RoutesEditorModelError('routes_payload_too_large', 'operations');
  }
  if (Buffer.byteLength(JSON.stringify(operations)) > ROUTES_EDITOR_LIMITS.patchBytes) {
    throw new RoutesEditorModelError('routes_payload_too_large', 'operations');
  }

  const result = structuredClone(draft);
  const allowedKeys: Record<DraftOperation['kind'], readonly string[]> = {
    setTitle: ['kind', 'title'],
    putRoute: ['kind', 'routeId', 'route', 'prompts'],
    removeRoute: ['kind', 'routeId'],
    putBootstrap: ['kind', 'bootstrap', 'prompts'],
    putPresentation: ['kind', 'presentation'],
    putProvenance: ['kind', 'provenance'],
  };

  for (const operation of operations) {
    if (operation === null || typeof operation !== 'object') {
      throw new Error('operations: недопустимая операция');
    }
    const allowed = allowedKeys[operation.kind];
    if (!allowed) {
      throw new RoutesEditorModelError('routes_bad_request', 'operations.kind');
    }
    for (const key of Object.keys(operation)) {
      if (!allowed.includes(key)) {
        throw new RoutesEditorModelError('routes_bad_request', `operations.${key}`);
      }
    }
    for (const key of allowed) {
      if (!Object.hasOwn(operation, key)) {
        throw new RoutesEditorModelError('routes_bad_request', `operations.${key}`);
      }
    }

    switch (operation.kind) {
      case 'setTitle': {
        result.title = operation.title;
        break;
      }
      case 'putRoute': {
        assertRouteId(operation.routeId, 'operations.routeId');
        result.routes[operation.routeId] = {
          route: structuredClone(operation.route),
          prompts: structuredClone(operation.prompts),
        };
        break;
      }
      case 'removeRoute': {
        assertRouteId(operation.routeId, 'operations.routeId');
        delete result.routes[operation.routeId];
        break;
      }
      case 'putBootstrap': {
        result.bootstrap = structuredClone(operation.bootstrap);
        result.bootstrapPrompts = structuredClone(operation.prompts);
        break;
      }
      case 'putPresentation': {
        result.presentation = structuredClone(operation.presentation);
        break;
      }
      case 'putProvenance': {
        result.provenance = structuredClone(operation.provenance);
        break;
      }
      default: {
        throw new Error('operations: неизвестная операция');
      }
    }
  }

  return validateDraftShape(result);
}

export function toRuntimeCatalogInput(draft: RouteDraft): RuntimeCatalogResult {
  const issues: RouteEditorIssue[] = [];
  const knownRoutes = new Set(Object.keys(draft.routes));

  if (knownRoutes.size === 0) {
    issues.push({
      code: 'catalog_empty',
      severity: 'error',
      scope: 'catalog',
      routeId: null,
      nodeId: null,
      path: '/routes',
      message: 'Добавьте хотя бы один маршрут',
    });
  }

  for (const [routeId, bundle] of Object.entries(draft.routes)) {
    issues.push(...incompleteIssues(
      bundle.route,
      bundle.prompts,
      knownRoutes,
      'route',
      routeId,
      `/routes/${pointer(routeId)}/route`,
    ));
  }
  issues.push(...incompleteIssues(
    draft.bootstrap,
    draft.bootstrapPrompts,
    knownRoutes,
    'bootstrap',
    null,
    '/bootstrap',
  ));

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    input: structuredClone({
      profile: draft.profile,
      routes: draft.routes,
      bootstrap: draft.bootstrap,
      bootstrapPrompts: draft.bootstrapPrompts,
    }),
  };
}

export function draftFromCatalog(
  bundleSet: CatalogBundleSet,
  meta: DraftFromCatalogMeta,
): RouteDraft {
  const routes: RouteDraft['routes'] = {};

  for (const [routeId, routeHash] of Object.entries(bundleSet.catalog.catalog.routes)) {
    const bundle = bundleSet.routes[routeId];
    if (!bundle || bundle.routeHash !== routeHash) {
      throw new RoutesEditorModelError('routes_bad_request', `routes.${routeId}`);
    }
    routes[routeId] = {
      route: structuredClone(bundle.route),
      prompts: structuredClone(bundle.prompts),
    };
  }

  return validateDraftShape({
    schema: 1,
    id: meta.id,
    profile: bundleSet.catalog.catalog.profile,
    title: meta.title,
    revision: 1,
    baseCatalogHash: bundleSet.catalog.catalogHash,
    baseSourceRevision: meta.baseSourceRevision,
    routes,
    bootstrap: structuredClone(bundleSet.catalog.bootstrap),
    bootstrapPrompts: structuredClone(bundleSet.catalog.prompts),
    presentation: {},
    provenance: {},
    state: 'editing',
    createdAt: meta.createdAt,
    updatedAt: meta.createdAt,
    publication: null,
  });
}
