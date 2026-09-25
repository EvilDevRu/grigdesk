import type {
  RouteDraft,
  RouteEditorIssue,
} from '../../../../shared/routesEditorContracts.ts';
import type {
  DraftMachine,
} from '../../../../shared/routeDefinition.ts';

import { toRuntimeCatalogInput, validateDraftShape } from './draftModel.ts';
import {
  RoutesError,
  validateBootstrap,
  validatePromptFiles,
  validateRoute,
} from './schema.ts';

export interface DraftValidationReport {
  draftId: string;
  draftRevision: number;
  capabilitiesHash: string | null;
  issues: RouteEditorIssue[];
}

const pointer = (value: string) => value.replace(/~/g, '~0').replace(/\//g, '~1');

function issue(
  code: string,
  scope: 'catalog' | 'bootstrap' | 'route',
  routeId: string | null,
  nodeId: string | null,
  path: string,
  message: string,
): RouteEditorIssue {
  return { code, severity: 'error', scope, routeId, nodeId, path, message };
}

/**
 * Дополняет адрес prompt-файла стабильным ID узла, чтобы фокус пережил
 * перестановку массива nodes в графическом редакторе.
 */
function promptOwner(draft: RouteDraft, item: RouteEditorIssue): RouteEditorIssue {
  if (item.code !== 'prompt_required') return item;
  const machine = item.scope === 'bootstrap'
    ? draft.bootstrap : draft.routes[item.routeId ?? '']?.route;
  const escapedFile = item.path.split('/').at(-1) ?? '';
  const file = escapedFile.replace(/~1/g, '/').replace(/~0/g, '~');
  const owner = machine?.nodes.find((node) => (
    node.executor === 'agent' && node.prompt?.blocks.some((block) => block.file === file)
  ));
  return owner ? { ...item, nodeId: owner.id } : item;
}

/**
 * Собирает независимые ошибки переходов до строгой проверки машины: один
 * незаполненный исход не должен скрыть неверный reset или цель другого исхода.
 */
function transitionIssues(
  machine: DraftMachine,
  scope: 'route' | 'bootstrap',
  routeId: string | null,
  basePath: string,
): RouteEditorIssue[] {
  const issues: RouteEditorIssue[] = [];
  const nodes = new Map(machine.nodes.map((node) => [node.id, node]));
  const order = Object.values(machine.sequence).flat();

  for (const [index, node] of machine.nodes.entries()) {
    if (node.executor === 'status') continue;
    for (const channel of ['on', 'onFailure'] as const) {
      for (const [outcome, transition] of Object.entries(node[channel] ?? {})) {
        if (transition === null) continue;
        const base = `${basePath}/nodes/${index}/${channel}/${pointer(outcome)}`;
        const target = transition.next ?? transition.rewind;
        if (target !== undefined) {
          const targetNode = nodes.get(target);
          const field = transition.next !== undefined ? 'next' : 'rewind';
          if (!targetNode) {
            issues.push(issue(
              'transition_target_missing', scope, routeId, node.id, `${base}/${field}`,
              `Узел «${target}» отсутствует`,
            ));
          } else if (targetNode.executor === 'status') {
            issues.push(issue(
              'status_target_invalid', scope, routeId, node.id, `${base}/${field}`,
              'Status не может быть целью перехода',
            ));
          }
        }

        if (transition.rewind !== undefined) {
          const from = order.indexOf(transition.rewind);
          const until = order.indexOf(node.id);
          const expected = from >= 0 && until >= from
            ? order.slice(from, until + 1) : [];
          const actual = transition.reset ?? [];
          if (expected.length === 0 || expected.length !== actual.length
            || expected.some((id) => !actual.includes(id))) {
            issues.push(issue(
              'rewind_reset_invalid', scope, routeId, node.id, `${base}/reset`,
              'Reset должен содержать весь участок от цели до текущего узла',
            ));
          }
          if (outcome === 'failed' && (node.retry?.productFailure ?? 0) > 0) {
            issues.push(issue(
              'product_failure_rewind', scope, routeId, node.id,
              `${basePath}/nodes/${index}/retry/productFailure`,
              'Повтор productFailure несовместим с возвратом failed',
            ));
          }
        }
      }
    }
  }
  return issues;
}

/**
 * Зеркалит статические отказы route runtime, которые schema=2 ещё допускает.
 */
function runtimeIssues(draft: RouteDraft): RouteEditorIssue[] {
  const issues: RouteEditorIssue[] = [];
  const machines: Array<{
    machine: DraftMachine;
    scope: 'route' | 'bootstrap';
    routeId: string | null;
    base: string;
  }> = [
    ...Object.entries(draft.routes).map(([routeId, bundle]) => ({
      machine: bundle.route,
      scope: 'route' as const,
      routeId,
      base: `/routes/${pointer(routeId)}/route`,
    })),
    { machine: draft.bootstrap, scope: 'bootstrap', routeId: null, base: '/bootstrap' },
  ];
  for (const { machine, scope, routeId, base } of machines) {
    const order = Object.values(machine.sequence).flat();
    const first = order.indexOf('instrument');
    const last = order.indexOf('proof');
    const instrument = machine.nodes.find((node) => node.id === 'instrument');
    const proof = machine.nodes.find((node) => node.id === 'proof');
    if (instrument || proof) {
      if (!instrument || !proof || first < 0 || last <= first
        || instrument.policy?.filesystem !== 'transactional-write'
        || proof.policy?.filesystem !== 'transactional-write') {
        issues.push(issue(
          'instrumentation_pair_invalid', scope, routeId, instrument?.id ?? proof?.id ?? null,
          `${base}/sequence`,
          'Для инструментации нужны transactional-write instrument → proof в порядке исполнения; '
            + 'scope задаётся при запуске.',
        ));
      } else {
        for (const [index, node] of machine.nodes.entries()) {
          if (node.executor === 'status') continue;
          const source = order.indexOf(node.id);
          for (const channel of ['on', 'onFailure'] as const) {
            for (const [outcome, transition] of Object.entries(node[channel] ?? {})) {
              if (!transition) continue;
              const target = transition.next ?? transition.rewind;
              const destination = target === undefined ? -1 : order.indexOf(target);
              if (destination <= first || destination > last) continue;
              if (source >= first && source < last) continue;
              issues.push(issue(
                'instrumentation_zone_unreachable', scope, routeId, node.id,
                `${base}/nodes/${index}/${channel}/${pointer(outcome)}`,
                'Переход попадает внутрь зоны instrument → proof без активной транзакции; '
                  + 'верните курсор на instrument либо за proof.',
              ));
            }
          }
        }
      }
    }
    for (const [index, node] of machine.nodes.entries()) {
      if (node.retry?.providerFailure.strategy === 'same-runner') {
        issues.push(issue(
          'retry_strategy_unsupported',
          scope,
          routeId,
          node.id,
          `${base}/nodes/${index}/retry/providerFailure/strategy`,
          'Стратегия same-runner не реализована движком; выберите runner-failover или none.',
        ));
      }
    }
    const terminalReachable = new Set<string>();
    const links = new Map<string, string[]>();
    let complete = true;
    for (const node of machine.nodes) {
      if (node.executor === 'status') continue;
      const targets: string[] = [];
      for (const channel of ['on', 'onFailure'] as const) {
        for (const transition of Object.values(node[channel] ?? {})) {
          if (transition === null) {
            complete = false;
            continue;
          }
          if (transition.stop !== undefined || transition.escalate !== undefined) {
            terminalReachable.add(node.id);
          }
          const target = transition.next ?? transition.rewind;
          if (target !== undefined) targets.push(target);
        }
      }
      links.set(node.id, targets);
    }
    if (complete) {
      let changed = true;
      while (changed) {
        changed = false;
        for (const [nodeId, targets] of links) {
          if (!terminalReachable.has(nodeId)
            && targets.some((target) => terminalReachable.has(target))) {
            terminalReachable.add(nodeId);
            changed = true;
          }
        }
      }
      const trapped = machine.nodes.find((node) => (
        node.executor !== 'status' && !terminalReachable.has(node.id)
      ));
      if (trapped) {
        const index = machine.nodes.indexOf(trapped);
        issues.push({
          ...issue(
            'runtime_limited_cycle', scope, routeId, trapped.id, `${base}/nodes/${index}`,
            'Из этого цикла нет stop/escalate; завершение возможно только по лимитам runtime.',
          ),
          severity: 'warning',
        });
      }
    }
  }
  return issues;
}

/**
 * Переводит адрес старого strict schema в JSON Pointer текущего черновика.
 * В отчёте всегда присутствует routeId/nodeId, даже если schema использует индекс.
 */
function schemaIssue(
  error: RoutesError,
  machine: DraftMachine,
  scope: 'route' | 'bootstrap',
  routeId: string | null,
  basePath: string,
): RouteEditorIssue {
  const rawPath = String(error.details.path ?? 'machine');
  if (rawPath.startsWith('prompts/') && error.message.includes('не используется')) {
    return issue(
      'prompt_unused', scope, routeId, null,
      `${basePath.replace(/\/route$/, '')}/prompts/${pointer(rawPath)}`,
      error.message,
    );
  }
  const nodeMatch = rawPath.match(/^machine\.nodes(?:\[(\d+)\]|\.([a-z0-9_-]+))/);
  const nodeId = nodeMatch?.[1] !== undefined
    ? machine.nodes[Number(nodeMatch[1])]?.id ?? null : nodeMatch?.[2] ?? null;
  const normalized = rawPath
    .replace(/^machine/, '')
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean)
    .map((part, index, parts) => (
      index === 1 && parts[0] === 'nodes' && !/^\d+$/.test(part)
        ? String(machine.nodes.findIndex((node) => node.id === part))
        : part
    ))
    .map(pointer)
    .join('/');
  return issue(
    'route_schema_invalid',
    scope,
    routeId,
    nodeId,
    `${basePath}${normalized ? `/${normalized}` : ''}`,
    error.message,
  );
}

