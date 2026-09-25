import type { DraftMachine } from './routeDefinition.ts';
import type { RouteDraft, RouteEditorIssue } from './routesEditorContracts.ts';

export interface ProjectedRouteNode {
  id: string;
  label: string;
  executor: string;
  phase: string | null;
  origin: {
    scope: 'route' | 'bootstrap';
    routeId: string | null;
    nodeId: string | null;
  };
  editable: boolean;
}

export interface ProjectedRouteEdge {
  id: string;
  source: string;
  target: string;
  channel: 'on' | 'onFailure' | 'emits';
  outcome: string;
  action: 'next' | 'rewind' | 'stop' | 'escalate' | 'emits';
  reset: string[];
  kind: 'execution' | 'emits';
}

export interface ProjectedRouteMachine {
  nodes: ProjectedRouteNode[];
  edges: ProjectedRouteEdge[];
  issues: RouteEditorIssue[];
}

export interface ProjectedRouteCatalog {
  bootstrap: ProjectedRouteMachine;
  routes: Record<string, ProjectedRouteMachine>;
  issues: RouteEditorIssue[];
}

export function projectRouteMachine(
  machine: DraftMachine,
  options: { scope: 'route' | 'bootstrap'; routeId?: string },
): ProjectedRouteMachine {
  const prefix = options.scope === 'bootstrap' ? 'b' : `r:${options.routeId}`;
  const nodes: ProjectedRouteNode[] = machine.nodes.map((node) => ({
    id: `${prefix}:${node.id}`,
    label: node.label ?? node.id,
    executor: node.executor,
    phase: node.phase,
    origin: {
      scope: options.scope,
      routeId: options.scope === 'bootstrap' ? null : options.routeId ?? null,
      nodeId: node.id,
    },
    editable: true,
  }));
  const edges: ProjectedRouteEdge[] = [];
  const issues: RouteEditorIssue[] = [];
  const synthetic = new Map<string, ProjectedRouteNode>();
  const byId = new Map(machine.nodes.map((node) => [node.id, node]));
  const routeId = options.scope === 'bootstrap' ? null : options.routeId ?? null;

  const syntheticNode = (id: string, label: string, executor: string) => {
    if (!synthetic.has(id)) {
      synthetic.set(id, {
        id,
        label,
        executor,
        phase: null,
        origin: {
          scope: options.scope,
          routeId: options.scope === 'bootstrap' ? null : options.routeId ?? null,
          nodeId: null,
        },
        editable: false,
      });
    }
  };

  const addIssue = (code: string, nodeId: string, path: string, message: string) => {
    issues.push({
      code,
      severity: 'error',
      scope: options.scope,
      routeId,
      nodeId,
      path,
      message,
    });
  };

  const targetId = (id: string, nodeId: string, path: string) => {
    const target = byId.get(id);
    if (target && target.executor !== 'status') {
      return `${prefix}:${id}`;
    }

    const missing = `${prefix}:missing:${id}`;
    syntheticNode(missing, `Неизвестная цель: ${id}`, 'missing');
    addIssue(
      target?.executor === 'status' ? 'transition_target_status' : 'transition_target_missing',
      nodeId,
      path,
      `Цель «${id}» не является исполняемым этапом`,
    );
    return missing;
  };

  machine.nodes.forEach((node, index) => {
    const nodePath = options.scope === 'bootstrap'
      ? `/bootstrap/nodes/${index}`
      : `/routes/${options.routeId}/route/nodes/${index}`;

    for (const emitted of node.emits ?? []) {
      edges.push({
        id: `${prefix}:${node.id}:emits:${emitted}`,
        source: `${prefix}:${node.id}`,
        target: `${prefix}:${emitted}`,
        channel: 'emits',
        outcome: emitted,
        action: 'emits',
        reset: [],
        kind: 'emits',
      });
    }

    for (const channel of ['on', 'onFailure'] as const) {
      for (const [outcome, transition] of Object.entries(node[channel] ?? {})) {
        const transitionPath = `${nodePath}/${channel}/${outcome}`;
        if (transition === null) {
          addIssue('transition_required', node.id, transitionPath, 'Выберите переход');
          continue;
        }

        const edgeId = `${prefix}:${node.id}:${channel}:${outcome}`;
        const source = `${prefix}:${node.id}`;
        const base = {
          id: edgeId,
          source,
          channel,
          outcome,
          reset: [] as string[],
          kind: 'execution' as const,
        };

        if (transition.next !== undefined) {
          edges.push({
            ...base,
            target: targetId(transition.next, node.id, `${transitionPath}/next`),
            action: 'next',
          });
        } else if (transition.rewind !== undefined) {
          edges.push({
            ...base,
            target: targetId(transition.rewind, node.id, `${transitionPath}/rewind`),
            action: 'rewind',
            reset: [...(transition.reset ?? [])],
          });
        } else if (transition.stop !== undefined) {
          const target = `${prefix}:stop:${transition.stop}`;
          syntheticNode(target, `Остановка: ${transition.stop}`, 'stop');
          edges.push({ ...base, target, action: 'stop' });
        } else if (transition.escalate !== undefined) {
          for (const routeId of transition.escalate.routes) {
            const target = `catalog:route:${routeId}`;
            syntheticNode(target, routeId, 'route-choice');
            edges.push({ ...base, id: `${edgeId}:${routeId}`, target, action: 'escalate' });
          }
        }
      }
    }
  });

  nodes.push(...[...synthetic.values()].sort((left, right) => (
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  )));

  return { nodes, edges, issues };
}

export function projectRouteCatalog(draft: RouteDraft): ProjectedRouteCatalog {
  const bootstrap = projectRouteMachine(draft.bootstrap, { scope: 'bootstrap' });
  const routes: Record<string, ProjectedRouteMachine> = {};

  for (const routeId of Object.keys(draft.routes).sort()) {
    const bundle = draft.routes[routeId];
    if (!bundle) {
      continue;
    }
    routes[routeId] = projectRouteMachine(bundle.route, {
      scope: 'route',
      routeId,
    });
  }

  return {
    bootstrap,
    routes,
    issues: [
      ...bootstrap.issues,
      ...Object.values(routes).flatMap((route) => route.issues),
    ],
  };
}