/**
 * Проверяет каждый маршрут независимо и никогда не меняет черновик/current.
 * Проверка движком и возможностей добавится позже; null hash не даёт допуска.
 */
export function validateDraft(draft: RouteDraft): DraftValidationReport {
  validateDraftShape(draft);
  const projected = toRuntimeCatalogInput(draft);
  const issues = projected.ok ? [] : projected.issues.map((item) => promptOwner(draft, item));

  for (const [routeId, bundle] of Object.entries(draft.routes)) {
    const base = `/routes/${pointer(routeId)}/route`;
    issues.push(...transitionIssues(bundle.route, 'route', routeId, base));
    if (issues.some((item) => item.scope === 'route' && item.routeId === routeId)) continue;
    try {
      const files = validatePromptFiles(bundle.prompts, { prefix: 'prompts/' });
      validateRoute(bundle.route, { profile: draft.profile, routeId, promptFiles: files });
    } catch (error) {
      if (!(error instanceof RoutesError)) throw error;
      issues.push(schemaIssue(error, bundle.route, 'route', routeId, base));
    }
  }

  issues.push(...transitionIssues(draft.bootstrap, 'bootstrap', null, '/bootstrap'));
  if (!issues.some((item) => item.scope === 'bootstrap')) {
    try {
      const files = validatePromptFiles(draft.bootstrapPrompts, {
        prefix: 'bootstrap/prompts/',
      });
      validateBootstrap(draft.bootstrap, { profile: draft.profile, promptFiles: files });
    } catch (error) {
      if (!(error instanceof RoutesError)) throw error;
      issues.push(schemaIssue(error, draft.bootstrap, 'bootstrap', null, '/bootstrap'));
    }
  }
  issues.push(...runtimeIssues(draft));

  return {
    draftId: draft.id,
    draftRevision: draft.revision,
    capabilitiesHash: null,
    issues,
  };
}
